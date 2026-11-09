/**
 * Static-demo backend. Runs the SAME matching engine and import helpers as the API
 * (imported from backend/src), with a per-tenant store in localStorage instead of SQLite.
 * It mirrors the API's semantics: idempotent imports, stable re-runs, rejected pairs never
 * re-proposed, accept re-validation, and a SHA-256 hash-chained audit log (Web Crypto).
 */
import { Injectable } from '@angular/core';
import { MockAssistant, reconcile, type Allocation, type EngineInvoice, type EngineTransaction } from '../../../../backend/src/engine/index';
import { parseAmountToMinor, toCsv } from '../../../../backend/src/services/csv';
import { cleanImportRows, normalizeImportRows } from '../../../../backend/src/services/import-rows';
import nileInvoices from '../../../../backend/sample-data/nile-foods.invoices.json';
import lotusInvoices from '../../../../backend/sample-data/lotus-textiles.invoices.json';
import nileCsv from '../../../../backend/sample-data/nile-foods.bank-feed-oct-2026.csv' with { loader: 'text' };
import lotusCsv from '../../../../backend/sample-data/lotus-textiles.bank-feed-oct-2026.csv' with { loader: 'text' };
import { DEMO_TENANTS, REVIEWER, currentApiKey } from '../api.service';
import { saveFile, type Backend } from '../backend';
import type { AuditEntry, ImportResult, Invoice, Match, RunResult, Summary, Transaction } from '../models';

interface InvRec { id: string; number: string; customerName: string; amountMinor: number; currency: string; issueDate: string; dueDate: string; externalRef: string | null; createdAt: string; updatedAt: string; }
interface TxRec { id: string; importId: string; bankAccount: string; bankTxId: string | null; bookingDate: string; amountMinor: number; currency: string; counterparty: string; reference: string; description: string; fingerprint: string; }
interface MatchRec { id: string; runId: string; status: 'matched' | 'suggested' | 'rejected'; decision: 'auto' | 'accepted' | 'rejected' | 'pending'; stage: Match['stage']; confidence: number; reason: string; currency: string; differenceMinor: number; decidedBy: string | null; decidedAt: string | null; note: string | null; createdAt: string; allocations: Allocation[]; }
interface State { v: 1; invoices: InvRec[]; txs: TxRec[]; imports: { id: string; hash: string; rowCount: number }[]; matches: MatchRec[]; audit: AuditEntry[]; }

const SAMPLES: Record<string, { invoices: typeof nileInvoices; csv: string; file: string }> = {
  ten_nilefoods: { invoices: nileInvoices, csv: nileCsv, file: 'nile-foods.bank-feed-oct-2026.csv' },
  ten_lotustextiles: { invoices: lotusInvoices, csv: lotusCsv, file: 'lotus-textiles.bank-feed-oct-2026.csv' },
};
const GENESIS = '0'.repeat(64);
const STORAGE = 'recon-poc-demo:v1:';
const ACTOR = `user:${REVIEWER}`;

const now = () => new Date().toISOString();
const newId = (p: string) => `${p}_${Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 56]).join('')}`;
async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
const chainInput = (prev: string, e: Omit<AuditEntry, 'hash' | 'seq'>) =>
  [prev, e.id, e.actor, e.action, e.entityType, e.entityId ?? '', JSON.stringify(e.details ?? {}), e.createdAt].join('|');
const major = (minor: number) => (minor / 100).toFixed(2);

class Conflict extends Error {}

@Injectable({ providedIn: 'root' })
export class BrowserBackend implements Backend {
  readonly mode = 'browser' as const;
  private states = new Map<string, State>();
  private queue: Promise<unknown> = Promise.resolve();

  private get tenantId() {
    return DEMO_TENANTS.find((t) => t.key === currentApiKey())!.id;
  }

  /** Serialise mutations (like a DB transaction) and persist after each one. */
  private mutate<T>(fn: (s: State) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const s = await this.state();
      const draft: State = structuredClone(s);
      try {
        const out = await fn(draft);
        this.states.set(this.tenantId, draft);
        localStorage.setItem(STORAGE + this.tenantId, JSON.stringify(draft));
        return out;
      } catch (e) {
        if (e instanceof Conflict) throw { error: { message: e.message } };
        throw e;
      }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async state(): Promise<State> {
    const id = this.tenantId;
    let s = this.states.get(id);
    if (s) return s;
    const raw = localStorage.getItem(STORAGE + id);
    if (raw) {
      try {
        s = JSON.parse(raw) as State;
        if (s.v === 1) return this.states.set(id, s), s;
      } catch { /* fall through and reseed */ }
    }
    s = await this.seed();
    this.states.set(id, s);
    localStorage.setItem(STORAGE + id, JSON.stringify(s));
    return s;
  }

  private async seed(): Promise<State> {
    const s: State = { v: 1, invoices: [], txs: [], imports: [], matches: [], audit: [] };
    const sample = SAMPLES[this.tenantId];
    await this.log(s, 'system:seed', 'demo.reset', 'tenant', this.tenantId, { note: 'sample data loaded (in-browser demo)' });
    for (const i of sample.invoices) {
      const rec: InvRec = { id: newId('inv'), number: i.number, customerName: i.customerName, amountMinor: parseAmountToMinor(i.amount), currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate, externalRef: i.externalRef ?? null, createdAt: now(), updatedAt: now() };
      s.invoices.push(rec);
      await this.log(s, 'system:seed', 'invoice.created', 'invoice', rec.id, { number: rec.number, amountMinor: rec.amountMinor, currency: rec.currency });
    }
    await this.doImport(s, 'system:seed', sample.csv, sample.file);
    return s;
  }

  private async log(s: State, actor: string, action: string, entityType: string, entityId: string | null, details: unknown) {
    const prev = s.audit.at(-1)?.hash ?? GENESIS;
    const e = { id: newId('aud'), actor, action, entityType, entityId, details: JSON.parse(JSON.stringify(details ?? {})), createdAt: now() };
    s.audit.push({ ...e, seq: s.audit.length + 1, hash: await sha256(chainInput(prev, e)) } as AuditEntry & { prevHash: string });
  }

  private async doImport(s: State, actor: string, csv: string, filename: string): Promise<ImportResult> {
    const hash = `sha256:${await sha256(csv)}`;
    const prior = s.imports.find((i) => i.hash === hash);
    if (prior) return { importId: prior.id, replayed: true, rowCount: prior.rowCount, inserted: 0, duplicates: prior.rowCount };
    let rows;
    try {
      rows = normalizeImportRows({ csv });
    } catch (e) {
      throw new Conflict((e as Error).message);
    }
    const { clean, errors } = cleanImportRows(rows);
    if (!clean.length) throw new Conflict('no rows found');
    if (errors.length) throw new Conflict(`import rejected, nothing written: ${errors.slice(0, 5).join('; ')}`);
    const importId = newId('imp');
    const seen = new Set(s.txs.map((t) => t.fingerprint));
    let inserted = 0;
    for (const r of clean) {
      const fingerprint = await sha256(r.fingerprintSource);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      s.txs.push({ id: newId('btx'), importId, bankAccount: r.bankAccount, bankTxId: r.bankTxId || null, bookingDate: r.bookingDate, amountMinor: r.amountMinor, currency: r.currency, counterparty: r.counterparty, reference: r.reference, description: r.description, fingerprint });
      inserted++;
    }
    s.imports.push({ id: importId, hash, rowCount: clean.length });
    const res = { importId, replayed: false, rowCount: clean.length, inserted, duplicates: clean.length - inserted };
    await this.log(s, actor, 'transactions.imported', 'import', importId, { source: 'file-upload', filename, ...res });
    return res;
  }

  // ------------------------------------------------------------- derived views (same rules as the SQL views)
  private paid(s: State, invId: string) {
    return s.matches.filter((m) => m.status === 'matched').flatMap((m) => m.allocations).filter((a) => a.invoiceId === invId).reduce((x, a) => x + a.amountMinor, 0);
  }
  private invView(s: State, i: InvRec): Invoice {
    const paid = this.paid(s, i.id);
    return { ...i, paidMinor: paid, openAmountMinor: i.amountMinor - paid, status: paid <= 0 ? 'open' : paid >= i.amountMinor ? 'paid' : 'partially_paid' };
  }
  private txStatus(s: State, txId: string): Transaction['matchStatus'] {
    const ms = s.matches.filter((m) => m.allocations.some((a) => a.transactionId === txId));
    return ms.some((m) => m.status === 'matched') ? 'matched' : ms.some((m) => m.status === 'suggested') ? 'suggested' : 'unmatched';
  }
  private txView(s: State, t: TxRec): Transaction {
    return { ...t, matchStatus: this.txStatus(s, t.id) };
  }
  private matchView(s: State, m: MatchRec): Match {
    const txIds = [...new Set(m.allocations.map((a) => a.transactionId))];
    const invIds = [...new Set(m.allocations.map((a) => a.invoiceId))];
    return {
      ...m,
      amountMinor: m.allocations.reduce((x, a) => x + a.amountMinor, 0),
      transactions: txIds.map((id) => s.txs.find((t) => t.id === id)!).map((t) => ({ id: t.id, bookingDate: t.bookingDate, amountMinor: t.amountMinor, counterparty: t.counterparty, reference: t.reference, bankAccount: t.bankAccount })),
      invoices: invIds.map((id) => s.invoices.find((i) => i.id === id)!).map((i) => ({ id: i.id, number: i.number, customerName: i.customerName, amountMinor: i.amountMinor })),
    };
  }
  private sortedMatches(s: State) {
    const rank = { suggested: 0, matched: 1, rejected: 2 } as const;
    return [...s.matches].sort((a, b) => rank[a.status] - rank[b.status] || b.confidence - a.confidence || a.createdAt.localeCompare(b.createdAt));
  }

  // ------------------------------------------------------------- Backend API
  async summary(): Promise<Summary> {
    const s = await this.state();
    const bucket = () => ({ count: 0, amountByCurrency: {} as Record<string, number> });
    const add = (b: ReturnType<typeof bucket>, c: string, v: number) => (b.count++, (b.amountByCurrency[c] = (b.amountByCurrency[c] ?? 0) + v));
    const out = { matched: bucket(), suggested: bucket(), rejected: bucket(), unmatchedTransactions: bucket(), openInvoices: bucket(), autoMatchRate: 0, totals: { transactions: s.txs.length, invoices: s.invoices.length } };
    for (const m of s.matches) add(out[m.status], m.currency, m.allocations.reduce((x, a) => x + a.amountMinor, 0));
    let matchedTx = 0;
    for (const t of s.txs) {
      const st = this.txStatus(s, t.id);
      if (st === 'unmatched') add(out.unmatchedTransactions, t.currency, t.amountMinor);
      if (st === 'matched') matchedTx++;
    }
    for (const i of s.invoices.map((i) => this.invView(s, i))) if (i.openAmountMinor > 0) add(out.openInvoices, i.currency, i.openAmountMinor);
    out.autoMatchRate = s.txs.length ? Math.round((matchedTx / s.txs.length) * 1000) / 10 : 0;
    return out;
  }
  async matches(status?: string) {
    const s = await this.state();
    return this.sortedMatches(s).filter((m) => !status || m.status === status).map((m) => this.matchView(s, m));
  }
  async transactions(status?: string) {
    const s = await this.state();
    return [...s.txs].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate)).map((t) => this.txView(s, t)).filter((t) => !status || t.matchStatus === status);
  }
  async invoices() {
    const s = await this.state();
    return [...s.invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number)).map((i) => this.invView(s, i));
  }
  async audit(limit = 200) {
    const s = await this.state();
    return [...s.audit].reverse().slice(0, limit);
  }
  async verifyAudit() {
    const s = await this.state();
    let prev = GENESIS;
    for (const e of s.audit) {
      if ((await sha256(chainInput(prev, e))) !== e.hash) return { valid: false, entries: s.audit.length };
      prev = e.hash;
    }
    return { valid: true, entries: s.audit.length, headHash: prev };
  }

  run(): Promise<RunResult> {
    return this.mutate(async (s) => {
      const invoices: EngineInvoice[] = s.invoices.map((i) => this.invView(s, i)).filter((i) => i.openAmountMinor > 0)
        .map((i) => ({ id: i.id, number: i.number, customerName: i.customerName, amountMinor: i.amountMinor, openAmountMinor: i.openAmountMinor, currency: i.currency, issueDate: i.issueDate, dueDate: i.dueDate }));
      const txs: EngineTransaction[] = s.txs.filter((t) => this.txStatus(s, t.id) !== 'matched' && t.amountMinor > 0)
        .map((t) => ({ id: t.id, bookingDate: t.bookingDate, amountMinor: t.amountMinor, currency: t.currency, counterparty: t.counterparty, reference: t.reference, description: t.description }));
      const rejectedPairs = new Set(s.matches.filter((m) => m.status === 'rejected').flatMap((m) => m.allocations.map((a) => `${a.transactionId}|${a.invoiceId}`)));
      const assistant = new MockAssistant();
      const result = await reconcile(invoices, txs, { rejectedPairs }, assistant);

      const key = (a: Allocation[]) => `${[...new Set(a.map((x) => x.transactionId))].sort()}>${[...new Set(a.map((x) => x.invoiceId))].sort()}`;
      const pending = s.matches.filter((m) => m.decision === 'pending');
      const byKey = new Map(pending.map((m) => [key(m.allocations), m]));
      const keep = new Set<string>();
      const runId = newId('run');
      const stats = { runId, autoMatched: 0, suggested: 0, kept: 0, superseded: 0, unmatchedTransactions: result.unmatchedTransactionIds.length, unmatchedInvoices: result.unmatchedInvoiceIds.length, byStage: {} as Record<string, number> };
      for (const p of result.proposals) {
        stats.byStage[p.stage] = (stats.byStage[p.stage] ?? 0) + 1;
        const existing = byKey.get(key(p.allocations));
        if (existing && p.status === 'suggested') {
          keep.add(existing.id);
          stats.kept++;
          Object.assign(existing, { confidence: p.confidence, reason: p.reason, stage: p.stage });
          continue;
        }
        const auto = p.status === 'matched';
        const m: MatchRec = { id: newId('mat'), runId, status: p.status, decision: auto ? 'auto' : 'pending', stage: p.stage, confidence: p.confidence, reason: p.reason, currency: p.currency, differenceMinor: p.differenceMinor, decidedBy: auto ? 'system:engine' : null, decidedAt: auto ? now() : null, note: null, createdAt: now(), allocations: p.allocations };
        s.matches.push(m);
        if (auto) {
          stats.autoMatched++;
          await this.log(s, 'system:engine', 'match.auto_matched', 'match', m.id, { runId, stage: p.stage, confidence: p.confidence, reason: p.reason, allocations: p.allocations });
        } else stats.suggested++;
      }
      const drop = new Set(pending.filter((m) => !keep.has(m.id)).map((m) => m.id));
      stats.superseded = drop.size;
      s.matches = s.matches.filter((m) => !drop.has(m.id));
      await this.log(s, ACTOR, 'reconciliation.run', 'run', runId, { ...stats, assistant: assistant.name });
      return stats;
    });
  }

  private decide(id: string, decision: 'accept' | 'reject', note?: string): Promise<Match> {
    return this.mutate(async (s) => {
      const m = s.matches.find((x) => x.id === id);
      if (!m) throw new Conflict('match not found');
      if (m.status !== 'suggested') throw new Conflict(`match is already ${m.status}`);
      if (decision === 'accept') {
        for (const a of m.allocations)
          if (this.txStatus(s, a.transactionId) === 'matched') throw new Conflict('a transaction in this suggestion was already matched elsewhere; re-run reconciliation');
        for (const invId of new Set(m.allocations.map((a) => a.invoiceId))) {
          const inv = this.invView(s, s.invoices.find((i) => i.id === invId)!);
          const alloc = m.allocations.filter((a) => a.invoiceId === invId).reduce((x, a) => x + a.amountMinor, 0);
          if (alloc > inv.openAmountMinor) throw new Conflict(`invoice ${inv.number} no longer has enough open balance`);
        }
      }
      Object.assign(m, { status: decision === 'accept' ? 'matched' : 'rejected', decision: decision === 'accept' ? 'accepted' : 'rejected', decidedBy: ACTOR, decidedAt: now(), note: note ?? null });
      await this.log(s, ACTOR, decision === 'accept' ? 'match.accepted' : 'match.rejected', 'match', id, { stage: m.stage, confidence: m.confidence, reason: m.reason, note: note ?? null, allocations: m.allocations });
      return this.matchView(s, m);
    });
  }
  accept(id: string, note?: string) { return this.decide(id, 'accept', note); }
  reject(id: string, note?: string) { return this.decide(id, 'reject', note); }

  importCsv(csv: string, filename: string) {
    return this.mutate((s) => this.doImport(s, ACTOR, csv, filename));
  }

  async resetDemo() {
    return this.mutate(async (s) => {
      Object.assign(s, await this.seed());
      return { invoices: s.invoices.length, transactions: s.txs.length };
    });
  }

  async downloadReport() {
    const s = await this.state();
    const rows: (string | number | null)[][] = [['match_id', 'status', 'decision', 'stage', 'confidence', 'currency', 'invoice_numbers', 'customers', 'bank_tx_ids', 'booking_dates', 'allocated_amount', 'difference', 'decided_by', 'decided_at', 'reason']];
    for (const m of this.sortedMatches(s).map((x) => this.matchView(s, x)))
      rows.push([m.id, m.status, m.decision, m.stage, m.confidence, m.currency, m.invoices.map((i) => i.number).join(' | '), [...new Set(m.invoices.map((i) => i.customerName))].join(' | '), m.transactions.map((t) => t.id).join(' | '), m.transactions.map((t) => t.bookingDate).join(' | '), major(m.amountMinor), major(m.differenceMinor), m.decidedBy, m.decidedAt, m.reason]);
    for (const t of await this.transactions('unmatched'))
      rows.push(['', 'unmatched_transaction', '', '', '', t.currency, '', t.counterparty, t.id, t.bookingDate, major(t.amountMinor), '', '', '', `${t.reference} ${t.description}`.trim()]);
    for (const i of (await this.invoices()).filter((i) => i.openAmountMinor > 0))
      rows.push(['', 'open_invoice', '', '', '', i.currency, i.number, i.customerName, '', i.dueDate, major(i.openAmountMinor), '', '', '', i.status]);
    saveFile(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }), `reconciliation-${new Date().toISOString().slice(0, 10)}.csv`);
  }
}
