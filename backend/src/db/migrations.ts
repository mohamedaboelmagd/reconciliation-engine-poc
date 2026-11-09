/**
 * Versioned, forward-only SQL migrations. Applied in order on startup and recorded in
 * schema_migrations. (In production: same files, run by the deploy pipeline against Postgres.)
 * Every business table carries tenant_id and every query filters on it (see ADR-0002).
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '0001_init',
    sql: `
CREATE TABLE tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  api_key_hash  TEXT NOT NULL UNIQUE,      -- sha256(api key); raw keys are never stored
  created_at    TEXT NOT NULL
);

CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id),
  number          TEXT NOT NULL,
  customer_name   TEXT NOT NULL,
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,
  issue_date      TEXT NOT NULL,
  due_date        TEXT NOT NULL,
  external_ref    TEXT,                    -- ERP document id
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, number)
);
CREATE INDEX ix_invoices_tenant ON invoices(tenant_id, currency);

CREATE TABLE imports (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  import_hash    TEXT NOT NULL,             -- sha256(file) or Idempotency-Key
  source         TEXT NOT NULL,
  filename       TEXT,
  row_count      INTEGER NOT NULL,
  inserted       INTEGER NOT NULL,
  duplicates     INTEGER NOT NULL,
  created_at     TEXT NOT NULL,
  UNIQUE (tenant_id, import_hash)
);

CREATE TABLE bank_transactions (
  id             TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL REFERENCES tenants(id),
  import_id      TEXT NOT NULL REFERENCES imports(id),
  bank_account   TEXT NOT NULL,
  bank_tx_id     TEXT,
  booking_date   TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL,
  counterparty   TEXT NOT NULL,
  reference      TEXT NOT NULL,
  description    TEXT NOT NULL,
  fingerprint    TEXT NOT NULL,             -- row-level idempotency
  created_at     TEXT NOT NULL,
  UNIQUE (tenant_id, fingerprint)
);
CREATE INDEX ix_tx_tenant ON bank_transactions(tenant_id, currency);

CREATE TABLE reconciliation_runs (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id),
  actor        TEXT NOT NULL,
  assistant    TEXT,
  stats_json   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE matches (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(id),
  run_id            TEXT NOT NULL REFERENCES reconciliation_runs(id),
  status            TEXT NOT NULL CHECK (status IN ('matched','suggested','rejected')),
  decision          TEXT NOT NULL CHECK (decision IN ('auto','accepted','rejected','pending')),
  stage             TEXT NOT NULL,
  confidence        REAL NOT NULL,
  reason            TEXT NOT NULL,
  currency          TEXT NOT NULL,
  difference_minor  INTEGER NOT NULL,
  decided_by        TEXT,
  decided_at        TEXT,
  note              TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX ix_matches_tenant ON matches(tenant_id, status);

CREATE TABLE match_allocations (
  match_id        TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL,
  invoice_id      TEXT NOT NULL REFERENCES invoices(id),
  transaction_id  TEXT NOT NULL REFERENCES bank_transactions(id),
  amount_minor    INTEGER NOT NULL,
  PRIMARY KEY (match_id, invoice_id, transaction_id)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- Append-only, hash-chained audit trail (tamper evident).
CREATE TABLE audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  id           TEXT NOT NULL UNIQUE,
  tenant_id    TEXT NOT NULL,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT,
  details_json TEXT NOT NULL,
  prev_hash    TEXT NOT NULL,
  hash         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX ix_audit_tenant ON audit_log(tenant_id, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
  WHEN (SELECT value FROM settings WHERE key = 'allow_audit_purge') IS NOT 'yes'
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

`,
  },
];
