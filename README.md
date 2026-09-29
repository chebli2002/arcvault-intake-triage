# ArcVault Intake & Triage

AI-powered intake, classification, enrichment, and routing pipeline for **ArcVault**, a
fictional B2B SaaS company. Built for the Valsoft AI Engineer take-home assessment.

Inbound customer requests (email, web form, support portal) are classified, enriched with
structured entities, routed to the correct team queue, and escalated to a human when
confidence is low or an escalation rule fires. Orchestration runs in n8n; classification and
enrichment run on Gemini (Flash-Lite); structured records land in Google Sheets.

`CLAUDE.md` is the source of truth for scope, locked decisions, the exact output record shape,
routing map, and escalation rules — read it before touching this repo.

## Status

Repo scaffold only. No prompts, schemas, Code node logic, or n8n workflow have been built yet.
See `DECISIONS.md` for the running log of decisions and corrections as the build proceeds.

## Repo layout

```
CLAUDE.md         Locked scope, decisions, pipeline spec, output shape, routing/escalation rules
ARCHITECTURE.md   System design write-up (deliverable, Section 4.4 of the assessment)
PROMPTS.md        Prompt documentation + rationale (deliverable, Section 4.3)
DECISIONS.md      Running log: design decisions, and mistakes the AI made that got corrected

prompts/          classify.v1.md, enrich.v1.md — the two Gemini prompts
schemas/          classification.schema.json, enrichment.schema.json — Gemini responseSchema defs
n8n/code/         Pure-function source for each n8n Code node (source of truth; pasted into n8n)
n8n/workflow.json Exported n8n workflow (added once the workflow is built in the n8n UI)
tests/            samples.json (5 official), edge_cases.json, expected.json (oracle)
scripts/          prompt_check.py (calls Gemini directly, no n8n), send_samples.sh (curl to webhook)
outputs/          outputs.json — structured output records for all processed samples
```

## Running it

Not yet runnable — pipeline is unbuilt. Once built:

1. `docker compose up` (or equivalent) to run n8n self-hosted, per Block 0 in the working plan.
2. `python scripts/prompt_check.py` to sanity-check both prompts against Gemini directly,
   outside n8n, using `tests/samples.json`.
3. Import/build the workflow in the n8n UI (nodes 1–11, per `CLAUDE.md`), paste in the
   `n8n/code/*.js` bodies, wire the Google Sheets credential.
4. `scripts/send_samples.sh` to POST all five official samples at the webhook.
5. Verify `outputs/outputs.json` and the Google Sheet tabs (`Routed`, `Escalation Queue`)
   against the oracle in `tests/expected.json`.

## Design principles

- The LLM does language work (classify, extract, summarize). Code makes decisions
  (validation, routing, escalation, arithmetic). Business rules never live in a prompt.
- Identifiers extracted by the LLM must be verbatim substrings of the raw message — checked
  in code, not trusted.
- Every failure path produces a record in the Escalation Queue with a reason. Nothing is
  dropped silently.
- `n8n/code/*.js` export pure functions so routing/escalation logic is testable with plain
  `node`, without n8n running.
