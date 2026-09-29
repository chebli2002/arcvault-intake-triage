#!/usr/bin/env python3
"""Calls Gemini directly (no n8n) with prompts/classify.v2.md and prompts/enrich.v2.md
against tests/samples.json, to check outputs are stable and match tests/expected.json
before wiring anything into n8n.

Checks category/priority against the oracle, and that category/priority/account_ids/invoice_numbers
are stable across runs. queue/escalated are code decisions (n8n/code/decide.js), tested elsewhere.

Zero third-party dependencies on purpose (stdlib only) - this is a throwaway sanity check,
not part of the shipped pipeline.
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GEMINI_MODEL = "gemini-3.5-flash-lite"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
NUM_RUNS = 3
MAX_RETRIES = 3


def load_env() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip())


def extract_fenced(text: str, heading: str) -> str:
    pattern = rf"## {re.escape(heading)}.*?```\w*\s*\n(.*?)\n```"
    match = re.search(pattern, text, re.DOTALL)
    if not match:
        raise ValueError(f"could not find a fenced block under '## {heading}'")
    return match.group(1).strip()


def load_prompt(path: Path) -> tuple[str, str]:
    text = path.read_text()
    return extract_fenced(text, "System instruction"), extract_fenced(text, "User message template")


def call_gemini(api_key: str, system_instruction: str, user_text: str, response_schema: dict) -> dict:
    body = {
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "contents": [{"role": "user", "parts": [{"text": user_text}]}],
        "generationConfig": {
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": response_schema,
            "thinkingConfig": {"thinkingLevel": "LOW"},
        },
    }
    req = urllib.request.Request(
        f"{GEMINI_URL}?key={api_key}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req) as resp:
                data = json.load(resp)
            break
        except urllib.error.HTTPError as exc:
            payload = exc.read().decode()
            if exc.code == 429 and attempt < MAX_RETRIES:
                delay = _retry_delay_seconds(payload, default=20)
                print(f"    (429 rate limited, retrying in {delay}s...)", file=sys.stderr)
                time.sleep(delay)
                continue
            raise RuntimeError(f"Gemini call failed ({exc.code}): {payload}") from exc
    else:
        raise RuntimeError("Gemini call failed: exhausted retries")
    text = data["candidates"][0]["content"]["parts"][0]["text"]
    return json.loads(text)


def _retry_delay_seconds(error_payload: str, default: int) -> int:
    match = re.search(r'"retryDelay":\s*"(\d+)s"', error_payload)
    return int(match.group(1)) + 2 if match else default


def fill(template: str, **kwargs: str) -> str:
    for key, value in kwargs.items():
        template = template.replace(f"{{{{{key}}}}}", value)
    return template


def run_once(samples, prompts, schemas, api_key) -> list[dict]:
    results = []
    for sample in samples:
        classify_user = fill(prompts["classify_template"], source=sample["source"], message=sample["message"])
        classification = call_gemini(api_key, prompts["classify_system"], classify_user, schemas["classification"])

        enrich_system = fill(prompts["enrich_system"], category=classification.get("category", ""))
        enrich_user = fill(
            prompts["enrich_template"],
            source=sample["source"],
            category=classification.get("category", ""),
            message=sample["message"],
        )
        enrichment = call_gemini(api_key, enrich_system, enrich_user, schemas["enrichment"])

        results.append({"id": sample["id"], "classification": classification, "enrichment": enrichment})
    return results


def oracle_match(actual: dict, expected: dict) -> bool:
    category_ok = actual.get("category") == expected.get("category")
    exp_priority = expected.get("priority")
    priority = actual.get("priority")
    priority_ok = priority in exp_priority if isinstance(exp_priority, list) else priority == exp_priority
    return category_ok and priority_ok


def main() -> None:
    load_env()
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        sys.exit("GEMINI_API_KEY not set - check .env")

    samples = json.loads((ROOT / "tests" / "samples.json").read_text())
    expected = json.loads((ROOT / "tests" / "expected.json").read_text())
    expected_by_id = {item["id"]: item for item in expected}

    classify_system, classify_template = load_prompt(ROOT / "prompts" / "classify.v2.md")
    enrich_system, enrich_template = load_prompt(ROOT / "prompts" / "enrich.v2.md")
    prompts = {
        "classify_system": classify_system,
        "classify_template": classify_template,
        "enrich_system": enrich_system,
        "enrich_template": enrich_template,
    }
    schemas = {
        "classification": json.loads((ROOT / "schemas" / "classification.schema.json").read_text()),
        "enrichment": json.loads((ROOT / "schemas" / "enrichment.schema.json").read_text()),
    }

    runs = []
    all_passed = True
    for run_idx in range(1, NUM_RUNS + 1):
        print(f"\n=== Run {run_idx}/{NUM_RUNS} ===")
        results = run_once(samples, prompts, schemas, api_key)
        runs.append(results)
        for result in results:
            expected_row = expected_by_id.get(result["id"], {})
            passed = oracle_match(result["classification"], expected_row)
            all_passed = all_passed and passed
            status = "PASS" if passed else "FAIL"
            c = result["classification"]
            print(
                f"  #{result['id']} {status}  category={c.get('category')!r:22} "
                f"priority={c.get('priority')!r:10} confidence={c.get('confidence')}"
            )

    print("\n=== Stability across runs ===")
    stable = True
    for idx, sample in enumerate(samples):
        categories = {run[idx]["classification"].get("category") for run in runs}
        priorities = {run[idx]["classification"].get("priority") for run in runs}
        # Only the identifiers a team acts on; amounts/other flicker harmlessly ("$980" vs "$980/month").
        identifiers = {json.dumps({k: run[idx]["enrichment"].get("identifiers", {}).get(k)
                                   for k in ("account_ids", "invoice_numbers")}, sort_keys=True) for run in runs}
        if len(categories) > 1 or len(priorities) > 1 or len(identifiers) > 1:
            stable = False
            print(f"  #{sample['id']} UNSTABLE: categories={categories} priorities={priorities}")
            for ids in identifiers:
                print(f"      identifiers={ids}")
    if stable:
        print("  All samples stable across all runs.")

    print("\n=== Last run, full output ===")
    print(json.dumps(runs[-1], indent=2))

    if not (all_passed and stable):
        sys.exit(1)


if __name__ == "__main__":
    main()
