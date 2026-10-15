#!/usr/bin/env node
// Generates JSON Schema files from the Zod registry (run after build).
// Output: packages/contracts/json-schema/<Name>.json + index.json
const fs = require('node:fs');
const path = require('node:path');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { jsonSchemaRegistry, DEFAULT_BOQ_TEMPLATE, DEFAULT_BOQ_RULES, defaultRuleDoc } = require('../dist/cjs/index.js');

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
console.log(`wrote ${names.length} JSON schemas to ${path.relative(process.cwd(), outDir) || outDir}`);
