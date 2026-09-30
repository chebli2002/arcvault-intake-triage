# Decisions

Running log. Two sections, append-only, newest entry at the bottom of each.

## Design decisions

One-line rationale per decision made while building.

- 2026-09-29 — Repo scaffold follows the "Repo layout" section of `CLAUDE.md` verbatim
  (directory names, file names) rather than inventing a different structure, so the repo
  matches the already-locked spec exactly.
- 2026-09-29 — `tests/samples.json` and `tests/expected.json` are pre-populated from the
  assessment brief's Section 2.1 sample inputs and `CLAUDE.md`'s oracle table, since that data
  is already fixed and transcribing it now avoids re-deriving it during Block 1/3. All other
  scaffolded files (`prompts/`, `schemas/`, `n8n/code/`, `tests/edge_cases.json`, `scripts/`)
  are left as placeholders — writing their real content is prompt/schema/logic design work
  that belongs to later blocks, not the scaffold.
- 2026-09-29 — Pinned Gemini model to `gemini-3.5-flash-lite`, not the `gemini-flash-lite-latest`
  alias. Confirmed via curl that the alias currently resolves to this exact version. Pinning
  the concrete name avoids Google silently repointing the alias mid-project, which would risk
  the "stable across 3 runs" requirement on prompt outputs. Also observed the response includes
  a `thoughtSignature` (thinking enabled by default on this model) — Block 1 needs to set
  `thinkingConfig` to the lowest level explicitly, per the locked "lowest thinking level" decision.
- 2026-09-29 — Google Sheets OAuth: used the standard OAuth2 client-credentials path (not the
  Service Account fallback) since it connected inside the 20-minute budget once the account was
  added as an OAuth test user. Created the target spreadsheet "ArcVault Intake & Triage"
  (id `1f0sMcKyExYoyptDIolI0jgdt13_UCbE54JpASu0xwF0`) with tabs `Routed` and `Escalation Queue`,
  no headers yet — those get added in Block 2 once `assemble.js`'s exact record shape is final,
  to avoid having to redo them.
- 2026-09-29 — Confirmed via curl that `gemini-3.5-flash-lite` rejects `thinkingConfig.thinkingBudget`
  (400 invalid argument — this model doesn't support disabling thinking that way) but accepts
  `thinkingConfig.thinkingLevel: "LOW"` (200, still produced ~89 thought tokens on a trivial
  prompt — thinking can't be fully disabled on this model, only set to its lowest level). Used
  `thinkingLevel: "LOW"` in both Gemini HTTP calls to satisfy the locked "lowest thinking level"
  decision.
- 2026-09-29 — `outputs/discrepancy` and `billing.discrepancy` are never requested from the LLM in
  either responseSchema — only `charged_amount`/`expected_amount` (nullable numbers, no currency
  symbol). Discrepancy arithmetic and the >$500 escalation check happen entirely in code
  (`escalate.js`, Block 2), per the locked rule that the model must not do arithmetic or assume
  billing periods.
- 2026-09-29 — `prompt_check.py` only checks `category`/`priority` against the oracle in
  `tests/expected.json`, not `queue`/`escalated` — those are computed by `route.js`/`escalate.js`
  (Block 2), which don't exist yet. Checking them here would be premature.
- 2026-09-29 — Block 1 done: `prompt_check.py` ran classify.v1 + enrich.v1 against all 5 official
  samples, 3 times, directly against Gemini (no n8n). All 5 matched the oracle's category/priority
  on every run; category/priority were identical across all 3 runs. Added `signals.evidence` to
  the enrichment schema/prompt (quoted evidence for any true signal) that wasn't in the original
  scaffold placeholder — `escalate.js`'s `outage_signal` rule reads `signals.*` directly, so an
  unsupported true value would silently trigger escalation on nothing; same discipline `urgency`
  already had.
- 2026-09-29 — Workflow is 8 n8n nodes in 4 labelled stages (Intake, Classify, Enrich,
  Route & Escalate), not CLAUDE.md's original 11 steps. The brief values a clear 4-step workflow
  over a complex 10-step one; the logic is unchanged, it's just grouped into 3 Code nodes
  (`prepare.js`, `check_classification.js`, `decide.js`), one file each, with small tested
  functions inside. Dropped the "valid?" IF node.
- 2026-09-29 — No IF node for empty input: it flows through the LLM calls like anything else, and
  the Code nodes ignore whatever the model returns for it (`classification_skipped` /
  `enrichment_skipped`) and file it in the Escalation Queue with `processing_failure`. Costs 2
  Gemini calls on a rare path; buys a straight-line workflow.
- 2026-09-29 — Gemini request bodies are built in the Code node before each HTTP call. Prompt text
  is copied into a marked GENERATED block of `prepare.js` / `check_classification.js` by
  `scripts/sync_prompts.js`, so `prompts/*.md` stays the single source of truth. n8n can't read
  repo files at runtime, and pasting prompts into an HTTP node body breaks because
  `{{placeholders}}` collide with n8n's `{{ }}` expression syntax. A unit test fails if the
  copies drift.
- 2026-09-29 — `request_id` uses a pure-JS FNV-1a 64-bit hash, not `crypto`: n8n 2.x's Code
  sandbox blocks `require('crypto')` without `NODE_FUNCTION_ALLOW_BUILTIN`, and a dedupe key
  doesn't need a cryptographic hash. Hashed over lowercased, whitespace-collapsed text so
  trivially different resubmissions share an id.
- 2026-09-29 — Priority floor (Incident/Outage => High) is applied in `check_classification.js`
  and logged as a `priority_floor_applied` warning, so the model's original proposal stays visible.
- 2026-09-29 — Billing amounts must appear as numbers in the message (after stripping commas) or
  they're nulled + logged. That makes "the model must not assume billing periods" enforceable:
  a model computing 980×12 = 11760 gets caught. `discrepancy` is computed in `decide.js`.
- 2026-09-29 — A true `signals.*` value with no verbatim evidence is downgraded to false (logged),
  since it feeds `outage_signal` directly.
- 2026-09-29 — A failed classification is still enriched (category "Unclassified") so the human
  reviewer gets a summary.
- 2026-09-29 — The HTTP nodes replace the item's JSON with Gemini's response, so the next Code node
  reads the running record back via `$('Prepare')` / `$('Check Classification')`. Node names in
  n8n must match those strings exactly.
- 2026-09-29 — Escalation split is a visible Switch node (on `escalated`) feeding two Google Sheets
  nodes, not one Sheets node with the tab name as an expression. Costs one node, but the
  escalation branch and its item counts are visible on the canvas / in the Loom.
- 2026-09-29 — Edge cases: 8 cases in `tests/edge_cases.json`, each with its expected outcome
  written before the first run (oracle-first, like `tests/expected.json`). Duplicate case is
  sample #1 resubmitted with different case and whitespace; its expected `request_id` is sample
  #1's (`1abd8139d2c2542c`).
- 2026-09-29 — Duplicates are identifiable (same `request_id`) but not blocked: the duplicate is
  processed and written again. Blocking needs a read of the Sheet (or a DB) before the LLM calls,
  i.e. another node and another API dependency. Documented as Phase 2 in `ARCHITECTURE.md`.
- 2026-09-29 — Enrich prompt bumped to v2 (file renamed via `git mv`, history keeps v1). v1's
  own wording caused the misfile: it gave "usernames, URLs" as examples of *other* tokens, so
  `arcvault.io/user/jsmith` went to `identifiers.other`. v2 defines each bucket, keeps invoice
  prefixes as written (`#8821`), and says dates/times aren't identifiers. Bumped rather than
  edited in place so `meta.prompt_version` never labels a record with the wrong prompt.
- 2026-09-29 — Classify prompt bumped to v2: anchored confidence bands, with "nothing says
  what's wrong" and "separate requests for different teams" named as below 0.7. The first
  edge-case run showed v1 returning 0.8 for "it's broken again" and 0.9 for bug+billing, so the
  `low_confidence` rule never fired. The 0.70 threshold stays in code. Checked with 3 runs:
  vague 0.5, multi-intent 0.6, official samples 0.95–1.0, categories unchanged.
- 2026-09-29 — `meta.prompt_version` versions the prompt *set*; "v2" = classify.v2 + enrich.v2.
  Caveat: Sheet rows written during this session's intermediate run carry "v2" with classify
  v1. `outputs/*.json` were regenerated after the final prompts.
- 2026-09-29 — `prompt_check.py` stability check now also compares `account_ids` and
  `invoice_numbers` across runs (the fields a team acts on). `amounts`/`other` are excluded:
  they flicker harmlessly (`$980` vs `$980/month`, `SSO` present or not).
- 2026-09-29 — Slow runs (~50s per sample on 3 of 5 in the Block 2 run): confirmed from
  execution data that the time was inside the two Gemini HTTP calls (15–43s each) during a
  2-minute window, with identical token counts to fast runs and no thinking tokens, at ~6
  calls/minute (under the 15 RPM limit). Not our rate limit; n8n doesn't log failed retry
  attempts, so a transient 429/503 absorbed by Retry On Fail vs. a slow response can't be told
  apart. The Block 3 runs took 5–22s per request. No config change: nothing failed, and a bigger
  delay wouldn't help latency that isn't ours. `send_samples.sh` now logs seconds per request,
  and ARCHITECTURE.md lists timeouts + backoff for production.
- 2026-09-29 — Re-pasting Code nodes: copy the file with `pbcopy`, click on a line of code in
  the node's editor, select all, paste, then verify the editor's character count equals the
  file's (`node -e` on the file). Publish after saving: the production webhook serves the
  published version, not the saved draft.

- 2026-09-30 — Submission deliverables (brief §4.1–4.4) stay in the repo rather than a separate
  folder: `SUBMISSION.md` maps each one to its file, so there is a single link to send and the docs
  can't drift from copies. Before recording the Loom, both Sheet tabs were cleared (headers kept)
  so the recording shows only the 5 fresh records.

## What the AI got wrong

- 2026-09-29 — Used `sed 's/^```$/```text/'` to add language tags to the fenced code blocks in
  `prompts/classify.v1.md` and `prompts/enrich.v1.md` for a markdownlint warning. The pattern
  matched closing fences too (they're also bare ` ``` ` lines), turning `` ```closing `` into
  `` ```textclosing ``-equivalent and corrupting both files' markdown structure. Fix: manually
  restored the closing fences to plain ` ``` `. Should have scoped the replacement to opening
  fences only (e.g. by line number or by only ever preceding a known content line), or just
  used Edit on each occurrence instead of a blanket sed across a file with paired delimiters.

- 2026-09-29 — First Block 2 design mapped CLAUDE.md's 11 pipeline steps 1:1 to n8n nodes and then
  added more (2 request-builder nodes, an IF, a flatten node, a Switch, 2 Sheets nodes): ~16 nodes.
  Wrong because the brief explicitly says a clean 4-step workflow beats a complex 10-step one;
  the user caught it. Fix: regrouped the same logic into 8 nodes / 4 stages with one Code file
  per node (see Design decisions). Should have checked the brief's guidance on workflow size
  before treating the spec's step list as a node list.

- 2026-09-29 — When collapsing the workflow, replaced the Switch + 2 Sheets nodes with a single
  Sheets node whose tab was an expression (`{{ $json.sheet_tab }}`). Fewer nodes, but it hid the
  escalation decision (a core requirement) from the canvas, which is what reviewers watch in the
  Loom. User overrode it. Fix: restored a visible Switch with two named branches. Lesson:
  "simple" means easy to follow visually, not minimum node count.

- 2026-09-29 — Block 3: made `prompt_check.py`'s stability check compare *all* identifiers,
  then spent iterations chasing run-to-run flicker in `identifiers.amounts` / `other` (e.g.
  `$980` vs `$980/month`), which nothing downstream reads for decisions. The user stopped it.
  Wrong because it was scope creep on a low-stakes field while the real work (re-pasting the
  nodes, re-running, docs, commit) sat unfinished, with no status update. Fix: stability
  checks only the identifiers a team acts on (`account_ids`, `invoice_numbers`). Lesson: when a
  new check flags something, first ask whether anything depends on that field.

What it did, why it was wrong, the fix. Populated as mistakes happen and get corrected.
