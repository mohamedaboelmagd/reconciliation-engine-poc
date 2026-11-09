/**
 * Integration ports (hexagonal "adapters"). The PoC ships the file-upload adapter only;
 * real bank and ERP connectors implement the same interfaces and feed the same services,
 * so the matching engine and the API never change when a new bank or ERP is added.
 */
import type { TxRowInput, InvoiceInput } from '../services/reconciliation.js';

/** Pulls statement lines from a bank (Open Banking API, host-to-host SFTP MT940/CAMT.053, aggregator). */
export interface BankConnector {
  readonly id: string; // e.g. "cib-h2h", "nbe-camt053", "file-upload"
  /** Fetch lines booked since the cursor. Must be safe to call repeatedly (row fingerprints dedupe). */
  fetchTransactions(args: { tenantId: string; accountRef: string; cursor?: string }): Promise<{ rows: TxRowInput[]; nextCursor?: string }>;
}

/** Source of truth for receivables; also receives the reconciliation outcome. */
export interface ErpConnector {
  readonly id: string; // e.g. "odoo", "sap-b1", "dynamics-bc", "zoho-books"
  fetchOpenInvoices(args: { tenantId: string; since?: string }): Promise<InvoiceInput[]>;
  /** Post a confirmed match back as a customer payment / receipt voucher. Must be idempotent on matchId. */
  postPayment(args: { tenantId: string; matchId: string; invoiceExternalRefs: string[]; amountMinor: number; currency: string; bookingDate: string; feeMinor: number }): Promise<{ erpDocumentId: string }>;
}

/** Built-in adapter used by POST /transactions/import (CSV/JSON upload). */
export class FileUploadConnector implements BankConnector {
  readonly id = 'file-upload';
  constructor(private readonly rows: TxRowInput[]) {}
  async fetchTransactions() {
    return { rows: this.rows };
  }
}
