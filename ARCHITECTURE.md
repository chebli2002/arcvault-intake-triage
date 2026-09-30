# Architecture

## System design

```text
POST /arcvault/intake {source, message}
  │
  ├─ 1. Intake    Webhook → Prepare (Code)
  ├─ 2. Classify  LLM Classify (HTTP → Gemini) → Check Classification (Code)
  ├─ 3. Enrich    LLM Enrich & Summarize (HTTP → Gemini)
  └─ 4. Route     Decide (Code) → Switch "Escalated" ─┬─ Sheets: Routed
                                                     └─ Sheets: Escalation Queue
                                                     → Respond to Webhook (the record)
```

One n8n workflow, 10 nodes in 4 stages. A POST to the webhook triggers it; the caller receives
the finished record in the response, and the same record is appended to one of two Google
Sheets tabs. The main design choice: **the model does language work, code makes decisions.**

| Step | Who | What |
|---|---|---|
| Prepare | code | trim, flag empty input, deterministic `request_id` (hash of source + normalized message) |
| Classify | Gemini | category, priority, confidence, one-sentence rationale |
| Check Classification | code | enum/range checks (failure ⇒ `classification_failed`), Incident/Outage ⇒ High priority floor |
| Enrich & Summarize | Gemini | core issue, identifiers, billing amounts, urgency and outage signals with quoted evidence, 2–3 sentence summary |
| Decide | code | verify the enrichment, route, apply escalation rules, compute the billing discrepancy, assemble the record |

Both calls use `gemini-3.5-flash-lite` (pinned version; free tier, fast, and accurate enough for
five-way classification), temperature 0, lowest thinking level, and a `responseSchema`, so output
is always parseable JSON with enum-constrained fields. Code still re-checks what a schema can't:

- Every identifier must be an exact substring of the raw message, or it's dropped. The model
  cannot invent an invoice number.
- Billing amounts must appear in the message. A model that computes $980 × 12 gets caught.
- A `true` outage signal or an urgency level needs a verbatim quote as evidence, or it's
  downgraded, since it feeds escalation directly.
- Every correction is logged in `meta.validation_warnings` on the record.

**State.** Stateless per request. Durable state is the Google Sheet plus n8n's execution log (full
input/output of every node). `request_id` is deterministic, so resubmissions share an id.

**Failures.** Both HTTP nodes retry twice and are set to *On Error: Continue*: an API error, empty
input, or invalid model output becomes a record in the Escalation Queue with `processing_failure`.
Nothing is dropped silently.

**Testability.** Each Code node's body is a file in `n8n/code/` exporting pure functions, unit-tested
with `node --test` against fake model responses. Prompts live in `prompts/*.md` and are synced into
the Code nodes by a script; a test fails if the copies drift.

## Routing logic

A lookup table in code, keyed on the validated category:

| Category | Queue | Why |
|---|---|---|
| Bug Report | Engineering | something is broken; needs a fix |
| Incident/Outage | Engineering On-Call | broken for many users; needs someone now |
| Feature Request | Product | a roadmap decision, not a fix |
| Billing Issue | Billing | needs account and contract access |
| Technical Question | Customer Support | how-to; answerable without a code change |
| no valid category | Human Review | classification failed |

The record keeps both `intended_queue` and `final_queue`, so an escalated item still shows which
team it belongs to. Routing is not in the prompt because it's a business rule: a table in code is
deterministic, testable, and changeable without re-validating a prompt.

## Escalation logic

Every rule is evaluated and every one that fires is listed in `escalation.reasons`; any reason
sends the record to the Escalation Queue.

| Reason | Fires when | Why |
|---|---|---|
| `low_confidence` | confidence < 0.70 | routing on a guess costs a hand-off later |
| `incident_category` | category is Incident/Outage | outages need a human to confirm scope and communicate |
| `outage_signal` | outage keyword in the raw message, **or** model reports multiple users affected / service unavailable with quoted evidence | catches outages misfiled as bugs; keywords are a model-independent backstop, the signal catches outages described without them |
| `billing_error_over_500` | \|charged − expected\| > $500, computed in code | financial and churn risk; arithmetic is never the model's |
| `billing_amount_unverified` | only one amount stated, and it's > $500 | a large disputed charge that can't be verified |
| `processing_failure` | empty input, API error, invalid output | a person sees every failure |

The 0.70 threshold only works if confidence means something. With classify v1, "it's broken
again" scored 0.8 and slipped through; v2 anchors the confidence scale (see `PROMPTS.md`), and it
now scores 0.5 while the official samples stay at 0.95–1.0. The threshold itself is judgement, not
measured; see Phase 2. Priority is not an escalation rule: the model proposes it and code floors it.

## Production scale

- **Reliability.** Replace the synchronous webhook with accept → queue → process (respond `202`
  with the `request_id`, process via n8n queue mode or a real queue). Add per-call timeouts,
  backoff that honours Gemini's `retryDelay`, and dedupe on `request_id` before the model calls.
  Move the system of record to Postgres; keep Sheets or a helpdesk as the view.
- **Cost.** ~1,500 tokens per request on Flash-Lite, a fraction of a cent. Rate limits (15 RPM on
  the free tier, so 7 intakes/minute) bind long before cost; a paid tier and a concurrency cap fix
  that.
- **Latency.** 5–10s typical, almost all in the two sequential model calls. Running them in
  parallel would halve it at some cost to enrichment quality; behind a queue, throughput matters
  more than latency.
- **Observability.** Alert on the `processing_failure` and `validation_warnings` rates (a spike
  means drift), track escalation rate per reason, and sample routed records to measure misroutes.
  `meta.model` and `meta.prompt_version` make regressions traceable.

## Phase 2

1. **Eval set and calibrated threshold:** 100–200 labelled requests; per-category precision/recall;
   set the confidence threshold from data.
2. **Human feedback loop:** record reviewer re-routes as eval data and few-shot examples.
3. **Duplicate handling:** look up `request_id` before the LLM calls; skip or link.
4. **Multi-intent splitting:** one record per intent instead of one category plus escalation.
5. **Notifications:** page on-call (Slack/PagerDuty) on `incident_category` / `outage_signal`.
