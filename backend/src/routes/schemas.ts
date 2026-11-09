import { Type, type TSchema } from '@sinclair/typebox';

const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const open = { additionalProperties: true } as const;

export const ErrorSchema = Type.Object({ error: Type.String(), message: Type.String() }, { $id: 'Error' });

export const InvoiceInputSchema = Type.Object(
  {
    number: Type.String({ minLength: 1, maxLength: 64, examples: ['INV-2026-0200'] }),
    customerName: Type.String({ minLength: 1, maxLength: 200, examples: ['Cairo Gourmet LLC'] }),
    amount: Type.Union([Type.String({ pattern: '^[0-9,]+(\\.[0-9]{1,2})?$' }), Type.Number({ exclusiveMinimum: 0 })], { description: 'Major units, e.g. "12500.00"', examples: ['12500.00'] }),
    currency: Type.String({ pattern: '^[A-Z]{3}$', examples: ['EGP'] }),
    issueDate: Type.String({ format: 'date', examples: ['2026-11-01'] }),
    dueDate: Type.String({ format: 'date', examples: ['2026-11-30'] }),
    externalRef: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  },
  { additionalProperties: false },
);

export const InvoiceSchema = Type.Object(
  {
    id: Type.String(),
    number: Type.String(),
    customerName: Type.String(),
    amountMinor: Type.Integer({ description: 'Amount in minor units (piasters/cents)' }),
    paidMinor: Type.Integer(),
    openAmountMinor: Type.Integer(),
    currency: Type.String(),
    issueDate: Type.String(),
    dueDate: Type.String(),
    externalRef: Nullable(Type.String()),
    status: Type.Union([Type.Literal('open'), Type.Literal('partially_paid'), Type.Literal('paid')]),
    createdAt: Type.String(),
    updatedAt: Type.String(),
  },
  open,
);

export const TxRowSchema = Type.Object({
  bookingDate: Type.String({ format: 'date' }),
  amount: Type.Union([Type.String(), Type.Number()]),
  currency: Type.String({ pattern: '^[A-Z]{3}$' }),
  counterparty: Type.Optional(Type.String()),
  reference: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  bankAccount: Type.Optional(Type.String()),
  bankTxId: Type.Optional(Type.String()),
});

export const TransactionSchema = Type.Object(
  {
    id: Type.String(),
    bookingDate: Type.String(),
    amountMinor: Type.Integer(),
    currency: Type.String(),
    counterparty: Type.String(),
    reference: Type.String(),
    description: Type.String(),
    bankAccount: Type.String(),
    bankTxId: Nullable(Type.String()),
    importId: Type.String(),
    matchStatus: Type.Union([Type.Literal('matched'), Type.Literal('suggested'), Type.Literal('unmatched')]),
  },
  open,
);

export const ImportResultSchema = Type.Object({
  importId: Type.String(),
  replayed: Type.Boolean({ description: 'true when this exact file / Idempotency-Key was already imported' }),
  rowCount: Type.Integer(),
  inserted: Type.Integer(),
  duplicates: Type.Integer({ description: 'rows skipped because an identical bank line already exists' }),
  errors: Type.Array(Type.String()),
});

export const MatchSchema = Type.Object(
  {
    id: Type.String(),
    runId: Type.String(),
    status: Type.Union([Type.Literal('matched'), Type.Literal('suggested'), Type.Literal('rejected')]),
    decision: Type.Union([Type.Literal('auto'), Type.Literal('accepted'), Type.Literal('rejected'), Type.Literal('pending')]),
    stage: Type.Union([Type.Literal('exact'), Type.Literal('fuzzy'), Type.Literal('partial'), Type.Literal('split'), Type.Literal('assist')]),
    confidence: Type.Number({ minimum: 0, maximum: 1 }),
    reason: Type.String(),
    currency: Type.String(),
    amountMinor: Type.Integer(),
    differenceMinor: Type.Integer({ description: 'transactions minus allocated; negative = fees / short payment' }),
    decidedBy: Nullable(Type.String()),
    decidedAt: Nullable(Type.String()),
    note: Nullable(Type.String()),
    createdAt: Type.String(),
    transactions: Type.Array(Type.Object({}, open)),
    invoices: Type.Array(Type.Object({}, open)),
    allocations: Type.Array(Type.Object({ invoiceId: Type.String(), transactionId: Type.String(), amountMinor: Type.Integer() })),
  },
  open,
);

export const RunResultSchema = Type.Object(
  {
    runId: Type.String(),
    autoMatched: Type.Integer(),
    suggested: Type.Integer(),
    kept: Type.Integer({ description: 'pending suggestions unchanged since the previous run (same id kept)' }),
    superseded: Type.Integer(),
    unmatchedTransactions: Type.Integer(),
    unmatchedInvoices: Type.Integer(),
    byStage: Type.Record(Type.String(), Type.Integer()),
  },
  open,
);

const Bucket = Type.Object({ count: Type.Integer(), amountByCurrency: Type.Record(Type.String(), Type.Integer()) });
export const SummarySchema = Type.Object(
  {
    matched: Bucket,
    suggested: Bucket,
    rejected: Bucket,
    unmatchedTransactions: Bucket,
    openInvoices: Bucket,
    autoMatchRate: Type.Number({ description: '% of bank lines matched (auto or accepted)' }),
    totals: Type.Object({ transactions: Type.Integer(), invoices: Type.Integer() }),
  },
  open,
);

export const AuditSchema = Type.Object(
  {
    seq: Type.Integer(),
    id: Type.String(),
    tenantId: Type.String(),
    actor: Type.String(),
    action: Type.String(),
    entityType: Type.String(),
    entityId: Nullable(Type.String()),
    details: Type.Any(),
    prevHash: Type.String(),
    hash: Type.String(),
    createdAt: Type.String(),
  },
  open,
);

export const DecisionBody = Type.Object({ note: Type.Optional(Type.String({ maxLength: 500 })) }, { additionalProperties: false });
export const IdParam = Type.Object({ id: Type.String() });
