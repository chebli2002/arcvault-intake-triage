# Submission — ArcVault Intake & Triage

Valsoft AI Engineer take-home. Everything lives in this repository; this page maps each
deliverable in Section 4 of the brief to where it is.

| Brief | Deliverable | Where |
|---|---|---|
| 4.1 | Working workflow | Loom: https://www.loom.com/share/f96d691aeec241b1896c47dd095dbe7a (all 5 samples processed end to end). Exported workflow: [`n8n/workflow.json`](n8n/workflow.json). Happy to do a live demo in the interview. |
| 4.2 | Structured output | [`outputs/outputs.json`](outputs/outputs.json) (5 records) and the Google Sheet: https://docs.google.com/spreadsheets/d/1f0sMcKyExYoyptDIolI0jgdt13_UCbE54JpASu0xwF0/edit?usp=sharing (tabs `Routed`, `Escalation Queue`). 8 edge cases: [`outputs/edge_cases.json`](outputs/edge_cases.json). |
| 4.3 | Prompt documentation | [`PROMPTS.md`](PROMPTS.md): both prompts, why each is structured that way, tradeoffs, what I'd change, and the v1 → v2 changes with the evidence behind them. |
| 4.4 | Architecture write-up | [`ARCHITECTURE.md`](ARCHITECTURE.md): system design, routing, escalation, production scale, Phase 2. |
| 7 | "What the AI got wrong" | [`DECISIONS.md`](DECISIONS.md): every design decision with its rationale, and each AI mistake I corrected. |

## At a glance

- **Stack:** n8n (self-hosted, Docker) + Gemini `gemini-3.5-flash-lite` (pinned, temperature 0,
  JSON schema output) + Google Sheets. All free tier.
- **Workflow:** webhook → Prepare → LLM Classify → Check Classification → LLM Enrich & Summarize
  → Decide → Switch (escalated?) → Sheets `Routed` / `Escalation Queue` → respond with the record.
- **Core design choice:** the LLM does language work (classify, extract, summarize); code makes
  every decision (validation, routing, escalation, billing arithmetic). Extracted identifiers
  must be verbatim substrings of the message or code drops them.

## Results on the 5 samples

| # | Message | Category | Priority | Queue | Escalated |
|---|---|---|---|---|---|
| 1 | 403 on login | Bug Report | High | Engineering | No |
| 2 | Bulk export of audit logs | Feature Request | Medium | Product | No |
| 3 | Invoice #8821, $1,240 vs $980 | Billing Issue | Medium | Billing | No (discrepancy $260 < $500) |
| 4 | SSO with Okta | Technical Question | Medium | Customer Support | No |
| 5 | Dashboard down, multiple users | Incident/Outage | High | Escalation Queue | Yes (`incident_category`, `outage_signal`) |

Confidence was 0.95–1.0 on all five. The expected results were written down before the first
run (`tests/expected.json`). How to run it yourself: [`README.md`](README.md).
