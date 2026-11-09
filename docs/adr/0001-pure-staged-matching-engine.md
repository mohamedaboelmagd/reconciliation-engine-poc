# ADR-0001: Pure matching engine with a staged pipeline

- Status: accepted
- Date: 2026-11-09

## Context
Matching rules change often (new banks, new reference formats, new tolerances) and mistakes cost money.
The rules must be easy to test, explain and evolve without touching persistence or HTTP code.

## Decision
- The engine is a pure function: `reconcile(invoices, transactions, options, assistant?) -> proposals`.
  No database, clock or network inside (the optional assistant is injected behind an interface).
- Rules run as ordered stages: exact -> fuzzy -> partial/split -> assist. Each stage consumes what it matches,
  so later, less certain stages only see leftovers.
- Every proposal carries status, confidence, the fee difference and a human-readable reason.
- Inputs are sorted inside the engine so results are deterministic regardless of input order.
- Money is integer minor units end to end; amounts are parsed from decimal strings.
- Persistence: SQLite in the PoC (one command, no native modules) with plain SQL migrations written to be
  portable to Postgres.

## Consequences
- Fast unit tests for each scenario (typos, fees, splits, rejected pairs, rogue assistant output).
- The same engine can run in the API, in a queue worker, or in a batch backfill.
- Subset-sum for splits is bounded (12 candidates, 4 items); larger remittances need a remittance-advice
  parser or a smarter solver later.
