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

One n8n workflow, 10 nodes in 4 stages. The caller POSTs a message and receives the finished
record in the HTTP response; the same record is appended as a row to one of two Google Sheets
tabs. `outputs/*.json` holds the records returned for the official samples and edge cases.

The split of work is the main design choice: **the model does language work, code makes
decisions.**

| Step | Who | What |
|---|---|---|
| Prepare | code | trim, flag empty input, `request_id` = FNV-1a hash of normalized source + message, build the Classify request |
| Classify | Gemini | category, priority, confidence, one-sentence rationale |
| Check Classification | code | enum and range checks (a bad answer becomes `classification_failed`), Incident/Outage ⇒ High priority floor, build the Enrich request |
| Enrich & Summarize | Gemini | core issue, identifiers, billing amounts, urgency and outage signals with quoted evidence, 2–3 sentence summary |
| Decide | code | verify the enrichment, route, apply escalation rules, compute the billing discrepancy, assemble the record and the sheet row |

Both Gemini calls use `gemini-3.5-flash-lite` (pinned version), temperature 0, lowest thinking
level, and a `responseSchema`, so the output is always parseable JSON with enum-constrained
fields. Code still re-checks everything, because a schema can't enforce the rules that matter:

- Every extracted identifier must be an exact substring of the raw message, or it's dropped and
  logged. The model cannot invent an invoice number.
- Billing amounts must appear as numbers in the message. A model that multiplies $980 by 12
  gets caught, because 11760 isn't in the text.
- A `true` outage signal or an urgency level must come with a verbatim quote from the message.
  A signal without one is downgraded to `false`, since it feeds escalation directly.
- Anything dropped or changed is recorded in `meta.validation_warnings`, so every correction
  code made to the model's output is visible on the record.

**State.** The workflow is stateless per request. The durable state is the Google Sheet, plus
n8n's own execution log (full input and output of every node, used for debugging).
`request_id` is deterministic, so a resubmission of the same message gets the same id.

**Failures.** Both HTTP nodes retry twice (5s apart) and are set to *On Error: Continue*: an API
error doesn't crash the run, it becomes a record with `processing_failure` in the Escalation
Queue. Empty input goes the same way. No path drops a request silently.

**Where the logic lives.** Each Code node's body is a file in `n8n/code/` that exports pure
functions and ends in a three-line n8n wrapper. Routing and escalation are unit-tested with
plain `node --test` against fake model responses, without n8n running. Prompts live in
`prompts/*.md` and are copied into the Code nodes by `scripts/sync_prompts.js`; a test fails if
the copies drift.

## Routing logic

Routing is a lookup table in code, keyed on the validated category:

| Category | Queue | Why |
|---|---|---|
| Bug Report | Engineering | something is broken; needs a fix |
| Incident/Outage | Engineering On-Call | broken for many users; needs someone now, not in the next sprint |
| Feature Request | Product | a roadmap decision, not a fix |
| Billing Issue | Billing | money and contracts; needs account access Engineering doesn't have |
| Technical Question | Customer Support | how-to and configuration; answerable without a code change |
| no valid category | Human Review | classification failed; a person has to read it |

The record keeps both `intended_queue` (where the category points) and `final_queue` (where it
actually went). An escalated request goes to the Escalation Queue, but the reviewer can see
which team it would have gone to, and `routing.rule` states the rule that fired.

Routing is not a prompt instruction because it's a business rule. A table in code is
deterministic, testable and changeable without re-validating a prompt. The model's only job
is to pick one of five categories.

## Escalation logic

Every rule is evaluated (no short-circuit), and every one that fires is listed in
`escalation.reasons`. Any reason ⇒ escalated.

| Reason | Fires when | Why |
|---|---|---|
| `low_confidence` | confidence < 0.70 | the model says it isn't sure; routing on a guess costs a hand-off later |
| `incident_category` | category is Incident/Outage | outages need a human to confirm scope and communicate, regardless of confidence |
| `outage_signal` | raw message contains an outage keyword, **or** the model reports multiple users affected / service unavailable with quoted evidence | catches outages misfiled as a Bug Report. The keyword check is a model-independent backstop; the model signal catches outages described without the keywords |
| `billing_error_over_500` | \|charged − expected\| > $500, computed in code | large billing errors have financial and churn risk; the arithmetic is code's, never the model's |
| `billing_amount_unverified` | only one amount stated and it is > $500 | a large charge is disputed but the difference can't be verified; a human should look |
| `processing_failure` | empty input, API error, invalid model output | nothing is dropped; a person sees every failure |

The 0.70 threshold is a starting point, not a measured value. It only works if the model's
confidence means something: with classify v1, "it's broken again" came back at 0.8 and slipped
through to Engineering. Classify v2 anchors the scale (see `PROMPTS.md`); the vague message now
scores 0.5 and a bug-plus-billing message 0.6, while the official samples stay at 0.95–1.0.
Tuning the threshold properly needs a labelled set; see Phase 2.

Priority is not an escalation rule. It's proposed by the model and floored by code
(Incident/Outage ⇒ High, logged as a warning so the model's original answer stays visible).

## Production scale

**Reliability.**
- Replace the synchronous webhook with *accept → queue → process*: respond `202` with the
  `request_id` at once and process from a queue (n8n queue mode with Redis workers, or a real
  queue in front of it). Today the caller waits for two LLM calls plus a Sheets write.
- Rate limits: the free tier allows 15 requests/minute, which is 7 intakes/minute at 2 calls
  each. Production needs a paid tier, a per-minute concurrency cap in the queue, exponential
  backoff that honours Gemini's `retryDelay`, and a timeout on each HTTP call so a hung
  request fails into a retry instead of holding a worker.
- Dedupe: check `request_id` against the store before calling the model (see Phase 2).
- Storage: Google Sheets is fine for a demo and for a human queue view, but not as a system of
  record (API quotas, no transactions, no uniqueness constraint). Use Postgres, and keep Sheets
  or a helpdesk (Zendesk, Jira Service Management) as the view.

**Cost.** Each request is about 1,500 tokens across the two calls on Flash-Lite, a fraction of
a cent (measured: ~640 tokens for Classify, ~900 for Enrich). Cost isn't the constraint at
this scale; rate limits are. If it became one, the levers are skipping both calls for empty
input and duplicates, and batch APIs for non-urgent sources.

**Latency.** Typically 5–10s end to end, most of it in the two model calls, which are
sequential because Enrich uses the category. Under load, the p99 is set by Gemini's latency
tail and retries (see `DECISIONS.md` for a run where single calls took 15–43s). Running both
calls in parallel (Enrich without the category) would halve it at some cost to enrichment
quality; with a queue in front, latency matters less than throughput.

**Observability and quality.** Alert on the rate of `processing_failure` and of
`validation_warnings` (a spike means the model or prompt drifted). Track the escalation rate
per reason, and sample routed records for human review to measure misroutes. Changing the
model or prompt goes through `prompt_check.py` and an eval set before it ships, and
`meta.model` / `meta.prompt_version` on each record make any regression traceable.

## Phase 2

With another week:

1. **Duplicate handling.** `request_id` already identifies resubmissions; add a lookup against
   the store before the LLM calls and either skip, or link the duplicate to the original.
2. **An eval set and calibrated thresholds.** 100–200 labelled real requests; measure per-category
   precision/recall and set the confidence threshold from data instead of 0.70 by judgement.
3. **Human feedback loop.** When a reviewer re-routes an escalated item, record the correction.
   That becomes eval data and few-shot examples for the next prompt version.
4. **Multi-intent requests.** Today a message with a bug and a billing question gets one
   category (the more urgent one), low confidence, and so a human, with both issues in the
   summary. Better: split it into one record per intent, linked by `request_id`.
5. **Notifications.** Page on-call (Slack/PagerDuty) for `incident_category` / `outage_signal`
   instead of waiting for someone to check the Escalation Queue.
6. **Skip the model for empty input.** An IF node before Classify saves two calls on a rare
   path; left out now to keep the workflow a straight line.
