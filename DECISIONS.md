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

## What the AI got wrong

- 2026-09-29 — Used `sed 's/^```$/```text/'` to add language tags to the fenced code blocks in
  `prompts/classify.v1.md` and `prompts/enrich.v1.md` for a markdownlint warning. The pattern
  matched closing fences too (they're also bare ` ``` ` lines), turning `` ```closing `` into
  `` ```textclosing ``-equivalent and corrupting both files' markdown structure. Fix: manually
  restored the closing fences to plain ` ``` `. Should have scoped the replacement to opening
  fences only (e.g. by line number or by only ever preceding a known content line), or just
  used Edit on each occurrence instead of a blanket sed across a file with paired delimiters.

What it did, why it was wrong, the fix. Populated as mistakes happen and get corrected.

(none yet)
