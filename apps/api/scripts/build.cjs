#!/usr/bin/env node
/**
 * Build for Cloud Functions (source dir = apps/api):
 *  1. tsc (emits decorator metadata, which NestJS DI needs) → build/
 *  2. esbuild bundles the entry points → dist/, inlining the workspace package
 *     @kamutan/contracts (Cloud Build runs `npm install` on apps/api/package.json
 *     and cannot resolve `workspace:` deps); all npm packages stay external.
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const contracts = path.join(root, '../../packages/contracts/dist/cjs/index.js');
if (!fs.existsSync(contracts)) {
  console.error('packages/contracts is not built — run `pnpm --filter @kamutan/contracts build` first');
  process.exit(1);
}
for (const d of ['build', 'dist']) fs.rmSync(path.join(root, d), { recursive: true, force: true });

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json', '--outDir', 'build'], {
  cwd: root,
  stdio: 'inherit',
});

esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: {
    function: 'build/function.js',
    main: 'build/main.js',
    'scripts/export-openapi': 'build/scripts/export-openapi.js',
    'scripts/offboard-purge': 'build/scripts/offboard-purge.js',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  packages: 'external',
  alias: { '@kamutan/contracts': contracts },
  logLevel: 'warning',
});
fs.rmSync(path.join(root, 'build'), { recursive: true, force: true });

// Guard: the deployable bundle must not require the workspace package.
for (const f of ['function.js', 'main.js']) {
  const code = fs.readFileSync(path.join(root, 'dist', f), 'utf8');
  if (code.includes('require("@kamutan/contracts")')) {
    console.error(`dist/${f} still requires @kamutan/contracts`);
    process.exit(1);
  }
}
console.log('built dist/function.js, dist/main.js');
