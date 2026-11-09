import type { Db } from '../db/database.js';
import { newId, nowIso, sha256 } from './ids.js';

export interface AuditEntry {
  seq: number;
  id: string;
  tenantId: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string | null;
  details: unknown;
  prevHash: string;
  hash: string;
  createdAt: string;
}

const GENESIS = '0'.repeat(64);

/** Append an entry. hash = sha256(prevHash + canonical entry), chained per tenant => tamper evident. */
export function audit(
  db: Db,
  e: { tenantId: string; actor: string; action: string; entityType: string; entityId?: string | null; details?: unknown },
) {
  const prev = db.prepare('SELECT hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1').get(e.tenantId) as
    | { hash: string }
    | undefined;
  const prevHash = prev?.hash ?? GENESIS;
  const id = newId('aud');
  const createdAt = nowIso();
  const detailsJson = JSON.stringify(e.details ?? {});
  const hash = sha256([prevHash, id, e.tenantId, e.actor, e.action, e.entityType, e.entityId ?? '', detailsJson, createdAt].join('|'));
  db.prepare(
    `INSERT INTO audit_log (id, tenant_id, actor, action, entity_type, entity_id, details_json, prev_hash, hash, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  ).run(id, e.tenantId, e.actor, e.action, e.entityType, e.entityId ?? null, detailsJson, prevHash, hash, createdAt);
  return id;
}

type Row = Record<string, string | number | null>;
const toEntry = (r: Row): AuditEntry => ({
  seq: r.seq as number,
  id: r.id as string,
  tenantId: r.tenant_id as string,
  actor: r.actor as string,
  action: r.action as string,
  entityType: r.entity_type as string,
  entityId: r.entity_id as string | null,
  details: JSON.parse(r.details_json as string),
  prevHash: r.prev_hash as string,
  hash: r.hash as string,
  createdAt: r.created_at as string,
});

export function listAudit(db: Db, tenantId: string, opts: { limit?: number; entityId?: string; action?: string } = {}) {
  const where = ['tenant_id = ?'];
  const args: (string | number)[] = [tenantId];
  if (opts.entityId) (where.push('entity_id = ?'), args.push(opts.entityId));
  if (opts.action) (where.push('action = ?'), args.push(opts.action));
  args.push(Math.min(opts.limit ?? 200, 1000));
  return (db.prepare(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ?`).all(...args) as Row[]).map(toEntry);
}

/** Recompute the chain for a tenant. */
export function verifyAudit(db: Db, tenantId: string) {
  const rows = (db.prepare('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC').all(tenantId) as Row[]).map(toEntry);
  let prev = GENESIS;
  for (const r of rows) {
    const h = sha256([prev, r.id, r.tenantId, r.actor, r.action, r.entityType, r.entityId ?? '', JSON.stringify(r.details), r.createdAt].join('|'));
    if (r.prevHash !== prev || r.hash !== h) return { valid: false, entries: rows.length, brokenAtSeq: r.seq };
    prev = r.hash;
  }
  return { valid: true, entries: rows.length, headHash: prev };
}
