# Enrich & Summarize — v1

> TODO (Block 1). System/user prompt for LLM Enrich & Summarize (n8n node 5). Receives the
> category from the Classify call.
>
> Input: `{ source, message, category }`.
> Output: `enrichment.schema.json` — `core_issue`, `identifiers`, `billing` (charged_amount /
> expected_amount only — `discrepancy` is computed in code, never by the LLM), `urgency`
> (level + evidence quoted from the message), `signals` (`multiple_users_affected`,
> `service_unavailable`), and `summary` (2–3 sentences for the receiving team).
> Constraints from `CLAUDE.md`: identifiers must be verbatim substrings of the raw message
> (code-checked); urgency/signals must cite quoted evidence; model must not assume billing
> periods; temperature 0, `responseMimeType: application/json` + `responseSchema`.
