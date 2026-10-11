// Marks dist/esm as ESM and dist/cjs as CJS so Node resolves module format correctly.
const fs = require('node:fs');
const path = require('node:path');
const dist = path.join(__dirname, '..', 'dist');
fs.writeFileSync(path.join(dist, 'esm', 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
fs.writeFileSync(path.join(dist, 'cjs', 'package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
