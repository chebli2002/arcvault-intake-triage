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

## What the AI got wrong

What it did, why it was wrong, the fix. Populated as mistakes happen and get corrected.

(none yet)
