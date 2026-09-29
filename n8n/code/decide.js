// n8n Code node "Decide" — Stage 4: Route & Escalate  (mode: Run Once for Each Item)
// Input:  the LLM Enrich HTTP response ($json) + the record from "Check Classification".
// Output: { ...one flat spreadsheet row, record }. The Switch node after this splits on the
// `escalated` column into the Routed / Escalation Queue Sheets nodes (ignoring `record`);
// Respond to Webhook returns `record` (the CLAUDE.md output shape).
//
// Steps, in order: validateEnrichment -> route -> escalationReasons -> assemble -> sheetRow.
// Everything here is a decision, so it's all code: nothing the model extracted is trusted
// until checked, and every rule that fires is listed.

// ---------- Validate enrichment ----------

const LEVELS = ['Low', 'Medium', 'High'];
const ID_KINDS = ['account_ids', 'invoice_numbers', 'error_codes', 'amounts', 'other'];

// Same as check_classification.js (n8n Code nodes can't import each other).
function parseGeminiJson(response) {
  if (!response || response.error) {
    const msg = response && response.error && (response.error.message || JSON.stringify(response.error));
    throw new Error(`api_error: ${msg || 'no response'}`);
  }
  const candidate = response.candidates && response.candidates[0];
  if (!candidate) throw new Error('no_candidates');
  const parts = (candidate.content && candidate.content.parts) || [];
  const part = parts.find((p) => typeof p.text === 'string' && !p.thought);
  if (!part) throw new Error(`no_text_part (finishReason=${candidate.finishReason || 'unknown'})`);
  try {
    return JSON.parse(part.text);
  } catch (e) {
    throw new Error('response_not_json');
  }
}

function emptyEnrichment() {
  return {
    core_issue: '',
    identifiers: { account_ids: [], invoice_numbers: [], error_codes: [], amounts: [], other: [] },
    billing: { charged_amount: null, expected_amount: null, discrepancy: null },
    urgency: { level: null, evidence: [] },
    signals: { multiple_users_affected: false, service_unavailable: false, evidence: [] },
  };
}

// Identifiers: exact, case-sensitive substring of the message, or dropped + logged.
function keepVerbatim(values, message, label, warnings) {
  const kept = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    if (!message.includes(v)) warnings.push(`identifier_not_verbatim: ${label} ${JSON.stringify(v)}`);
    else if (!kept.includes(v)) kept.push(v);
  }
  return kept;
}

// Evidence quotes: substring ignoring case and whitespace differences, or dropped + logged.
function keepQuotes(values, message, label, warnings) {
  const squash = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const hay = squash(message);
  const kept = [];
  for (const v of Array.isArray(values) ? values : []) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    if (!hay.includes(squash(v))) warnings.push(`quote_not_in_message: ${label} ${JSON.stringify(v)}`);
    else kept.push(v);
  }
  return kept;
}

// Every number written in the message, commas stripped: "$1,240" -> 1240.
function numbersInMessage(message) {
  return (message.match(/\d[\d,]*(?:\.\d+)?/g) || []).map((s) => Number(s.replace(/,/g, '')));
}

// A billing amount must literally appear in the message. This is what makes "the model must not
// assume billing periods" enforceable: 980 x 12 = 11760 isn't in the text, so it's rejected.
function checkAmount(value, message, label, warnings) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    warnings.push(`billing_amount_invalid: ${label} ${JSON.stringify(value)}`);
    return null;
  }
  if (!numbersInMessage(message).includes(value)) {
    warnings.push(`billing_amount_not_in_message: ${label} ${value}`);
    return null;
  }
  return value;
}

// Returns { enrichment, summary, failed, warnings }. Never throws.
function validateEnrichment(record, response) {
  const warnings = [];
  if (!record.valid) {
    return { enrichment: emptyEnrichment(), summary: '', failed: true, warnings: ['enrichment_skipped: input invalid'] };
  }
  let out;
  try {
    out = parseGeminiJson(response);
  } catch (e) {
    return { enrichment: emptyEnrichment(), summary: '', failed: true, warnings: [`enrichment_failed: ${e.message}`] };
  }

  const message = record.message;
  const enrichment = emptyEnrichment();
  enrichment.core_issue = typeof out.core_issue === 'string' ? out.core_issue : '';

  const ids = out.identifiers || {};
  for (const kind of ID_KINDS) enrichment.identifiers[kind] = keepVerbatim(ids[kind], message, kind, warnings);

  const billing = out.billing || {};
  const charged = checkAmount(billing.charged_amount, message, 'charged_amount', warnings);
  const expected = checkAmount(billing.expected_amount, message, 'expected_amount', warnings);
  enrichment.billing = {
    charged_amount: charged,
    expected_amount: expected,
    // Arithmetic is code's job, never the model's. Rounded to cents to avoid float noise.
    discrepancy: charged !== null && expected !== null ? Math.round(Math.abs(charged - expected) * 100) / 100 : null,
  };

  const urgency = out.urgency || {};
  const level = LEVELS.includes(urgency.level) ? urgency.level : null;
  if (!level) warnings.push(`urgency_level_invalid: ${JSON.stringify(urgency.level)}`);
  const urgencyEvidence = keepQuotes(urgency.evidence, message, 'urgency', warnings);
  if (level && urgencyEvidence.length === 0) warnings.push(`urgency_unsupported: ${level} has no verbatim evidence`);
  enrichment.urgency = { level, evidence: urgencyEvidence };

  // A true signal with no surviving evidence is downgraded to false: signals feed the
  // outage_signal escalation rule directly, so an unsupported true would escalate on nothing.
  const signals = out.signals || {};
  const signalEvidence = keepQuotes(signals.evidence, message, 'signals', warnings);
  for (const name of ['multiple_users_affected', 'service_unavailable']) {
    let value = signals[name] === true;
    if (value && signalEvidence.length === 0) {
      warnings.push(`signal_unsupported: ${name} set to false (no verbatim evidence)`);
      value = false;
    }
    enrichment.signals[name] = value;
  }
  enrichment.signals.evidence = signalEvidence;

  return { enrichment, summary: typeof out.summary === 'string' ? out.summary : '', failed: false, warnings };
}

// ---------- Route ----------

const ROUTING_MAP = {
  'Bug Report': 'Engineering',
  'Incident/Outage': 'Engineering On-Call',
  'Feature Request': 'Product',
  'Billing Issue': 'Billing',
  'Technical Question': 'Customer Support',
};
const FALLBACK_QUEUE = 'Human Review';

function route(category) {
  const mapped = Object.prototype.hasOwnProperty.call(ROUTING_MAP, category);
  const queue = mapped ? ROUTING_MAP[category] : FALLBACK_QUEUE;
  return { intended_queue: queue, rule: mapped ? `category:${category} -> ${queue}` : `no valid category -> ${queue}` };
}

// ---------- Escalate ----------

const CONFIDENCE_THRESHOLD = 0.7;
const BILLING_THRESHOLD = 500;
const OUTAGE_KEYWORDS = ['outage', 'down for all users', 'down for everyone', 'not loading for anyone'];
const ESCALATION_QUEUE = 'Escalation Queue';

// Evaluates every rule (no short-circuit) and returns every reason that fired.
function escalationReasons({ message, valid, classification, classification_failed, enrichment, enrichment_failed }) {
  const reasons = [];
  const c = classification;
  const text = message.toLowerCase();

  // 1. Low confidence (a failed classification has no confidence; rule 5 covers it).
  if (typeof c.confidence === 'number' && c.confidence < CONFIDENCE_THRESHOLD) reasons.push('low_confidence');

  // 2. Incident category.
  if (c.category === 'Incident/Outage') reasons.push('incident_category');

  // 3. Outage signal: keyword on the message, or an evidence-backed LLM signal.
  if (OUTAGE_KEYWORDS.some((k) => text.includes(k)) || enrichment.signals.multiple_users_affected ||
      enrichment.signals.service_unavailable) {
    reasons.push('outage_signal');
  }

  // 4. Billing error over $500 (discrepancy computed in code above), or one lone amount over $500.
  const { charged_amount, expected_amount, discrepancy } = enrichment.billing;
  const amounts = [charged_amount, expected_amount].filter((a) => a !== null);
  if (discrepancy !== null) {
    if (discrepancy > BILLING_THRESHOLD) reasons.push('billing_error_over_500');
  } else if (amounts.length === 1 && amounts[0] > BILLING_THRESHOLD) {
    reasons.push('billing_amount_unverified');
  }

  // 5. Any validation/API failure upstream.
  if (!valid || classification_failed || enrichment_failed) reasons.push('processing_failure');

  return reasons;
}

// ---------- Assemble (exact CLAUDE.md output shape) + sheet row ----------

const MODEL = 'gemini-3.5-flash-lite';
// Version of the prompt set (prompts/classify.v2.md + prompts/enrich.v2.md).
const PROMPT_VERSION = 'v2';

function decide(record, response) {
  const e = validateEnrichment(record, response);
  const routing = route(record.classification.category);
  const reasons = escalationReasons({ ...record, enrichment: e.enrichment, enrichment_failed: e.failed });
  const escalated = reasons.length > 0;

  return {
    request_id: record.request_id,
    source: record.source,
    received_at: record.received_at,
    raw_message: record.raw_message,
    classification: record.classification,
    enrichment: e.enrichment,
    routing: {
      intended_queue: routing.intended_queue,
      final_queue: escalated ? ESCALATION_QUEUE : routing.intended_queue,
      rule: routing.rule,
    },
    escalation: { escalated, reasons },
    summary: e.summary,
    meta: {
      model: record.model || MODEL,
      prompt_version: PROMPT_VERSION,
      validation_warnings: [...record.warnings, ...e.warnings],
    },
  };
}

// Must match the header row of both tabs (Routed, Escalation Queue).
const SHEET_COLUMNS = [
  'request_id', 'received_at', 'source', 'category', 'priority', 'confidence',
  'intended_queue', 'final_queue', 'escalated', 'escalation_reasons',
  'core_issue', 'summary', 'urgency', 'identifiers',
  'charged_amount', 'expected_amount', 'discrepancy',
  'rationale', 'validation_warnings', 'raw_message', 'model', 'prompt_version',
];

function sheetRow(r) {
  const e = r.enrichment;
  const blank = (v) => (v === null || v === undefined ? '' : v);
  return {
    request_id: r.request_id,
    received_at: r.received_at,
    source: r.source,
    category: blank(r.classification.category),
    priority: blank(r.classification.priority),
    confidence: blank(r.classification.confidence),
    intended_queue: r.routing.intended_queue,
    final_queue: r.routing.final_queue,
    escalated: r.escalation.escalated ? 'TRUE' : 'FALSE',
    escalation_reasons: r.escalation.reasons.join(', '),
    core_issue: e.core_issue,
    summary: r.summary,
    urgency: blank(e.urgency.level),
    identifiers: Object.entries(e.identifiers).flatMap(([k, vs]) => vs.map((v) => `${k}: ${v}`)).join('; '),
    charged_amount: blank(e.billing.charged_amount),
    expected_amount: blank(e.billing.expected_amount),
    discrepancy: blank(e.billing.discrepancy),
    rationale: r.classification.rationale,
    validation_warnings: r.meta.validation_warnings.join('; '),
    raw_message: r.raw_message,
    model: r.meta.model,
    prompt_version: r.meta.prompt_version,
  };
}

// --- n8n wrapper (ignored under plain node) ---
if (typeof $json !== 'undefined') {
  const record = decide($('Check Classification').item.json, $json);
  return { json: { ...sheetRow(record), record } };
}
module.exports = { decide, sheetRow, SHEET_COLUMNS, validateEnrichment, route, escalationReasons, numbersInMessage };
