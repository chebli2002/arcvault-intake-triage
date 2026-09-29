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

## What the AI got wrong

What it did, why it was wrong, the fix. Populated as mistakes happen and get corrected.

(none yet)
