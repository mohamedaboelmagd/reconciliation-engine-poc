import { Type, type FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { Db } from '../db/database.js';
import type { MatchAssistant } from '../engine/index.js';
import { listAudit, verifyAudit } from '../services/audit.js';
import { badRequest, notFound } from '../services/errors.js';
import * as svc from '../services/reconciliation.js';
import { DEMO_TENANTS, seedTenant } from '../services/seed.js';
import {
  AuditSchema, DecisionBody, ErrorSchema, IdParam, ImportResultSchema, InvoiceInputSchema, InvoiceSchema,
  MatchSchema, RunResultSchema, SummarySchema, TransactionSchema, TxRowSchema,
} from './schemas.js';

export const routes: FastifyPluginAsyncTypebox<{ db: Db; assistant?: MatchAssistant; demoMode: boolean }> = async (app, { db, assistant, demoMode }) => {
  // Allow accept/reject without a body (curl -X POST ...).
  app.addHook('preValidation', async (req) => {
    if (req.method === 'POST' && req.body === undefined && /\/matches\/[^/]+\/(accept|reject)$/.test(req.url)) req.body = {};
  });
  const errs = { 400: ErrorSchema, 401: ErrorSchema, 404: ErrorSchema, 409: ErrorSchema };

  // ---------------------------------------------------------------- invoices
  app.get('/invoices', {
    schema: { tags: ['invoices'], summary: 'List invoices', querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('partially_paid'), Type.Literal('paid')])) }), response: { 200: Type.Array(InvoiceSchema), ...errs } },
  }, async (req) => svc.listInvoices(db, req.tenant.id, req.query.status));

  app.get('/invoices/:id', { schema: { tags: ['invoices'], summary: 'Get invoice', params: IdParam, response: { 200: InvoiceSchema, ...errs } } },
    async (req) => svc.getInvoice(db, req.tenant.id, req.params.id));

  app.post('/invoices', { schema: { tags: ['invoices'], summary: 'Create invoice', body: InvoiceInputSchema, response: { 201: InvoiceSchema, ...errs } } },
    async (req, reply) => reply.code(201).send(svc.createInvoice(db, req.tenant.id, req.actor, req.body)));

  app.put('/invoices/:id', { schema: { tags: ['invoices'], summary: 'Replace invoice', params: IdParam, body: InvoiceInputSchema, response: { 200: InvoiceSchema, ...errs } } },
    async (req) => svc.updateInvoice(db, req.tenant.id, req.actor, req.params.id, req.body));

  app.delete('/invoices/:id', { schema: { tags: ['invoices'], summary: 'Delete invoice (only if not part of a match)', params: IdParam, response: { 204: Type.Null(), ...errs } } },
    async (req, reply) => {
      svc.deleteInvoice(db, req.tenant.id, req.actor, req.params.id);
      return reply.code(204).send(null);
    });

  // ---------------------------------------------------------------- transactions
  app.post('/transactions/import', {
    schema: {
      tags: ['transactions'],
      summary: 'Import bank statement lines (CSV or JSON). Idempotent.',
      description:
        'Send `text/csv` (columns: bank_account, bank_tx_id, booking_date, amount, currency, counterparty, reference, description) ' +
        'or JSON `{ "rows": [...] }` / `{ "csv": "..." }`. Re-sending the same file (or the same `Idempotency-Key`) returns the first result ' +
        'with `replayed: true`. Individual lines already present (same bank tx id, or same content fingerprint) are skipped and counted as duplicates.',
      headers: Type.Object({ 'idempotency-key': Type.Optional(Type.String({ maxLength: 128 })) }),
      querystring: Type.Object({ filename: Type.Optional(Type.String({ maxLength: 200 })) }),
      body: {
        content: {
          'text/csv': { schema: Type.String() },
          'application/json': { schema: Type.Object({ rows: Type.Optional(Type.Array(TxRowSchema, { maxItems: 50000 })), csv: Type.Optional(Type.String()) }) },
        },
      } as any,
      response: { 200: ImportResultSchema, 201: ImportResultSchema, ...errs },
    },
  }, async (req, reply) => {
    const body = req.body as unknown;
    let payload: { csv?: string; rows?: svc.TxRowInput[] };
    let raw: string;
    if (typeof body === 'string') (payload = { csv: body }), (raw = body);
    else if (body && typeof body === 'object') (payload = body as typeof payload), (raw = JSON.stringify(body));
    else throw badRequest('empty body');
    let rows: svc.TxRowInput[];
    try {
      rows = svc.normalizeImportRows(payload);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    if (!rows.length) throw badRequest('no rows found');
    const res = svc.importTransactions(db, req.tenant.id, req.actor, {
      rows, rawContent: raw, source: 'file-upload', filename: req.query.filename,
      idempotencyKey: req.headers['idempotency-key'] as string | undefined,
    });
    return reply.code(res.replayed ? 200 : 201).send(res);
  });

  app.get('/transactions', {
    schema: { tags: ['transactions'], summary: 'List bank lines with their match status', querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('matched'), Type.Literal('suggested'), Type.Literal('unmatched')])) }), response: { 200: Type.Array(TransactionSchema), ...errs } },
  }, async (req) => svc.listTransactions(db, req.tenant.id, req.query.status));

  // ---------------------------------------------------------------- reconciliation
  app.post('/reconciliation/runs', {
    schema: { tags: ['reconciliation'], summary: 'Run the matching pipeline (safe to re-run)', description: 'Confirmed matches are never touched. Pending suggestions are recomputed; unchanged ones keep their id. Human-rejected pairs are never proposed again.', response: { 200: RunResultSchema, ...errs } },
  }, async (req) => svc.runReconciliation(db, req.tenant.id, req.actor, assistant));

  app.get('/matches', {
    schema: { tags: ['reconciliation'], summary: 'List matches', querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('matched'), Type.Literal('suggested'), Type.Literal('rejected')])) }), response: { 200: Type.Array(MatchSchema), ...errs } },
  }, async (req) => svc.listMatches(db, req.tenant.id, req.query.status));

  app.get('/matches/:id', { schema: { tags: ['reconciliation'], summary: 'Get match', params: IdParam, response: { 200: MatchSchema, ...errs } } },
    async (req) => svc.getMatch(db, req.tenant.id, req.params.id));

  app.post('/matches/:id/accept', { schema: { tags: ['reconciliation'], summary: 'Accept a suggestion', params: IdParam, body: DecisionBody, response: { 200: MatchSchema, ...errs } } },
    async (req) => svc.decideMatch(db, req.tenant.id, req.actor, req.params.id, 'accept', req.body.note));

  app.post('/matches/:id/reject', { schema: { tags: ['reconciliation'], summary: 'Reject a suggestion (pair will not be proposed again)', params: IdParam, body: DecisionBody, response: { 200: MatchSchema, ...errs } } },
    async (req) => svc.decideMatch(db, req.tenant.id, req.actor, req.params.id, 'reject', req.body.note));

  // ---------------------------------------------------------------- reports
  app.get('/summary', { schema: { tags: ['reports'], summary: 'Dashboard summary', response: { 200: SummarySchema, ...errs } } },
    async (req) => svc.summary(db, req.tenant.id));

  app.get('/reports/reconciliation.csv', { schema: { tags: ['reports'], summary: 'Export reconciliation report (CSV)', produces: ['text/csv'] } as any },
    async (req, reply) =>
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="reconciliation-${new Date().toISOString().slice(0, 10)}.csv"`).send(svc.reportCsv(db, req.tenant.id)));

  app.get('/audit-log', {
    schema: { tags: ['reports'], summary: 'Audit trail (newest first)', querystring: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), entityId: Type.Optional(Type.String()), action: Type.Optional(Type.String()) }), response: { 200: Type.Array(AuditSchema), ...errs } },
  }, async (req) => listAudit(db, req.tenant.id, req.query));

  app.get('/audit-log/verify', {
    schema: { tags: ['reports'], summary: 'Verify the audit hash chain for this tenant', response: { 200: Type.Object({ valid: Type.Boolean(), entries: Type.Integer(), headHash: Type.Optional(Type.String()), brokenAtSeq: Type.Optional(Type.Integer()) }), ...errs } },
  }, async (req) => verifyAudit(db, req.tenant.id));

  app.get('/me', { schema: { tags: ['reports'], summary: 'Current tenant', response: { 200: Type.Object({ tenantId: Type.String(), tenantName: Type.String(), actor: Type.String(), demoMode: Type.Boolean() }) } } },
    async (req) => ({ tenantId: req.tenant.id, tenantName: req.tenant.name, actor: req.actor, demoMode }));

  // ---------------------------------------------------------------- demo
  app.post('/demo/reset', { schema: { tags: ['reports'], summary: 'DEMO_MODE only: reload sample data for this tenant', response: { 200: Type.Object({ invoices: Type.Integer(), transactions: Type.Integer() }), ...errs } } },
    async (req) => {
      if (!demoMode || !DEMO_TENANTS.some((t) => t.id === req.tenant.id)) throw notFound('route');
      return seedTenant(db, req.tenant.id, req.actor);
    });
};
