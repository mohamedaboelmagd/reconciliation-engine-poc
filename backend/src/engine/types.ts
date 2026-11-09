/**
 * Core domain types for the matching engine.
 * The engine is pure: it receives plain data and returns proposals.
 * It never touches the database, the clock, or the network (except the optional assist stage, behind an interface).
 * All money is integer minor units (piasters / cents) to avoid floating point drift.
 */

export interface EngineInvoice {
  id: string;
  number: string;
  customerName: string;
  /** Original invoice amount in minor units. */
  amountMinor: number;
  /** Amount still open (original minus confirmed allocations). */
  openAmountMinor: number;
  currency: string;
  issueDate: string; // ISO yyyy-mm-dd
  dueDate: string; // ISO yyyy-mm-dd
}

export interface EngineTransaction {
  id: string;
  bookingDate: string; // ISO yyyy-mm-dd
  /** Credit amount in minor units (positive = money received). */
  amountMinor: number;
  currency: string;
  counterparty: string;
  reference: string;
  description: string;
}

export type MatchStatus = 'matched' | 'suggested';
export type MatchStage = 'exact' | 'fuzzy' | 'partial' | 'split' | 'assist';

export interface Allocation {
  invoiceId: string;
  transactionId: string;
  amountMinor: number;
}

export interface MatchProposal {
  stage: MatchStage;
  status: MatchStatus;
  /** 0..1 */
  confidence: number;
  /** Human readable explanation, shown to the reviewer and stored in the audit log. */
  reason: string;
  invoiceIds: string[];
  transactionIds: string[];
  allocations: Allocation[];
  /** Sum(transactions) - Sum(allocated invoice amounts). Negative = short paid (fees, withholding). */
  differenceMinor: number;
  currency: string;
}

export interface EngineOptions {
  /** Relative amount tolerance, e.g. 0.01 = 1 %. */
  amountTolerancePct: number;
  /** Absolute amount tolerance in minor units (e.g. 3000 = 30.00). The larger of pct/abs wins. */
  amountToleranceAbsMinor: number;
  /** A payment may arrive up to N days after the due date. */
  dateWindowDays: number;
  /** A payment may arrive up to N days before the invoice date (pro-forma / advance). */
  earlyPaymentDays: number;
  /** Minimum counterparty similarity to consider a name "the same customer". */
  nameSimilarityThreshold: number;
  /** Confidence at or above which a fuzzy match is posted automatically. */
  autoMatchThreshold: number;
  /** Confidence below which a candidate is discarded. */
  suggestThreshold: number;
  /** Max invoices / transactions combined in one split match. */
  maxSplitSize: number;
  /** "txId|invId" pairs a human already rejected; never proposed again. */
  rejectedPairs: ReadonlySet<string>;
}

export const DEFAULT_OPTIONS: EngineOptions = {
  amountTolerancePct: 0.01,
  amountToleranceAbsMinor: 3000,
  dateWindowDays: 60,
  earlyPaymentDays: 7,
  nameSimilarityThreshold: 0.6,
  autoMatchThreshold: 0.9,
  suggestThreshold: 0.55,
  maxSplitSize: 4,
  rejectedPairs: new Set(),
};

export interface EngineResult {
  proposals: MatchProposal[];
  unmatchedTransactionIds: string[];
  unmatchedInvoiceIds: string[];
}

/**
 * Stage 4 plug-in: an "assistant" (LLM or rules) that looks at leftovers only.
 * Its proposals are ALWAYS downgraded to `suggested` by the engine: AI never auto-posts.
 */
export interface MatchAssistant {
  readonly name: string;
  suggest(
    transactions: EngineTransaction[],
    invoices: EngineInvoice[],
    options: EngineOptions,
  ): Promise<MatchProposal[]>;
}
