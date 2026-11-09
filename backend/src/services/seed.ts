import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/database.js';
import { audit } from './audit.js';
import { createInvoice, createTenant, importTransactions, normalizeImportRows, purgeTenantData, type InvoiceInput } from './reconciliation.js';

/** Clearly fictional demo tenants. Keys are for local demo only. */
export const DEMO_TENANTS = [
  { id: 'ten_nilefoods', name: 'Nile Foods Distribution (SAMPLE)', apiKey: 'demo_nilefoods_key', prefix: 'nile-foods' },
  { id: 'ten_lotustextiles', name: 'Lotus Textiles Export (SAMPLE)', apiKey: 'demo_lotustextiles_key', prefix: 'lotus-textiles' },
] as const;

export function sampleDir(): string {
  return process.env.SAMPLE_DATA_DIR ?? join(import.meta.dirname, '..', '..', 'sample-data');
}

export function ensureDemoTenants(db: Db) {
  for (const t of DEMO_TENANTS) {
    const exists = db.prepare('SELECT 1 FROM tenants WHERE id = ?').get(t.id);
    if (!exists) createTenant(db, t.name, t.apiKey, t.id);
  }
}

/** Reset a demo tenant to its sample invoices + bank feed (no reconciliation run). */
export function seedTenant(db: Db, tenantId: string, actor = 'system:seed') {
  const t = DEMO_TENANTS.find((x) => x.id === tenantId);
  if (!t) throw new Error(`not a demo tenant: ${tenantId}`);
  purgeTenantData(db, tenantId);
  audit(db, { tenantId, actor, action: 'demo.reset', entityType: 'tenant', entityId: tenantId, details: { note: 'sample data loaded' } });
  const invoices = JSON.parse(readFileSync(join(sampleDir(), `${t.prefix}.invoices.json`), 'utf8')) as InvoiceInput[];
  for (const inv of invoices) createInvoice(db, tenantId, actor, inv);
  const filename = `${t.prefix}.bank-feed-oct-2026.csv`;
  const csv = readFileSync(join(sampleDir(), filename), 'utf8');
  const imp = importTransactions(db, tenantId, actor, { rows: normalizeImportRows({ csv }), rawContent: csv, source: 'file-upload', filename });
  return { invoices: invoices.length, transactions: imp.inserted };
}
