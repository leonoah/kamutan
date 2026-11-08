#!/usr/bin/env node
// Generates JSON Schema files from the Zod registry (run after build).
// Output: packages/contracts/json-schema/<Name>.json + index.json
const fs = require('node:fs');
const path = require('node:path');
const { zodToJsonSchema } = require('zod-to-json-schema');
const {
  jsonSchemaRegistry,
  DEFAULT_BOQ_TEMPLATE,
  DEFAULT_BOQ_TEMPLATE_VERSION,
  DEFAULT_BOQ_RULES,
  defaultRuleDoc,
  DEFAULT_ITEM_LIBRARY,
  DEFAULT_ITEM_LIBRARY_VERSION,
  QUALITY_ISSUE_HE,
  QUALITY_STATUS_HE,
  QUALITY_REASON_PREFIX_HE,
  QUALITY_REJECT_BANNER_HE,
  QUALITY_WARN_BANNER_HE,
  INPUT_QUALITY_ISSUE_KINDS,
  qualityReasonHe,
} = require('../dist/cjs/index.js');

const outDir = path.join(__dirname, '..', 'json-schema');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const names = Object.keys(jsonSchemaRegistry).sort();
for (const name of names) {
  const schema = zodToJsonSchema(jsonSchemaRegistry[name], {
    name,
    target: 'jsonSchema7',
    $refStrategy: 'none',
  });
  schema.$id = `https://kamutan.app/schemas/${name}.json`;
  fs.writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
}
fs.writeFileSync(
  path.join(outDir, 'index.json'),
  JSON.stringify({ schemas: names.map((n) => `${n}.json`) }, null, 2) + '\n',
);
// Sprint 3: default BOQ template + rule set as data, for the Python worker (same ids as the API seeds).
fs.mkdirSync(path.join(outDir, 'defaults'), { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'defaults', 'boq-defaults.json'),
  JSON.stringify({ template: DEFAULT_BOQ_TEMPLATE, rules: DEFAULT_BOQ_RULES.map(defaultRuleDoc) }, null, 2) + '\n',
);
// Stage 10 (A-LIVE-01): default item library (+ the template it belongs to), seeded per org by the API.
fs.writeFileSync(
  path.join(outDir, 'defaults', 'library-defaults.json'),
  JSON.stringify({ version: DEFAULT_ITEM_LIBRARY_VERSION, templateVersion: DEFAULT_BOQ_TEMPLATE_VERSION, template: DEFAULT_BOQ_TEMPLATE, items: DEFAULT_ITEM_LIBRARY }, null, 2) + '\n',
);
// Sprint 9: Hebrew quality-gate copy for the worker (detection reason chips must equal `qualityReasonHe`).
fs.writeFileSync(
  path.join(outDir, 'defaults', 'quality-messages.json'),
  JSON.stringify(
    {
      issueKinds: INPUT_QUALITY_ISSUE_KINDS,
      issues: QUALITY_ISSUE_HE,
      statuses: QUALITY_STATUS_HE,
      reasonPrefix: QUALITY_REASON_PREFIX_HE,
      rejectBanner: QUALITY_REJECT_BANNER_HE,
      warnBanner: QUALITY_WARN_BANNER_HE,
      examples: [
        { quality: { status: 'warn', effectiveDpi: 31, issues: [{ kind: 'low_resolution' }] }, reason: qualityReasonHe({ effectiveDpi: 31, issues: [{ kind: 'low_resolution' }] }) },
        { quality: { status: 'warn', effectiveDpi: 254, issues: [{ kind: 'low_resolution' }] }, reason: qualityReasonHe({ effectiveDpi: 254, issues: [{ kind: 'low_resolution' }] }) },
        { quality: { status: 'warn', issues: [{ kind: 'mirrored' }] }, reason: qualityReasonHe({ issues: [{ kind: 'mirrored' }] }) },
        { quality: { status: 'warn', issues: [] }, reason: qualityReasonHe({ issues: [] }) },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${names.length} JSON schemas to ${path.relative(process.cwd(), outDir) || outDir}`);
