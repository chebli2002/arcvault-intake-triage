#!/usr/bin/env node
// Copies prompts/*.md + schemas/*.json into the GENERATED block of the n8n Code node files, so
// the prompt files stay the single source of truth. (n8n can't read repo files at runtime, and
// pasting a prompt into an HTTP node body breaks: {{source}} collides with n8n's {{ }} syntax.)
// Re-run after editing a prompt or schema, then re-paste the node:  node scripts/sync_prompts.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

// Same extraction as scripts/prompt_check.py: first fenced block under "## <heading>".
function extractFenced(text, heading) {
  const match = text.match(new RegExp(`## ${heading}[\\s\\S]*?\`\`\`\\w*\\s*\\n([\\s\\S]*?)\\n\`\`\``));
  if (!match) throw new Error(`no fenced block under '## ${heading}'`);
  return match[1].trim();
}

const TARGETS = [
  { file: 'prepare.js', prompt: 'classify.v1.md', schema: 'classification.schema.json', prefix: 'CLASSIFY' },
  { file: 'check_classification.js', prompt: 'enrich.v1.md', schema: 'enrichment.schema.json', prefix: 'ENRICH' },
];

for (const t of TARGETS) {
  const md = read('prompts', t.prompt);
  const block = [
    `const ${t.prefix}_SYSTEM = ${JSON.stringify(extractFenced(md, 'System instruction'))};`,
    `const ${t.prefix}_USER = ${JSON.stringify(extractFenced(md, 'User message template'))};`,
    `const ${t.prefix}_SCHEMA = ${JSON.stringify(JSON.parse(read('schemas', t.schema)))};`,
  ].join('\n');

  const file = path.join(ROOT, 'n8n', 'code', t.file);
  const src = fs.readFileSync(file, 'utf8');
  const re = /(\/\/ ---- BEGIN GENERATED[^\n]*\n)[\s\S]*?(\/\/ ---- END GENERATED ----)/;
  if (!re.test(src)) throw new Error(`${t.file}: GENERATED markers not found`);
  fs.writeFileSync(file, src.replace(re, (m, begin, end) => `${begin}${block}\n${end}`));
  console.log(`synced ${t.prompt} + ${t.schema} -> n8n/code/${t.file}`);
}
