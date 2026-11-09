import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { openDatabase } from '../src/db/database.js';
import { MockAssistant } from '../src/engine/index.js';
import { ensureDemoTenants, seedTenant } from '../src/services/seed.js';

const NILE = { 'x-api-key': 'demo_nilefoods_key', 'x-actor': 'reviewer' };
const DELTA = { 'x-api-key': 'demo_lotustextiles_key' };
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const db = openDatabase(':memory:');
  ensureDemoTenants(db);
  seedTenant(db, 'ten_nilefoods');
  seedTenant(db, 'ten_lotustextiles');
  app = await buildApp({ db, assistant: new MockAssistant(), demoMode: true });
});

describe('API (sample data, end to end)', () => {
  it('rejects requests without a valid API key', async () => {
    expect((await app.inject({ url: '/api/v1/invoices' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/v1/invoices', headers: { 'x-api-key': 'wrong-key-123' } })).statusCode).toBe(401);
  });

  it('isolates tenants', async () => {
    const a = (await app.inject({ url: '/api/v1/invoices', headers: NILE })).json();
    const b = (await app.inject({ url: '/api/v1/invoices', headers: DELTA })).json();
    expect(a).toHaveLength(19);
    expect(b).toHaveLength(3);
    const res = await app.inject({ url: `/api/v1/invoices/${a[0].id}`, headers: DELTA });
    expect(res.statusCode).toBe(404);
  });

  it('re-importing the same bank file is idempotent', async () => {
    const csv = readFileSync(join(import.meta.dirname, '..', 'sample-data', 'nile-foods.bank-feed-oct-2026.csv'), 'utf8');
    const r = await app.inject({ method: 'POST', url: '/api/v1/transactions/import', headers: { ...NILE, 'content-type': 'text/csv' }, payload: csv });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ replayed: true, inserted: 0 });
    // Same lines in a different file (new hash) are still deduped row by row.
    const r2 = await app.inject({ method: 'POST', url: '/api/v1/transactions/import', headers: { ...NILE, 'content-type': 'text/csv' }, payload: csv + '\n' });
    expect(r2.json()).toMatchObject({ replayed: false, inserted: 0, duplicates: 20 });
    expect((await app.inject({ url: '/api/v1/transactions', headers: NILE })).json()).toHaveLength(20);
  });

  it('runs the pipeline, accepts/rejects suggestions, and audits everything', async () => {
    const run = (await app.inject({ method: 'POST', url: '/api/v1/reconciliation/runs', headers: NILE })).json();
    expect(run.autoMatched).toBeGreaterThanOrEqual(7);
    expect(run.suggested).toBeGreaterThanOrEqual(6);
    expect(Object.keys(run.byStage).sort()).toEqual(['assist', 'exact', 'fuzzy', 'partial', 'split']);

    // Re-running is stable: no new auto matches, same pending suggestions kept.
    const rerun = (await app.inject({ method: 'POST', url: '/api/v1/reconciliation/runs', headers: NILE })).json();
    expect(rerun).toMatchObject({ autoMatched: 0, suggested: 0, kept: run.suggested, superseded: 0 });

    const suggestions = (await app.inject({ url: '/api/v1/matches?status=suggested', headers: NILE })).json();
    const acc = await app.inject({ method: 'POST', url: `/api/v1/matches/${suggestions[0].id}/accept`, headers: NILE, payload: { note: 'checked remittance' } });
    expect(acc.json()).toMatchObject({ status: 'matched', decision: 'accepted', decidedBy: 'user:reviewer' });
    const again = await app.inject({ method: 'POST', url: `/api/v1/matches/${suggestions[0].id}/accept`, headers: NILE });
    expect(again.statusCode, again.body).toBe(409);
    const rej = await app.inject({ method: 'POST', url: `/api/v1/matches/${suggestions[1].id}/reject`, headers: NILE });
    expect(rej.json().status).toBe('rejected');

    const audit = (await app.inject({ url: '/api/v1/audit-log?limit=1000', headers: NILE })).json();
    const actions = audit.map((a: { action: string }) => a.action);
    expect(actions).toContain('match.accepted');
    expect(actions).toContain('match.rejected');
    expect(actions.filter((a: string) => a === 'match.auto_matched')).toHaveLength(run.autoMatched);
    expect((await app.inject({ url: '/api/v1/audit-log/verify', headers: NILE })).json().valid).toBe(true);

    // a rejected pair never comes back
    const run3 = (await app.inject({ method: 'POST', url: '/api/v1/reconciliation/runs', headers: NILE })).json();
    const all = (await app.inject({ url: '/api/v1/matches', headers: NILE })).json();
    const rejectedKey = JSON.stringify(suggestions[1].allocations);
    expect(all.filter((m: { status: string; allocations: unknown }) => m.status === 'suggested' && JSON.stringify(m.allocations) === rejectedKey)).toHaveLength(0);
    expect(run3.autoMatched).toBe(0);
  });

  it('exports a CSV report and a summary', async () => {
    const csv = await app.inject({ url: '/api/v1/reports/reconciliation.csv', headers: NILE });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('match_id,status,decision');
    expect(csv.body).toContain('unmatched_transaction');
    const s = (await app.inject({ url: '/api/v1/summary', headers: NILE })).json();
    expect(s.matched.count).toBeGreaterThan(0);
    expect(s.matched.amountByCurrency).toHaveProperty('USD');
  });

  it('serves an OpenAPI document', async () => {
    const doc = (await app.inject({ url: '/docs/json' })).json();
    expect(doc.openapi).toBe('3.0.3');
    expect(Object.keys(doc.paths)).toContain('/api/v1/reconciliation/runs');
  });

  it('validates invoice input and blocks duplicates', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: NILE, payload: { number: 'X', customerName: 'Y', amount: '-5', currency: 'egp', issueDate: '2026-11-01', dueDate: '2026-11-30' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: NILE, payload: { number: 'INV-2026-0300', customerName: 'Nour Bakeries', amount: '1500.50', currency: 'EGP', issueDate: '2026-11-01', dueDate: '2026-11-30' } });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().amountMinor).toBe(150050);
    const dup = await app.inject({ method: 'POST', url: '/api/v1/invoices', headers: NILE, payload: { number: 'INV-2026-0300', customerName: 'Nour Bakeries', amount: '1500.50', currency: 'EGP', issueDate: '2026-11-01', dueDate: '2026-11-30' } });
    expect(dup.statusCode).toBe(409);
  });
});
