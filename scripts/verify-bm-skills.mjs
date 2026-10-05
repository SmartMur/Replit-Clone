#!/usr/bin/env node
// Verify vendored bm-skills files against MANIFEST.json (or write it with --write).
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve('vendor/bm-skills');
const manifestPath = path.join(root, 'MANIFEST.json');
const SHA = 'd42872fdf28b7b48df45a321b1890254ffcb77a8';

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}
const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const files = walk(path.join(root, 'skills')).sort();
const current = Object.fromEntries(files.map((f) => [path.relative(root, f), hash(f)]));

if (process.argv.includes('--write')) {
  writeFileSync(manifestPath, JSON.stringify({ upstream: 'buildermethods/bm-skills', sha: SHA, files: current }, null, 2) + '\n');
  console.log(`wrote manifest: ${files.length} files`);
  process.exit(0);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const bad = [];
for (const [file, digest] of Object.entries(manifest.files)) if (current[file] !== digest) bad.push(`changed/missing: ${file}`);
for (const file of Object.keys(current)) if (!(file in manifest.files)) bad.push(`unexpected: ${file}`);
if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
console.log(`bm-skills OK: ${Object.keys(current).length} files match pinned ${manifest.sha.slice(0, 7)}`);
