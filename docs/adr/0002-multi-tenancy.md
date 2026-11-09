# ADR-0002: Tenant isolation by API key and tenant_id on every row

- Status: accepted
- Date: 2026-11-09

## Context
The product is SaaS for many businesses. Leaking one company's bank data to another is the worst possible
failure. The PoC must show the pattern without heavy infrastructure.

## Decision
- Shared database, shared schema, `tenant_id` column on every business table, composite unique keys
  (`tenant_id, number`), (`tenant_id, fingerprint`).
- The tenant is resolved once per request from the `x-api-key` header (SHA-256 hash lookup) in a Fastify hook.
  It is never taken from the URL or body.
- Every service function takes `tenantId` as its first argument and every SQL statement filters on it.
  Lookups of another tenant's ids return 404, not 403, to avoid confirming existence.
- Production adds Postgres Row-Level Security (`SET app.tenant_id` per transaction) as defence in depth, and
  per-tenant encryption keys for sensitive columns if required.

## Consequences
- Simple to operate and to query across tenants for internal analytics (with care).
- Noisy-neighbour risk is handled at the worker/queue level (per-tenant concurrency), not by separate databases.
- Very large or regulated tenants can later move to a dedicated database with the same schema.
