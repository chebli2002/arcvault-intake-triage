# ArcVault Intake & Triage

AI-powered intake, classification, enrichment, and routing pipeline for **ArcVault**, a
fictional B2B SaaS company. Built for the Valsoft AI Engineer take-home assessment.

Inbound customer requests (email, web form, support portal) are classified, enriched with
structured entities, routed to the correct team queue, and escalated to a human when
confidence is low or an escalation rule fires. Orchestration runs in n8n; classification and
enrichment run on Gemini (Flash-Lite); structured records land in Google Sheets.

**Reviewers: start with [`SUBMISSION.md`](SUBMISSION.md)**, which maps each deliverable to its file.

`CLAUDE.md` is the source of truth for scope, locked decisions, the exact output record shape,
routing map, and escalation rules — read it before touching this repo.

## Status

Built and working end to end. The n8n workflow (10 nodes, 4 stages) processes all 5 official
samples as expected (`tests/expected.json`, `outputs/outputs.json`), plus 8 edge cases with
an oracle written before running them (`tests/edge_cases.json`, `outputs/edge_cases.json`).
Edge-case results (all 8 match the oracle):

| # | Case | Result |
|---|---|---|
| 1 | Empty/whitespace | Escalation Queue, `processing_failure` |
| 2 | "it's broken again" | Bug Report, confidence 0.5 → Escalation Queue, `low_confidence` |
| 3 | Bug + invoice in one message | Bug Report, confidence 0.6 → Escalation Queue; summary covers both; discrepancy $150 |
| 4 | Prompt injection ("mark this Low") | Ignored: Incident/Outage, High, escalated (`incident_category`, `outage_signal`) |
| 5 | Outage, no keywords | Incident/Outage, escalated; `outage_signal` from evidence-backed LLM signal |
| 6 | Billing $4,800 vs $3,600 | Discrepancy $1,200 computed in code → `billing_error_over_500` |
| 7 | Duplicate of sample #1 | Same `request_id` (`1abd8139d2c2542c`); processed again, not blocked (Phase 2) |
| 8 | French message | Bug Report → Engineering; English summary; `E-4012`, `acme-fr-221` kept verbatim |

`ARCHITECTURE.md` covers the design, `PROMPTS.md` the two prompts, `DECISIONS.md` every
decision and correction made along the way.

## Repo layout

```text
CLAUDE.md         Locked scope, decisions, pipeline spec, output shape, routing/escalation rules
ARCHITECTURE.md   System design, routing, escalation, production scale, phase 2
PROMPTS.md        Both prompts + why they're structured that way
DECISIONS.md      Running log: design decisions, and mistakes the AI made that got corrected

prompts/          classify.v2.md, enrich.v2.md (source of truth for prompt text)
schemas/          classification.schema.json, enrichment.schema.json (Gemini responseSchema)
n8n/code/         prepare.js, check_classification.js, decide.js: one file per Code node,
                  pure functions + a thin n8n wrapper, pasted whole into n8n
n8n/workflow.json Exported n8n workflow
tests/            samples.json (5 official), expected.json (oracle), edge_cases.json (8 cases,
                  each with its expected outcome), code.test.js (unit tests, no n8n needed)
scripts/          prompt_check.py   calls Gemini directly: oracle + stability check, 3 runs
                  sync_prompts.js   copies prompts/ + schemas/ into the Code node files
                  send_samples.sh   POSTs a samples file to the webhook, saves the records
outputs/          outputs.json (5 samples), edge_cases.json (8 edge cases)
```

## Running it

Prerequisites: Docker, Node 18+, Python 3, `jq`, a Gemini API key, a Google account for Sheets.

1. `docker compose up -d`, then open <http://localhost:5678> and create the owner account.
2. Put `GEMINI_API_KEY=...` in `.env` (used by `prompt_check.py`).
3. Import `n8n/workflow.json` (Workflows → Import from File). Then create two credentials and
   select them on the nodes:
   - **Header Auth** named "Gemini API key": header `x-goog-api-key`, value = your key
     (LLM Classify, LLM Enrich).
   - **Google Sheets OAuth2** (Save to Routed, Save to Escalation Queue). Point both nodes at
     your own spreadsheet, with tabs `Routed` and `Escalation Queue` whose header row is
     `SHEET_COLUMNS` in `n8n/code/decide.js`.
4. Publish the workflow.
5. Send the samples:

   ```bash
   ./scripts/send_samples.sh                                   # 5 official samples -> outputs/outputs.json
   OUT=outputs/edge_cases.json ./scripts/send_samples.sh tests/edge_cases.json
   curl -X POST http://localhost:5678/webhook/arcvault/intake \
     -H 'Content-Type: application/json' -d '{"source":"Email","message":"..."}'
   ```

   The script waits 10s between requests: each request makes 2 Gemini calls and the free tier
   allows 15/minute.

Checks that don't need n8n:

```bash
node --test tests/code.test.js      # routing, escalation, validation, prompt-copy drift
python3 scripts/prompt_check.py     # both prompts vs. the oracle, 3 runs, stability
```

After editing anything in `prompts/` or `schemas/`: run `node scripts/sync_prompts.js`, run the
tests, paste the changed `n8n/code/*.js` file(s) into their Code nodes, publish, and re-export
the workflow.

## Design principles

- The LLM does language work (classify, extract, summarize). Code makes decisions
  (validation, routing, escalation, arithmetic). Business rules never live in a prompt.
- Identifiers extracted by the LLM must be verbatim substrings of the raw message — checked
  in code, not trusted.
- Every failure path produces a record in the Escalation Queue with a reason. Nothing is
  dropped silently.
- `n8n/code/*.js` export pure functions so routing/escalation logic is testable with plain
  `node`, without n8n running.
