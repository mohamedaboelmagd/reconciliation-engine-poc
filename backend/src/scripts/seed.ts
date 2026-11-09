import { openDatabase } from '../db/database.js';
import { DEMO_TENANTS, ensureDemoTenants, seedTenant } from '../services/seed.js';

const db = openDatabase(process.env.DB_FILE ?? 'data/reconciliation.db');
ensureDemoTenants(db);
for (const t of DEMO_TENANTS) {
  const r = seedTenant(db, t.id);
  console.log(`seeded ${t.name}: ${r.invoices} invoices, ${r.transactions} bank lines  (x-api-key: ${t.apiKey})`);
}
