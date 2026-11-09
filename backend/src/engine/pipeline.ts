/**
 * Reconciliation pipeline.
 *
 *   (1) exact    reference contains invoice number(s) AND amount equals the open amount
 *   (2) fuzzy    amount within tolerance + date window + counterparty / reference similarity
 *   (3) partial  strong reference evidence but the payment covers only part of the invoice
 *       split    one payment -> several invoices, or several payments -> one invoice (subset sum)
 *   (4) assist   optional MatchAssistant (LLM) looks at leftovers only; always "suggested"
 *
 * Each stage only sees what earlier stages left over, so cheap & certain rules run first
 * and the expensive / uncertain ones only touch the long tail.
 */
import { daysBetween, formatMinor, toleranceFor } from './money.js';
import { editSimilarity, nameSimilarity, normalizeRef, refTokens } from './text.js';
import {
  DEFAULT_OPTIONS,
  type EngineInvoice,
  type EngineOptions,
  type EngineResult,
  type EngineTransaction,
  type MatchAssistant,
  type MatchProposal,
} from './types.js';

const pct = (x: number) => `${Math.round(x * 100)}%`;
const round3 = (x: number) => Math.round(x * 1000) / 1000;

interface Ctx {
  opts: EngineOptions;
  invoices: EngineInvoice[];
  txs: EngineTransaction[];
  open: Map<string, number>;
  usedTx: Set<string>;
  touchedInv: Set<string>;
  proposals: MatchProposal[];
}

function rejected(ctx: Ctx, txId: string, invId: string) {
  return ctx.opts.rejectedPairs.has(`${txId}|${invId}`);
}

function openInvoices(ctx: Ctx, currency: string) {
  return ctx.invoices.filter((i) => i.currency === currency && (ctx.open.get(i.id) ?? 0) > 0);
}

function freeTxs(ctx: Ctx) {
  return ctx.txs.filter((t) => !ctx.usedTx.has(t.id) && t.amountMinor > 0);
}

/** Inside [issueDate - earlyPaymentDays, dueDate + dateWindowDays] ? returns days late (<=0 = on time) or null. */
function dateFit(ctx: Ctx, tx: EngineTransaction, inv: EngineInvoice): number | null {
  if (daysBetween(inv.issueDate, tx.bookingDate) < -ctx.opts.earlyPaymentDays) return null;
  const late = daysBetween(inv.dueDate, tx.bookingDate);
  return late > ctx.opts.dateWindowDays ? null : late;
}

/** Best similarity between any reference-looking token in the payment text and the invoice number. */
export function referenceScore(tx: EngineTransaction, invoiceNumber: string): { score: number; token?: string } {
  const target = normalizeRef(invoiceNumber);
  let best = { score: 0, token: undefined as string | undefined };
  for (const tok of refTokens(`${tx.reference} ${tx.description}`)) {
    let s = editSimilarity(tok, target);
    // "Payment for 0142" -> suffix of INV-2026-0142
    if (s < 0.9 && tok.length >= 4 && /^\d+$/.test(tok) && target.endsWith(tok)) s = 0.9;
    if (s > best.score) best = { score: s, token: tok };
  }
  return best.score >= 0.7 ? best : { score: 0 };
}

function commit(ctx: Ctx, p: MatchProposal) {
  ctx.proposals.push(p);
  for (const t of p.transactionIds) ctx.usedTx.add(t);
  for (const a of p.allocations) {
    ctx.open.set(a.invoiceId, (ctx.open.get(a.invoiceId) ?? 0) - a.amountMinor);
    ctx.touchedInv.add(a.invoiceId);
  }
}

function lateText(late: number) {
  return late <= 0 ? 'paid on/before due date' : `paid ${late} day(s) after due date`;
}

function diffText(diff: number, currency: string) {
  if (diff === 0) return 'amount matches exactly';
  return diff < 0
    ? `short by ${formatMinor(-diff, currency)} (within tolerance, likely bank/transfer fee)`
    : `over by ${formatMinor(diff, currency)} (within tolerance)`;
}

// ---------------------------------------------------------------- (1) exact
function exactStage(ctx: Ctx) {
  for (const tx of freeTxs(ctx)) {
    const tokens = new Set(refTokens(`${tx.reference} ${tx.description}`));
    const hits = openInvoices(ctx, tx.currency).filter(
      (inv) => tokens.has(normalizeRef(inv.number)) && !rejected(ctx, tx.id, inv.id),
    );
    if (!hits.length) continue;
    const sum = hits.reduce((s, i) => s + (ctx.open.get(i.id) ?? 0), 0);
    if (sum !== tx.amountMinor) continue;
    commit(ctx, {
      stage: 'exact',
      status: 'matched',
      confidence: hits.length === 1 ? 1 : 0.98,
      reason:
        hits.length === 1
          ? `Reference contains invoice number ${hits[0].number} and amount ${formatMinor(tx.amountMinor, tx.currency)} matches exactly.`
          : `Reference lists ${hits.map((h) => h.number).join(', ')}; their open amounts sum exactly to ${formatMinor(tx.amountMinor, tx.currency)}.`,
      invoiceIds: hits.map((h) => h.id),
      transactionIds: [tx.id],
      allocations: hits.map((h) => ({ invoiceId: h.id, transactionId: tx.id, amountMinor: ctx.open.get(h.id)! })),
      differenceMinor: 0,
      currency: tx.currency,
    });
  }
}

// ---------------------------------------------------------------- (2) fuzzy
interface Candidate {
  tx: EngineTransaction;
  inv: EngineInvoice;
  confidence: number;
  diff: number;
  parts: string[];
}

function fuzzyStage(ctx: Ctx) {
  const { opts } = ctx;
  const cands: Candidate[] = [];
  for (const tx of freeTxs(ctx)) {
    for (const inv of openInvoices(ctx, tx.currency)) {
      if (rejected(ctx, tx.id, inv.id)) continue;
      const open = ctx.open.get(inv.id)!;
      const tol = toleranceFor(open, opts.amountTolerancePct, opts.amountToleranceAbsMinor);
      const diff = tx.amountMinor - open;
      if (Math.abs(diff) > tol) continue;
      const late = dateFit(ctx, tx, inv);
      if (late === null) continue;
      const ref = referenceScore(tx, inv.number);
      const name = nameSimilarity(tx.counterparty, inv.customerName);
      if (ref.score < 0.7 && name < opts.nameSimilarityThreshold) continue;

      const amountScore = 1 - (0.3 * Math.abs(diff)) / tol;
      const dateScore = late <= 0 ? 1 : Math.max(0.5, 1 - (late / opts.dateWindowDays) * 0.5);
      const confidence = round3(0.35 * amountScore + 0.1 * dateScore + 0.3 * ref.score + 0.25 * name);
      if (confidence < opts.suggestThreshold) continue;

      const parts = [diffText(diff, tx.currency) + ` (${formatMinor(tx.amountMinor, tx.currency)} vs invoice ${formatMinor(open, inv.currency)})`];
      if (ref.score === 1) parts.push(`reference contains ${inv.number}`);
      else if (ref.score > 0 && /^\d+$/.test(ref.token ?? '')) parts.push(`reference '${ref.token}' is the short form of ${inv.number}`);
      else if (ref.score > 0) parts.push(`reference '${ref.token}' ≈ ${inv.number} (${pct(ref.score)}, likely typo)`);
      else parts.push('no invoice number in reference');
      parts.push(`counterparty '${tx.counterparty}' ≈ '${inv.customerName}' (${pct(name)})`);
      parts.push(lateText(late));
      cands.push({ tx, inv, confidence, diff, parts });
    }
  }

  cands.sort((a, b) => b.confidence - a.confidence);
  const takenTx = new Set<string>();
  const takenInv = new Set<string>();
  for (const c of cands) {
    if (takenTx.has(c.tx.id) || takenInv.has(c.inv.id)) continue;
    const rivals = cands.filter(
      (o) =>
        o !== c &&
        (o.tx.id === c.tx.id || o.inv.id === c.inv.id) &&
        !takenTx.has(o.tx.id) &&
        !takenInv.has(o.inv.id) &&
        c.confidence - o.confidence < 0.05,
    );
    takenTx.add(c.tx.id);
    takenInv.add(c.inv.id);
    const ambiguous = rivals.length > 0;
    const parts = [...c.parts];
    if (ambiguous) parts.push(`ambiguous: ${rivals.length} other candidate(s) within 5 points, needs review`);
    commit(ctx, {
      stage: 'fuzzy',
      status: c.confidence >= opts.autoMatchThreshold && !ambiguous ? 'matched' : 'suggested',
      confidence: c.confidence,
      reason: capitalize(parts.join('; ')) + '.',
      invoiceIds: [c.inv.id],
      transactionIds: [c.tx.id],
      allocations: [{ invoiceId: c.inv.id, transactionId: c.tx.id, amountMinor: ctx.open.get(c.inv.id)! }],
      differenceMinor: c.diff,
      currency: c.tx.currency,
    });
  }
}

// ---------------------------------------------------------------- (3a) partial
function partialStage(ctx: Ctx) {
  const { opts } = ctx;
  for (const tx of freeTxs(ctx)) {
    let best: { inv: EngineInvoice; conf: number; ref: number; token?: string; name: number; late: number } | null = null;
    for (const inv of openInvoices(ctx, tx.currency)) {
      if (rejected(ctx, tx.id, inv.id)) continue;
      const open = ctx.open.get(inv.id)!;
      const tol = toleranceFor(open, opts.amountTolerancePct, opts.amountToleranceAbsMinor);
      if (tx.amountMinor > open + tol) continue;
      const late = dateFit(ctx, tx, inv);
      if (late === null) continue;
      const ref = referenceScore(tx, inv.number);
      if (ref.score < 0.85) continue;
      const name = nameSimilarity(tx.counterparty, inv.customerName);
      const conf = round3(Math.min(0.89, 0.45 + 0.35 * ref.score + 0.1 * name));
      if (!best || conf > best.conf) best = { inv, conf, ref: ref.score, token: ref.token, name, late };
    }
    if (!best) continue;
    const open = ctx.open.get(best.inv.id)!;
    const tol = toleranceFor(open, opts.amountTolerancePct, opts.amountToleranceAbsMinor);
    if (Math.abs(tx.amountMinor - open) <= tol) {
      // closes the remaining balance of an invoice that was already partially paid
      commit(ctx, {
        stage: 'partial',
        status: 'suggested',
        confidence: best.conf,
        reason:
          `Final instalment: reference ${best.ref === 1 ? `contains ${best.inv.number}` : `'${best.token}' ≈ ${best.inv.number} (${pct(best.ref)})`}; ` +
          `${formatMinor(tx.amountMinor, tx.currency)} settles the remaining ${formatMinor(open, tx.currency)} after earlier partial payment(s); ${diffText(tx.amountMinor - open, tx.currency)}.`,
        invoiceIds: [best.inv.id],
        transactionIds: [tx.id],
        allocations: [{ invoiceId: best.inv.id, transactionId: tx.id, amountMinor: open }],
        differenceMinor: tx.amountMinor - open,
        currency: tx.currency,
      });
      continue;
    }
    commit(ctx, {
      stage: 'partial',
      status: 'suggested',
      confidence: best.conf,
      reason:
        `Partial payment: reference ${best.ref === 1 ? `contains ${best.inv.number}` : `'${best.token}' ≈ ${best.inv.number} (${pct(best.ref)})`}; ` +
        `${formatMinor(tx.amountMinor, tx.currency)} of ${formatMinor(open, tx.currency)} open, ` +
        `${formatMinor(open - tx.amountMinor, tx.currency)} would remain outstanding; counterparty similarity ${pct(best.name)}.`,
      invoiceIds: [best.inv.id],
      transactionIds: [tx.id],
      allocations: [{ invoiceId: best.inv.id, transactionId: tx.id, amountMinor: tx.amountMinor }],
      differenceMinor: 0,
      currency: tx.currency,
    });
  }
}

// ---------------------------------------------------------------- (3b) split
function* combinations<T>(items: T[], min: number, max: number): Generator<T[]> {
  const n = items.length;
  function* rec(start: number, acc: T[]): Generator<T[]> {
    if (acc.length >= min) yield acc;
    if (acc.length === max) return;
    for (let i = start; i < n; i++) yield* rec(i + 1, [...acc, items[i]]);
  }
  yield* rec(0, []);
}

function bestSubset<T>(items: T[], value: (t: T) => number, target: number, tol: number, maxSize: number) {
  let best: { set: T[]; diff: number } | null = null;
  for (const set of combinations(items.slice(0, 12), 2, maxSize)) {
    const diff = set.reduce((s, x) => s + value(x), 0) - target;
    if (Math.abs(diff) > tol) continue;
    if (!best || Math.abs(diff) < Math.abs(best.diff) || (Math.abs(diff) === Math.abs(best.diff) && set.length < best.set.length))
      best = { set, diff };
  }
  return best;
}

function splitStage(ctx: Ctx) {
  const { opts } = ctx;
  // one payment -> many invoices (customer pays several invoices in one transfer)
  for (const tx of freeTxs(ctx)) {
    const tol = toleranceFor(tx.amountMinor, opts.amountTolerancePct, opts.amountToleranceAbsMinor);
    const pool = openInvoices(ctx, tx.currency)
      .filter((inv) => !rejected(ctx, tx.id, inv.id) && dateFit(ctx, tx, inv) !== null)
      .map((inv) => ({ inv, name: nameSimilarity(tx.counterparty, inv.customerName) }))
      .filter((x) => x.name >= opts.nameSimilarityThreshold && ctx.open.get(x.inv.id)! <= tx.amountMinor + tol)
      .sort((a, b) => a.inv.dueDate.localeCompare(b.inv.dueDate));
    if (pool.length < 2) continue;
    const best = bestSubset(pool, (x) => ctx.open.get(x.inv.id)!, tx.amountMinor, tol, opts.maxSplitSize);
    if (!best) continue;
    const diff = -best.diff; // tx - sum(invoices)
    const avgName = best.set.reduce((s, x) => s + x.name, 0) / best.set.length;
    commit(ctx, {
      stage: 'split',
      status: 'suggested',
      confidence: round3(Math.min(0.89, 0.55 + 0.25 * avgName + (diff === 0 ? 0.1 : 0.05))),
      reason:
        `One payment of ${formatMinor(tx.amountMinor, tx.currency)} covers ${best.set.length} invoices ` +
        `(${best.set.map((x) => x.inv.number).join(' + ')}); ${diffText(diff, tx.currency)}; ` +
        `counterparty similarity ${pct(avgName)}.`,
      invoiceIds: best.set.map((x) => x.inv.id),
      transactionIds: [tx.id],
      allocations: best.set.map((x) => ({ invoiceId: x.inv.id, transactionId: tx.id, amountMinor: ctx.open.get(x.inv.id)! })),
      differenceMinor: diff,
      currency: tx.currency,
    });
  }

  // many payments -> one invoice (instalments / several transfers)
  for (const inv of ctx.invoices.filter((i) => (ctx.open.get(i.id) ?? 0) > 0)) {
    const open = ctx.open.get(inv.id)!;
    const tol = toleranceFor(open, opts.amountTolerancePct, opts.amountToleranceAbsMinor);
    const pool = freeTxs(ctx)
      .filter((tx) => tx.currency === inv.currency && tx.amountMinor < open && !rejected(ctx, tx.id, inv.id) && dateFit(ctx, tx, inv) !== null)
      .map((tx) => ({ tx, name: nameSimilarity(tx.counterparty, inv.customerName) }))
      .filter((x) => x.name >= opts.nameSimilarityThreshold)
      .sort((a, b) => a.tx.bookingDate.localeCompare(b.tx.bookingDate));
    if (pool.length < 2) continue;
    const best = bestSubset(pool, (x) => x.tx.amountMinor, open, tol, opts.maxSplitSize);
    if (!best) continue;
    const avgName = best.set.reduce((s, x) => s + x.name, 0) / best.set.length;
    // allocate each payment fully; the last one absorbs the (fee) difference so the invoice closes.
    let remaining = open;
    const allocations = best.set.map((x, i) => {
      const amt = i === best.set.length - 1 ? remaining : x.tx.amountMinor;
      remaining -= amt;
      return { invoiceId: inv.id, transactionId: x.tx.id, amountMinor: amt };
    });
    commit(ctx, {
      stage: 'split',
      status: 'suggested',
      confidence: round3(Math.min(0.89, 0.55 + 0.25 * avgName + (best.diff === 0 ? 0.1 : 0.05))),
      reason:
        `${best.set.length} payments (${best.set.map((x) => formatMinor(x.tx.amountMinor, x.tx.currency)).join(' + ')}) ` +
        `settle invoice ${inv.number} (${formatMinor(open, inv.currency)}); ${diffText(best.diff, inv.currency)}; ` +
        `counterparty similarity ${pct(avgName)}.`,
      invoiceIds: [inv.id],
      transactionIds: best.set.map((x) => x.tx.id),
      allocations,
      differenceMinor: best.diff,
      currency: inv.currency,
    });
  }
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function newCtx(invoices: EngineInvoice[], txs: EngineTransaction[], options: Partial<EngineOptions>): Ctx {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  // deterministic ordering regardless of input order
  const sortedInv = [...invoices].sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.number.localeCompare(b.number));
  const sortedTx = [...txs].sort((a, b) => a.bookingDate.localeCompare(b.bookingDate) || a.id.localeCompare(b.id));
  return {
    opts,
    invoices: sortedInv,
    txs: sortedTx,
    open: new Map(sortedInv.map((i) => [i.id, i.openAmountMinor])),
    usedTx: new Set(),
    touchedInv: new Set(),
    proposals: [],
  };
}

/** Stages 1-3. Pure & synchronous. */
export function runDeterministicStages(
  invoices: EngineInvoice[],
  transactions: EngineTransaction[],
  options: Partial<EngineOptions> = {},
) {
  const ctx = newCtx(invoices, transactions, options);
  exactStage(ctx);
  fuzzyStage(ctx);
  partialStage(ctx);
  splitStage(ctx);
  return ctx;
}

function result(ctx: Ctx): EngineResult {
  return {
    proposals: ctx.proposals,
    unmatchedTransactionIds: freeTxs(ctx).map((t) => t.id),
    unmatchedInvoiceIds: ctx.invoices.filter((i) => !ctx.touchedInv.has(i.id) && (ctx.open.get(i.id) ?? 0) > 0).map((i) => i.id),
  };
}

/** Full pipeline including the optional assist stage (4). */
export async function reconcile(
  invoices: EngineInvoice[],
  transactions: EngineTransaction[],
  options: Partial<EngineOptions> = {},
  assistant?: MatchAssistant,
): Promise<EngineResult> {
  const ctx = runDeterministicStages(invoices, transactions, options);
  if (assistant) {
    const leftoverTx = freeTxs(ctx);
    const leftoverInv = ctx.invoices
      .filter((i) => (ctx.open.get(i.id) ?? 0) > 0)
      .map((i) => ({ ...i, openAmountMinor: ctx.open.get(i.id)! }));
    if (leftoverTx.length && leftoverInv.length) {
      const raw = await assistant.suggest(leftoverTx, leftoverInv, ctx.opts);
      for (const p of raw) {
        // Guard rails: assistant output is untrusted. Validate ids, currency, rejected pairs, amounts.
        const okTx = p.transactionIds.length > 0 && p.transactionIds.every((id) => leftoverTx.some((t) => t.id === id) && !ctx.usedTx.has(id));
        const okInv = p.invoiceIds.length > 0 && p.invoiceIds.every((id) => (ctx.open.get(id) ?? 0) > 0);
        const okPairs = p.transactionIds.every((t) => p.invoiceIds.every((i) => !rejected(ctx, t, i)));
        const okAlloc = p.allocations.every((a) => a.amountMinor > 0 && a.amountMinor <= (ctx.open.get(a.invoiceId) ?? 0));
        if (!okTx || !okInv || !okPairs || !okAlloc) continue;
        commit(ctx, {
          ...p,
          stage: 'assist',
          status: 'suggested',
          confidence: round3(Math.min(0.8, Math.max(0, p.confidence))),
          reason: `[${assistant.name}] ${p.reason}`,
        });
      }
    }
  }
  return result(ctx);
}
