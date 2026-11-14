'use strict';
// Syntax check of every source file: CommonJS (main/preload) and ES modules (renderer).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
['src', 'scripts', 'test'].forEach((d) => walk(path.join(root, d)));
let failed = 0;
for (const f of files) {
  const esm = f.includes(`${path.sep}renderer${path.sep}`);
  try { execFileSync(process.execPath, esm ? ['--check', '--input-type=module'] : ['--check', f], esm ? { input: fs.readFileSync(f) } : {}); } catch (e) { failed++; console.error(`✗ ${path.relative(root, f)}\n${e.stderr || e.message}`); }
}
console.log(`${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
