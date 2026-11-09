export type MatchStatus = 'matched' | 'suggested' | 'rejected';
export type Stage = 'exact' | 'fuzzy' | 'partial' | 'split' | 'assist';

export interface Bucket { count: number; amountByCurrency: Record<string, number>; }
export interface Summary {
  matched: Bucket; suggested: Bucket; rejected: Bucket; unmatchedTransactions: Bucket; openInvoices: Bucket;
  autoMatchRate: number; totals: { transactions: number; invoices: number };
}
export interface MatchTx { id: string; bookingDate: string; amountMinor: number; counterparty: string; reference: string; bankAccount: string; }
export interface MatchInv { id: string; number: string; customerName: string; amountMinor: number; }
export interface Match {
  id: string; status: MatchStatus; decision: string; stage: Stage; confidence: number; reason: string; currency: string;
  amountMinor: number; differenceMinor: number; decidedBy: string | null; decidedAt: string | null; note: string | null;
  transactions: MatchTx[]; invoices: MatchInv[];
}
export interface Transaction {
  id: string; bookingDate: string; amountMinor: number; currency: string; counterparty: string; reference: string;
  description: string; bankAccount: string; matchStatus: 'matched' | 'suggested' | 'unmatched';
}
export interface Invoice {
  id: string; number: string; customerName: string; amountMinor: number; openAmountMinor: number; paidMinor: number;
  currency: string; issueDate: string; dueDate: string; status: 'open' | 'partially_paid' | 'paid';
}
export interface AuditEntry { seq: number; id: string; actor: string; action: string; entityType: string; entityId: string | null; details: any; hash: string; createdAt: string; }
export interface RunResult { runId: string; autoMatched: number; suggested: number; kept: number; superseded: number; unmatchedTransactions: number; unmatchedInvoices: number; byStage: Record<string, number>; }
export interface ImportResult { importId: string; replayed: boolean; rowCount: number; inserted: number; duplicates: number; }
