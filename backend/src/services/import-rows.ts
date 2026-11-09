/**
 * Pure import helpers shared by the API and the in-browser demo:
 * header mapping, validation, normalisation and the idempotency fingerprint source.
 * (Hashing is done by the caller: node:crypto on the server, Web Crypto in the browser.)
 */
import { parseAmountToMinor, parseCsv } from './csv.js';

export interface TxRowInput {
  bookingDate: string;
  amount: string | number;
  currency: string;
  counterparty?: string;
  reference?: string;
  description?: string;
  bankAccount?: string;
  bankTxId?: string;
}

export interface CleanTxRow {
  bookingDate: string;
  amountMinor: number;
  currency: string;
  counterparty: string;
  reference: string;
  description: string;
  bankAccount: string;
  bankTxId: string;
  /** String to hash for row-level de-duplication. Prefers the bank's own transaction id. */
  fingerprintSource: string;
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Accepts CSV text (snake_case or camelCase headers) or a JSON array. */
export function normalizeImportRows(payload: { csv?: string; rows?: TxRowInput[] }): TxRowInput[] {
  if (payload.rows) return payload.rows;
  if (!payload.csv) throw new Error('provide CSV body or JSON rows');
  return parseCsv(payload.csv).map((r) => ({
    bookingDate: r['booking_date'] ?? r['bookingdate'] ?? r['date'],
    amount: r['amount'],
    currency: (r['currency'] ?? '').toUpperCase(),
    counterparty: r['counterparty'] ?? r['payer'] ?? '',
    reference: r['reference'] ?? r['ref'] ?? '',
    description: r['description'] ?? r['narrative'] ?? '',
    bankAccount: r['bank_account'] ?? r['bankaccount'] ?? r['account'] ?? 'default',
    bankTxId: r['bank_tx_id'] ?? r['banktxid'] ?? r['transaction_id'] ?? '',
  }));
}

/** Validate + normalise. All-or-nothing: callers reject the import if errors is non-empty. */
export function cleanImportRows(rows: TxRowInput[]): { clean: CleanTxRow[]; errors: string[] } {
  const errors: string[] = [];
  const clean = rows.flatMap((r, idx) => {
    try {
      if (!ISO.test(r.bookingDate ?? '')) throw new Error('bookingDate must be yyyy-mm-dd');
      if (!/^[A-Z]{3}$/.test(r.currency ?? '')) throw new Error('currency must be ISO 4217');
      const row = {
        bookingDate: r.bookingDate,
        amountMinor: parseAmountToMinor(r.amount),
        currency: r.currency,
        counterparty: (r.counterparty ?? '').trim(),
        reference: (r.reference ?? '').trim(),
        description: (r.description ?? '').trim(),
        bankAccount: (r.bankAccount ?? 'default').trim(),
        bankTxId: (r.bankTxId ?? '').trim(),
      };
      const fingerprintSource = row.bankTxId
        ? `${row.bankAccount}|id|${row.bankTxId}`
        : [row.bankAccount, row.bookingDate, row.amountMinor, row.currency, row.counterparty, row.reference, row.description].join('|');
      return [{ ...row, fingerprintSource }];
    } catch (e) {
      errors.push(`row ${idx + 1}: ${(e as Error).message}`);
      return [];
    }
  });
  return { clean, errors };
}
