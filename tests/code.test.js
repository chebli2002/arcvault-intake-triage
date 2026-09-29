// Unit tests for n8n/code/*.js — pure functions, no n8n, no Gemini. Run: node --test tests/code.test.js
// LLM outputs are hand-written mocks shaped like real Gemini responses, so these test the
// code's decisions (validation, routing, escalation), not the model.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const code = (f) => require(path.join(__dirname, '..', 'n8n', 'code', f));
const { prepare, CLASSIFY_SYSTEM } = code('prepare.js');
const { checkClassification, ENRICH_SYSTEM } = code('check_classification.js');
const { decide, sheetRow, SHEET_COLUMNS } = code('decide.js');
const samples = require('./samples.json');
const expected = require('./expected.json');

const NOW = '2026-09-29T12:00:00.000Z';
const gemini = (obj) => ({
  candidates: [{ content: { parts: [{ text: JSON.stringify(obj), thoughtSignature: 'x' }] }, finishReason: 'STOP' }],
  modelVersion: 'gemini-3.5-flash-lite',
});
const enrichOut = (over = {}) => ({
  core_issue: 'x',
  identifiers: { account_ids: [], invoice_numbers: [], error_codes: [], amounts: [], other: [] },
  billing: { charged_amount: null, expected_amount: null },
  urgency: { level: 'Medium', evidence: [] },
  signals: { multiple_users_affected: false, service_unavailable: false, evidence: [] },
  summary: 'y',
  ...over,
});

// Mirrors the n8n graph: Prepare -> LLM Classify -> Check Classification -> LLM Enrich -> Decide.
function pipeline(body, classifyResp, enrichResp) {
  return decide(checkClassification(prepare(body, NOW), classifyResp), enrichResp);
}

const MOCKS = {
  1: [{ category: 'Bug Report', priority: 'High', confidence: 0.92, rationale: '403 error' },
    enrichOut({ identifiers: { account_ids: ['arcvault.io/user/jsmith'], invoice_numbers: [], error_codes: ['403'], amounts: [], other: [] },
      urgency: { level: 'High', evidence: ['keep getting a 403 error'] } })],
  2: [{ category: 'Feature Request', priority: 'Medium', confidence: 0.95, rationale: 'bulk export' }, enrichOut()],
  3: [{ category: 'Billing Issue', priority: 'Medium', confidence: 0.93, rationale: 'invoice' },
    enrichOut({ billing: { charged_amount: 1240, expected_amount: 980 },
      identifiers: { account_ids: [], invoice_numbers: ['#8821'], error_codes: [], amounts: ['$1,240', '$980'], other: [] } })],
  4: [{ category: 'Technical Question', priority: 'Low', confidence: 0.85, rationale: 'SSO question' }, enrichOut()],
  5: [{ category: 'Incident/Outage', priority: 'High', confidence: 0.9, rationale: 'dashboard down' },
    enrichOut({ signals: { multiple_users_affected: true, service_unavailable: true,
      evidence: ['Multiple users affected.', 'dashboard stopped loading'] } })],
};
const run = (id, cOver = {}, eOver = {}) => pipeline(samples[id - 1],
  gemini({ ...MOCKS[id][0], ...cOver }), gemini({ ...MOCKS[id][1], ...eOver }));

for (const sample of samples) {
  test(`sample ${sample.id} matches oracle queue/escalated`, () => {
    const rec = run(sample.id);
    const exp = expected.find((x) => x.id === sample.id);
    assert.equal(rec.classification.category, exp.category);
    assert.equal(rec.routing.final_queue, exp.queue);
    if (typeof exp.escalated === 'boolean') assert.equal(rec.escalation.escalated, exp.escalated);
  });
}

test('sample 3: discrepancy computed in code, under threshold', () => {
  const rec = run(3);
  assert.equal(rec.enrichment.billing.discrepancy, 260);
  assert.deepEqual(rec.escalation.reasons, []);
});

test('sample 5: every reason listed, both queues kept', () => {
  const rec = run(5);
  assert.deepEqual(rec.escalation.reasons, ['incident_category', 'outage_signal']);
  assert.equal(rec.routing.intended_queue, 'Engineering On-Call');
});

test('empty input: model output ignored, escalated with processing_failure', () => {
  // Even if the LLM returns something for an empty message, code doesn't trust it.
  const rec = pipeline({ source: 'Email', message: '   ' }, gemini(MOCKS[1][0]), gemini(MOCKS[1][1]));
  assert.equal(rec.classification.category, null);
  assert.equal(rec.routing.intended_queue, 'Human Review');
  assert.equal(rec.routing.final_queue, 'Escalation Queue');
  assert.deepEqual(rec.escalation.reasons, ['processing_failure']);
  assert.ok(rec.meta.validation_warnings.includes('message_empty'));
});

test('request_id is stable across whitespace/case, differs across messages', () => {
  const id = (source, message) => prepare({ source, message }, NOW).request_id;
  assert.equal(id('Email', 'Hello  World'), id('email', ' hello world '));
  assert.notEqual(id('Email', 'Hello  World'), id('Email', 'Hello there'));
});

test('API error on classify: processing_failure, Human Review', () => {
  const rec = pipeline(samples[0], { error: { message: '429 Too Many Requests' } }, gemini(enrichOut()));
  assert.equal(rec.classification.category, null);
  assert.equal(rec.routing.intended_queue, 'Human Review');
  assert.ok(rec.escalation.reasons.includes('processing_failure'));
});

test('invalid enum / out-of-range confidence fail validation', () => {
  assert.equal(run(1, { category: 'Spam' }).classification.category, null);
  assert.ok(run(1, { confidence: 7 }).escalation.reasons.includes('processing_failure'));
});

test('priority floor: Incident/Outage proposed Low becomes High, logged', () => {
  const rec = run(5, { priority: 'Low' });
  assert.equal(rec.classification.priority, 'High');
  assert.ok(rec.meta.validation_warnings.some((w) => w.startsWith('priority_floor_applied')));
});

test('low confidence escalates', () => {
  const rec = run(4, { confidence: 0.55 });
  assert.deepEqual(rec.escalation.reasons, ['low_confidence']);
  assert.equal(rec.routing.intended_queue, 'Customer Support');
});

test('non-verbatim identifiers dropped and logged', () => {
  const rec = run(1, {}, { identifiers: { account_ids: ['jsmith@arcvault.io', 'arcvault.io/user/jsmith'],
    invoice_numbers: [], error_codes: ['HTTP 403'], amounts: [], other: [] } });
  assert.deepEqual(rec.enrichment.identifiers.account_ids, ['arcvault.io/user/jsmith']);
  assert.deepEqual(rec.enrichment.identifiers.error_codes, []);
  assert.equal(rec.meta.validation_warnings.filter((w) => w.startsWith('identifier_not_verbatim')).length, 2);
});

const billingCase = (message, billing) => pipeline({ source: 'Email', message },
  gemini({ category: 'Billing Issue', priority: 'High', confidence: 0.9, rationale: '' }), gemini(enrichOut({ billing })));

test('billing > $500 discrepancy escalates', () => {
  const rec = billingCase('We were billed $2,400 but our plan is $1,200.', { charged_amount: 2400, expected_amount: 1200 });
  assert.equal(rec.enrichment.billing.discrepancy, 1200);
  assert.deepEqual(rec.escalation.reasons, ['billing_error_over_500']);
});

test('single billing amount > $500 is unverified', () => {
  const rec = billingCase('Why was I charged $900?', { charged_amount: 900, expected_amount: null });
  assert.deepEqual(rec.escalation.reasons, ['billing_amount_unverified']);
});

test('billing amount not written in the message is nulled (no assumed billing period)', () => {
  const rec = billingCase('Invoice shows $1,240 instead of $980/month.', { charged_amount: 1240, expected_amount: 11760 });
  assert.equal(rec.enrichment.billing.expected_amount, null);
  assert.equal(rec.enrichment.billing.discrepancy, null);
  assert.deepEqual(rec.escalation.reasons, ['billing_amount_unverified']);
});

test('signal without verbatim evidence is downgraded, no escalation', () => {
  const rec = run(1, {}, { signals: { multiple_users_affected: true, service_unavailable: false, evidence: ['everyone is down'] } });
  assert.equal(rec.enrichment.signals.multiple_users_affected, false);
  assert.deepEqual(rec.escalation.reasons, []);
});

test('outage keyword escalates even if model misses it', () => {
  const rec = pipeline({ source: 'Email', message: 'Reports page is down for everyone here.' },
    gemini({ category: 'Bug Report', priority: 'High', confidence: 0.8, rationale: '' }), gemini(enrichOut()));
  assert.deepEqual(rec.escalation.reasons, ['outage_signal']);
});

test('record has exactly the locked top-level shape; sheet row has every column', () => {
  assert.deepEqual(Object.keys(run(1)), ['request_id', 'source', 'received_at', 'raw_message', 'classification',
    'enrichment', 'routing', 'escalation', 'summary', 'meta']);
  assert.deepEqual(Object.keys(sheetRow(run(1))), SHEET_COLUMNS);
  assert.deepEqual(Object.keys(sheetRow(pipeline({ message: '' }))), SHEET_COLUMNS);
});

test('prompt constants in the node files match prompts/*.md (run scripts/sync_prompts.js if not)', () => {
  const md = (f) => fs.readFileSync(path.join(__dirname, '..', 'prompts', f), 'utf8');
  assert.ok(md('classify.v1.md').replace(/\n/g, ' ').includes(CLASSIFY_SYSTEM.replace(/\n/g, ' ')));
  assert.ok(md('enrich.v1.md').replace(/\n/g, ' ').includes(ENRICH_SYSTEM.replace(/\n/g, ' ')));
});
