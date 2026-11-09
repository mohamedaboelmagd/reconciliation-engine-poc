# ADR-0003: AI assist only on leftovers, never auto-posting

- Status: accepted
- Date: 2026-11-09

## Context
LLMs are good at the long tail (Arabic vs English names, free-text remittance notes) but are probabilistic,
cost money per call, and can hallucinate ids. Finance teams must be able to explain every posting.

## Decision
- A `MatchAssistant` interface is stage 4 of the pipeline. It receives only transactions and invoices that
  deterministic rules could not match, and only the fields needed.
- Default implementation is `MockAssistant`: deterministic, offline, no keys. It demonstrates the value
  (Arabic payer -> English customer) and keeps tests and demos reproducible.
- `MATCH_ASSISTANT=openai` with `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL` enables any OpenAI-compatible
  endpoint (OpenAI, Azure OpenAI, self-hosted gateway), temperature 0 and JSON output.
- The engine treats assistant output as untrusted input: unknown ids, currency mismatches, over-allocations
  and human-rejected pairs are dropped; status is forced to `suggested`; confidence is capped at 0.80; the
  reason is prefixed with the assistant name and stored in the audit log on decision.

## Consequences
- AI can only add review work, never post money on its own.
- Cost is bounded because only leftovers are sent.
- Next: redact PII before sending, log prompts/responses for audit, measure precision per tenant before enabling.
