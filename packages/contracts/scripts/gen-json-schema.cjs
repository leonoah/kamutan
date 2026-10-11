#!/usr/bin/env node
// Generates JSON Schema files from the Zod registry (run after build).
// Output: packages/contracts/json-schema/<Name>.json + index.json
const fs = require('node:fs');
const path = require('node:path');
const { zodToJsonSchema } = require('zod-to-json-schema');
const { jsonSchemaRegistry } = require('../dist/cjs/index.js');

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
console.log(`wrote ${names.length} JSON schemas to ${path.relative(process.cwd(), outDir) || outDir}`);
