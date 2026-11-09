/**
 * Application service: persistence + orchestration around the pure engine.
 * Every function takes tenantId first and every SQL statement filters on it.
 */
import type { Db } from '../db/database.js';
import { tx } from '../db/database.js';
import { reconcile, type EngineInvoice, type EngineTransaction, type MatchAssistant, type MatchProposal } from '../engine/index.js';
import { audit } from './audit.js';
import { parseAmountToMinor, toCsv } from './csv.js';
import { cleanImportRows, type TxRowInput } from './import-rows.js';
import { badRequest, conflict, notFound } from './errors.js';
import { newId, nowIso, sha256 } from './ids.js';

type Row = Record<string, any>;

// ------------------------------------------------------------------ tenants
export function createTenant(db: Db, name: string, apiKey: string, id = newId('ten')) {
  db.prepare('INSERT INTO tenants (id, name, api_key_hash, created_at) VALUES (?,?,?,?)').run(id, name, sha256(apiKey), nowIso());
  return { id, name };
}
export function tenantByApiKey(db: Db, apiKey: string) {
  return db.prepare('SELECT id, name FROM tenants WHERE api_key_hash = ?').get(sha256(apiKey)) as { id: string; name: string } | undefined;
}

// ------------------------------------------------------------------ invoices
export interface InvoiceInput {
  number: string;
  customerName: string;
  amount: string | number; // major units, e.g. "12500.00"
  currency: string;
  issueDate: string;
  dueDate: string;
  externalRef?: string | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function validateInvoice(i: InvoiceInput) {
  if (!i.number?.trim()) throw badRequest('number is required');
  if (!i.customerName?.trim()) throw badRequest('customerName is required');
  if (!/^[A-Z]{3}$/.test(i.currency)) throw badRequest('currency must be ISO 4217 (e.g. EGP)');
  if (!ISO.test(i.issueDate) || !ISO.test(i.dueDate)) throw badRequest('dates must be yyyy-mm-dd');
  const amountMinor = parseAmountToMinor(i.amount);
  if (amountMinor <= 0) throw badRequest('amount must be positive');
  return amountMinor;
}

const PAID_SQL = `COALESCE((SELECT SUM(a.amount_minor) FROM match_allocations a JOIN matches m ON m.id = a.match_id
                   WHERE a.invoice_id = i.id AND m.status = 'matched'), 0)`;

function mapInvoice(r: Row) {
  const paid = r.paid_minor as number;
  return {
    id: r.id,
    number: r.number,
    customerName: r.customer_name,
    amountMinor: r.amount_minor,
    paidMinor: paid,
    openAmountMinor: r.amount_minor - paid,
    currency: r.currency,
    issueDate: r.issue_date,
    dueDate: r.due_date,
    externalRef: r.external_ref,
    status: (paid <= 0 ? 'open' : paid >= r.amount_minor ? 'paid' : 'partially_paid') as 'open' | 'paid' | 'partially_paid',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listInvoices(db: Db, tenantId: string, status?: string) {
  const rows = db.prepare(`SELECT i.*, ${PAID_SQL} AS paid_minor FROM invoices i WHERE i.tenant_id = ? ORDER BY i.due_date, i.number`).all(tenantId) as Row[];
  const list = rows.map(mapInvoice);
  return status ? list.filter((i) => i.status === status) : list;
}

export function getInvoice(db: Db, tenantId: string, id: string) {
  const r = db.prepare(`SELECT i.*, ${PAID_SQL} AS paid_minor FROM invoices i WHERE i.tenant_id = ? AND i.id = ?`).get(tenantId, id) as Row | undefined;
  if (!r) throw notFound('invoice');
  return mapInvoice(r);
}

export function createInvoice(db: Db, tenantId: string, actor: string, input: InvoiceInput) {
  const amountMinor = validateInvoice(input);
  return tx(db, () => {
    const exists = db.prepare('SELECT 1 FROM invoices WHERE tenant_id = ? AND number = ?').get(tenantId, input.number);
    if (exists) throw conflict(`invoice ${input.number} already exists`);
    const id = newId('inv');
    const now = nowIso();
    db.prepare(
      `INSERT INTO invoices (id, tenant_id, number, customer_name, amount_minor, currency, issue_date, due_date, external_ref, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(id, tenantId, input.number.trim(), input.customerName.trim(), amountMinor, input.currency, input.issueDate, input.dueDate, input.externalRef ?? null, now, now);
    audit(db, { tenantId, actor, action: 'invoice.created', entityType: 'invoice', entityId: id, details: { number: input.number, amountMinor, currency: input.currency } });
    return getInvoice(db, tenantId, id);
  });
}

export function updateInvoice(db: Db, tenantId: string, actor: string, id: string, input: InvoiceInput) {
  const before = getInvoice(db, tenantId, id);
  const amountMinor = validateInvoice(input);
  if (before.paidMinor > 0 && (amountMinor < before.paidMinor || input.currency !== before.currency))
    throw conflict('invoice has confirmed allocations; amount/currency change would break them');
  return tx(db, () => {
    db.prepare(
      `UPDATE invoices SET number=?, customer_name=?, amount_minor=?, currency=?, issue_date=?, due_date=?, external_ref=?, updated_at=?
       WHERE tenant_id=? AND id=?`,
    ).run(input.number, input.customerName, amountMinor, input.currency, input.issueDate, input.dueDate, input.externalRef ?? null, nowIso(), tenantId, id);
    audit(db, { tenantId, actor, action: 'invoice.updated', entityType: 'invoice', entityId: id, details: { before, after: { ...input, amountMinor } } });
    return getInvoice(db, tenantId, id);
  });
}

export function deleteInvoice(db: Db, tenantId: string, actor: string, id: string) {
  const inv = getInvoice(db, tenantId, id);
  const used = db.prepare(`SELECT 1 FROM match_allocations a JOIN matches m ON m.id=a.match_id WHERE a.invoice_id=? AND m.status!='rejected'`).get(id);
  if (used) throw conflict('invoice is part of a match; reject the match first');
  tx(db, () => {
    db.prepare(`DELETE FROM match_allocations WHERE invoice_id = ? AND tenant_id = ?`).run(id, tenantId);
    db.prepare('DELETE FROM invoices WHERE tenant_id = ? AND id = ?').run(tenantId, id);
    audit(db, { tenantId, actor, action: 'invoice.deleted', entityType: 'invoice', entityId: id, details: { number: inv.number } });
  });
}

// ------------------------------------------------------------------ bank transactions
export { normalizeImportRows, type TxRowInput } from './import-rows.js';

export function importTransactions(
  db: Db,
  tenantId: string,
  actor: string,
  args: { rows: TxRowInput[]; rawContent: string; source: string; filename?: string; idempotencyKey?: string },
) {
  const importHash = args.idempotencyKey ? `key:${args.idempotencyKey}` : `sha256:${sha256(args.rawContent)}`;
  const prior = db.prepare('SELECT * FROM imports WHERE tenant_id = ? AND import_hash = ?').get(tenantId, importHash) as Row | undefined;
  if (prior) {
    return { importId: prior.id as string, replayed: true, rowCount: prior.row_count as number, inserted: 0, duplicates: prior.row_count as number, errors: [] as string[] };
  }
  const { clean: cleaned, errors } = cleanImportRows(args.rows);
  const clean = cleaned.map((r) => ({ ...r, fingerprint: sha256(r.fingerprintSource) }));
  if (errors.length) throw badRequest(`import rejected, nothing written: ${errors.slice(0, 5).join('; ')}`);

  return tx(db, () => {
    const importId = newId('imp');
    const ins = db.prepare(
      `INSERT OR IGNORE INTO bank_transactions (id, tenant_id, import_id, bank_account, bank_tx_id, booking_date, amount_minor, currency, counterparty, reference, description, fingerprint, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    db.prepare('INSERT INTO imports (id, tenant_id, import_hash, source, filename, row_count, inserted, duplicates, created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      importId, tenantId, importHash, args.source, args.filename ?? null, clean.length, 0, 0, nowIso(),
    );
    let inserted = 0;
    const now = nowIso();
    for (const r of clean) {
      const res = ins.run(newId('btx'), tenantId, importId, r.bankAccount, r.bankTxId || null, r.bookingDate, r.amountMinor, r.currency, r.counterparty, r.reference, r.description, r.fingerprint, now);
      inserted += Number(res.changes);
    }
    const duplicates = clean.length - inserted;
    db.prepare('UPDATE imports SET inserted = ?, duplicates = ? WHERE id = ?').run(inserted, duplicates, importId);
    audit(db, { tenantId, actor, action: 'transactions.imported', entityType: 'import', entityId: importId, details: { source: args.source, filename: args.filename, rowCount: clean.length, inserted, duplicates, importHash } });
    return { importId, replayed: false, rowCount: clean.length, inserted, duplicates, errors };
  });
}

function mapTx(r: Row) {
  return {
    id: r.id,
    bookingDate: r.booking_date,
    amountMinor: r.amount_minor,
    currency: r.currency,
    counterparty: r.counterparty,
    reference: r.reference,
    description: r.description,
    bankAccount: r.bank_account,
    bankTxId: r.bank_tx_id,
    importId: r.import_id,
    matchStatus: ((r.match_status as string | null) ?? 'unmatched') as 'matched' | 'suggested' | 'unmatched',
  };
}

const TX_STATUS_SQL = `(SELECT CASE WHEN SUM(m.status='matched') > 0 THEN 'matched' WHEN SUM(m.status='suggested') > 0 THEN 'suggested' END
   FROM match_allocations a JOIN matches m ON m.id = a.match_id WHERE a.transaction_id = t.id)`;

export function listTransactions(db: Db, tenantId: string, status?: string) {
  const rows = db.prepare(`SELECT t.*, ${TX_STATUS_SQL} AS match_status FROM bank_transactions t WHERE t.tenant_id = ? ORDER BY t.booking_date, t.id`).all(tenantId) as Row[];
  const list = rows.map(mapTx);
  return status ? list.filter((t) => t.matchStatus === status) : list;
}

// ------------------------------------------------------------------ reconciliation
const keyOf = (txIds: string[], invIds: string[]) => `${[...txIds].sort().join(',')}>${[...invIds].sort().join(',')}`;

export async function runReconciliation(db: Db, tenantId: string, actor: string, assistant?: MatchAssistant) {
  // 1. Snapshot inputs: only what is not already confirmed.
  const invoices: EngineInvoice[] = listInvoices(db, tenantId)
    .filter((i) => i.openAmountMinor > 0)
    .map((i) => ({ id: i.id, number: i.number, customerName: i.customerName, amountMinor: i.amountMinor, openAmountMinor: i.openAmountMinor, currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate }));
  const txs: EngineTransaction[] = listTransactions(db, tenantId)
    .filter((t) => t.matchStatus !== 'matched' && t.amountMinor > 0)
    .map((t) => ({ id: t.id, bookingDate: t.bookingDate, amountMinor: t.amountMinor, currency: t.currency, counterparty: t.counterparty, reference: t.reference, description: t.description }));
  const rejectedPairs = new Set(
    (db.prepare(`SELECT a.transaction_id || '|' || a.invoice_id AS k FROM match_allocations a JOIN matches m ON m.id=a.match_id WHERE m.tenant_id=? AND m.status='rejected'`).all(tenantId) as { k: string }[]).map((r) => r.k),
  );

  // 2. Pure engine (async only because of the optional assistant).
  const result = await reconcile(invoices, txs, { rejectedPairs }, assistant);

  // 3. Persist atomically. Pending suggestions are recomputed; identical ones keep their id (stable for reviewers).
  return tx(db, () => {
    const runId = newId('run');
    const pending = db.prepare(`SELECT m.id, GROUP_CONCAT(DISTINCT a.transaction_id) AS t, GROUP_CONCAT(DISTINCT a.invoice_id) AS i FROM matches m JOIN match_allocations a ON a.match_id=m.id WHERE m.tenant_id=? AND m.decision='pending' GROUP BY m.id`).all(tenantId) as Row[];
    const pendingByKey = new Map(pending.map((p) => [keyOf(String(p.t).split(','), String(p.i).split(',')), p.id as string]));
    const keep = new Set<string>();
    const stats = { autoMatched: 0, suggested: 0, kept: 0, superseded: 0, unmatchedTransactions: result.unmatchedTransactionIds.length, unmatchedInvoices: result.unmatchedInvoiceIds.length, byStage: {} as Record<string, number> };

    db.prepare('INSERT INTO reconciliation_runs (id, tenant_id, actor, assistant, stats_json, created_at) VALUES (?,?,?,?,?,?)').run(runId, tenantId, actor, assistant?.name ?? null, '{}', nowIso());
    for (const p of result.proposals) {
      stats.byStage[p.stage] = (stats.byStage[p.stage] ?? 0) + 1;
      const k = keyOf(p.transactionIds, p.invoiceIds);
      const existing = pendingByKey.get(k);
      if (existing && p.status === 'suggested') {
        keep.add(existing);
        stats.kept++;
        db.prepare('UPDATE matches SET confidence=?, reason=?, stage=? WHERE id=?').run(p.confidence, p.reason, p.stage, existing);
        continue;
      }
      const matchId = insertMatch(db, tenantId, runId, p);
      if (p.status === 'matched') {
        stats.autoMatched++;
        audit(db, { tenantId, actor: 'system:engine', action: 'match.auto_matched', entityType: 'match', entityId: matchId, details: { runId, stage: p.stage, confidence: p.confidence, reason: p.reason, allocations: p.allocations } });
      } else stats.suggested++;
    }
    for (const p of pending) {
      if (keep.has(p.id)) continue;
      db.prepare('DELETE FROM matches WHERE id = ? AND tenant_id = ?').run(p.id, tenantId);
      stats.superseded++;
    }
    db.prepare('UPDATE reconciliation_runs SET stats_json = ? WHERE id = ?').run(JSON.stringify(stats), runId);
    audit(db, { tenantId, actor, action: 'reconciliation.run', entityType: 'run', entityId: runId, details: { ...stats, assistant: assistant?.name ?? 'none' } });
    return { runId, ...stats };
  });
}

function insertMatch(db: Db, tenantId: string, runId: string, p: MatchProposal) {
  const id = newId('mat');
  db.prepare(
    `INSERT INTO matches (id, tenant_id, run_id, status, decision, stage, confidence, reason, currency, difference_minor, decided_by, decided_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, tenantId, runId, p.status, p.status === 'matched' ? 'auto' : 'pending', p.stage, p.confidence, p.reason, p.currency, p.differenceMinor, p.status === 'matched' ? 'system:engine' : null, p.status === 'matched' ? nowIso() : null, nowIso());
  const ins = db.prepare('INSERT INTO match_allocations (match_id, tenant_id, invoice_id, transaction_id, amount_minor) VALUES (?,?,?,?,?)');
  for (const a of p.allocations) ins.run(id, tenantId, a.invoiceId, a.transactionId, a.amountMinor);
  return id;
}

function loadMatches(db: Db, tenantId: string, where: string, args: (string | number)[]) {
  const ms = db.prepare(`SELECT * FROM matches WHERE tenant_id = ? ${where} ORDER BY CASE status WHEN 'suggested' THEN 0 WHEN 'matched' THEN 1 ELSE 2 END, confidence DESC, created_at`).all(tenantId, ...args) as Row[];
  const allocStmt = db.prepare(
    `SELECT a.*, i.number AS invoice_number, i.customer_name, i.amount_minor AS invoice_amount_minor, t.booking_date, t.amount_minor AS tx_amount_minor, t.counterparty, t.reference, t.bank_account
     FROM match_allocations a JOIN invoices i ON i.id=a.invoice_id JOIN bank_transactions t ON t.id=a.transaction_id WHERE a.match_id = ?`,
  );
  return ms.map((m) => {
    const allocs = allocStmt.all(m.id) as Row[];
    const txMap = new Map<string, Row>();
    const invMap = new Map<string, Row>();
    for (const a of allocs) {
      txMap.set(a.transaction_id, { id: a.transaction_id, bookingDate: a.booking_date, amountMinor: a.tx_amount_minor, counterparty: a.counterparty, reference: a.reference, bankAccount: a.bank_account });
      invMap.set(a.invoice_id, { id: a.invoice_id, number: a.invoice_number, customerName: a.customer_name, amountMinor: a.invoice_amount_minor });
    }
    return {
      id: m.id as string,
      runId: m.run_id,
      status: m.status as 'matched' | 'suggested' | 'rejected',
      decision: m.decision,
      stage: m.stage,
      confidence: m.confidence,
      reason: m.reason,
      currency: m.currency,
      differenceMinor: m.difference_minor,
      amountMinor: allocs.reduce((s, a) => s + (a.amount_minor as number), 0),
      decidedBy: m.decided_by,
      decidedAt: m.decided_at,
      note: m.note,
      createdAt: m.created_at,
      transactions: [...txMap.values()],
      invoices: [...invMap.values()],
      allocations: allocs.map((a) => ({ invoiceId: a.invoice_id, transactionId: a.transaction_id, amountMinor: a.amount_minor })),
    };
  });
}

export function listMatches(db: Db, tenantId: string, status?: string) {
  return status ? loadMatches(db, tenantId, 'AND status = ?', [status]) : loadMatches(db, tenantId, '', []);
}

export function getMatch(db: Db, tenantId: string, id: string) {
  const m = loadMatches(db, tenantId, 'AND id = ?', [id])[0];
  if (!m) throw notFound('match');
  return m;
}

export function decideMatch(db: Db, tenantId: string, actor: string, id: string, decision: 'accept' | 'reject', note?: string) {
  return tx(db, () => {
    const m = getMatch(db, tenantId, id);
    if (m.status !== 'suggested') throw conflict(`match is already ${m.status}`);
    if (decision === 'accept') {
      // Re-validate against current state: no double allocation of a transaction or over-allocation of an invoice.
      for (const a of m.allocations) {
        const txUsed = db.prepare(`SELECT 1 FROM match_allocations x JOIN matches y ON y.id=x.match_id WHERE x.transaction_id=? AND y.status='matched'`).get(a.transactionId);
        if (txUsed) throw conflict('a transaction in this suggestion was already matched elsewhere; re-run reconciliation');
      }
      for (const inv of m.invoices) {
        const cur = getInvoice(db, tenantId, inv.id as string);
        const alloc = m.allocations.filter((a) => a.invoiceId === inv.id).reduce((s, a) => s + a.amountMinor, 0);
        if (alloc > cur.openAmountMinor) throw conflict(`invoice ${cur.number} no longer has enough open balance`);
      }
    }
    const status = decision === 'accept' ? 'matched' : 'rejected';
    db.prepare('UPDATE matches SET status=?, decision=?, decided_by=?, decided_at=?, note=? WHERE id=? AND tenant_id=?').run(status, decision === 'accept' ? 'accepted' : 'rejected', actor, nowIso(), note ?? null, id, tenantId);
    audit(db, { tenantId, actor, action: decision === 'accept' ? 'match.accepted' : 'match.rejected', entityType: 'match', entityId: id, details: { stage: m.stage, confidence: m.confidence, reason: m.reason, note: note ?? null, allocations: m.allocations } });
    return getMatch(db, tenantId, id);
  });
}

// ------------------------------------------------------------------ summary & report
export function summary(db: Db, tenantId: string) {
  const matches = listMatches(db, tenantId);
  const txs = listTransactions(db, tenantId);
  const invoices = listInvoices(db, tenantId);
  const add = (o: Record<string, number>, cur: string, v: number) => ((o[cur] = (o[cur] ?? 0) + v), o);
  const bucket = () => ({ count: 0, amountByCurrency: {} as Record<string, number> });
  const out = { matched: bucket(), suggested: bucket(), unmatchedTransactions: bucket(), openInvoices: bucket(), rejected: bucket(), autoMatchRate: 0, totals: { transactions: txs.length, invoices: invoices.length } };
  for (const m of matches) {
    const b = out[m.status];
    b.count++;
    add(b.amountByCurrency, m.currency, m.amountMinor);
  }
  for (const t of txs.filter((t) => t.matchStatus === 'unmatched')) (out.unmatchedTransactions.count++, add(out.unmatchedTransactions.amountByCurrency, t.currency, t.amountMinor));
  for (const i of invoices.filter((i) => i.openAmountMinor > 0)) (out.openInvoices.count++, add(out.openInvoices.amountByCurrency, i.currency, i.openAmountMinor));
  const matchedTx = txs.filter((t) => t.matchStatus === 'matched').length;
  out.autoMatchRate = txs.length ? Math.round((matchedTx / txs.length) * 1000) / 10 : 0;
  return out;
}

const major = (minor: number) => (minor / 100).toFixed(2);

export function reportCsv(db: Db, tenantId: string) {
  const rows: (string | number | null)[][] = [
    ['match_id', 'status', 'decision', 'stage', 'confidence', 'currency', 'invoice_numbers', 'customers', 'bank_tx_ids', 'booking_dates', 'allocated_amount', 'difference', 'decided_by', 'decided_at', 'reason'],
  ];
  for (const m of listMatches(db, tenantId)) {
    rows.push([
      m.id, m.status, m.decision, m.stage, m.confidence, m.currency,
      m.invoices.map((i) => i.number).join(' | '),
      [...new Set(m.invoices.map((i) => i.customerName))].join(' | '),
      m.transactions.map((t) => t.id).join(' | '),
      m.transactions.map((t) => t.bookingDate).join(' | '),
      major(m.amountMinor), major(m.differenceMinor), m.decidedBy, m.decidedAt, m.reason,
    ]);
  }
  for (const t of listTransactions(db, tenantId, 'unmatched'))
    rows.push(['', 'unmatched_transaction', '', '', '', t.currency, '', t.counterparty, t.id, t.bookingDate, major(t.amountMinor), '', '', '', `${t.reference} ${t.description}`.trim()]);
  for (const i of listInvoices(db, tenantId).filter((i) => i.openAmountMinor > 0))
    rows.push(['', 'open_invoice', '', '', '', i.currency, i.number, i.customerName, '', i.dueDate, major(i.openAmountMinor), '', '', '', i.status]);
  return toCsv(rows);
}

// ------------------------------------------------------------------ demo reset (DEMO_MODE only)
export function purgeTenantData(db: Db, tenantId: string) {
  tx(db, () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('allow_audit_purge','yes')").run();
    for (const t of ['match_allocations', 'matches', 'reconciliation_runs', 'bank_transactions', 'imports', 'invoices', 'audit_log'])
      db.prepare(`DELETE FROM ${t} WHERE tenant_id = ?`).run(tenantId);
    db.prepare("DELETE FROM settings WHERE key = 'allow_audit_purge'").run();
  });
}
