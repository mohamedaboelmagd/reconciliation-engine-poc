import { join } from 'node:path';
import { buildApp } from './app.js';
import { openDatabase } from './db/database.js';
import { assistantFromEnv } from './engine/index.js';
import { DEMO_TENANTS, ensureDemoTenants, seedTenant } from './services/seed.js';

const db = openDatabase(process.env.DB_FILE ?? 'data/reconciliation.db');
const demoMode = (process.env.DEMO_MODE ?? 'true') === 'true';
if (demoMode) {
  ensureDemoTenants(db);
  for (const t of DEMO_TENANTS) {
    const count = db.prepare('SELECT COUNT(*) AS c FROM invoices WHERE tenant_id = ?').get(t.id) as { c: number };
    if (!count.c) seedTenant(db, t.id);
  }
}

const app = await buildApp({
  db,
  assistant: assistantFromEnv(process.env),
  demoMode,
  staticDir: process.env.STATIC_DIR ?? join(import.meta.dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser'),
  logger: true,
});
const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: process.env.HOST ?? '127.0.0.1' });
app.log.info(`API docs: http://localhost:${port}/docs  |  dashboard: http://localhost:${port}/`);
