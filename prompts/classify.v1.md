# Classify — v1

> TODO (Block 1). System/user prompt for LLM Classify (n8n node 3).
>
> Input: `{ source, message }` (post-normalization).
> Output: `classification.schema.json` — `category`, `priority`, `confidence`, `rationale`.
> Constraints from `CLAUDE.md`: category/priority are closed enums; confidence is a float
> 0.0–1.0; temperature 0, `responseMimeType: application/json` + `responseSchema`; priority
> floors (e.g. Incident/Outage => High) are enforced in code, not the prompt.
