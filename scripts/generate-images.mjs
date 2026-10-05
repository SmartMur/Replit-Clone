#!/usr/bin/env node
// Generate site images with Codex's native image generation (uses your Codex/ChatGPT login, no API key).
// Usage: node scripts/generate-images.mjs <spec.json> <outDir> [--parallel 3]
// Spec: { "style": "shared style text", "images": [{ "slot": "hero", "prompt": "...", "alt": "..." }] }
// Each image is generated in its own throwaway directory with the workspace-write sandbox, validated
// (PNG magic bytes + dimensions), then compressed to JPEG with sharp. Prompts come only from the spec.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const [specPath, outDir] = process.argv.slice(2);
const parallel = Number(process.argv[process.argv.indexOf('--parallel') + 1]) || 3;
if (!specPath || !outDir) { console.error('usage: generate-images.mjs <spec.json> <outDir> [--parallel N]'); process.exit(2); }

const spec = JSON.parse(await readFile(specPath, 'utf8'));
const SAFE_SLOT = /^[a-z0-9][a-z0-9-]{0,40}$/;
await mkdir(outDir, { recursive: true });

function runCodex(cwd, prompt) {
  return new Promise((resolve, reject) => {
    execFile('codex', ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', cwd, prompt],
      { timeout: 280_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => err ? reject(new Error(String(stderr || err).slice(0, 300))) : resolve(stdout));
  });
}

async function generate({ slot, prompt }) {
  if (!SAFE_SLOT.test(slot)) throw new Error(`bad slot name: ${slot}`);
  const dir = await mkdtemp(path.join(tmpdir(), 'imggen-'));
  try {
    const full = `Use your native image generation tool to create ONE image. ${spec.style ?? ''} ${prompt} Save the generated image into the current directory as ${slot}.png and reply with only the file name.`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await runCodex(dir, full);
        const png = await readFile(path.join(dir, `${slot}.png`));
        if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
        const meta = await sharp(png).metadata();
        if (!meta.width || meta.width < 1000) throw new Error(`too small: ${meta.width}px`);
        const jpg = await sharp(png).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
        await writeFile(path.join(outDir, `${slot}.jpg`), jpg);
        return { slot, bytes: jpg.length, from: `${meta.width}x${meta.height}`, attempt };
      } catch (e) { if (attempt === 2) throw e; }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const queue = [...spec.images];
const results = [];
async function worker() {
  while (queue.length) {
    const item = queue.shift();
    const started = Date.now();
    try { const r = await generate(item); results.push({ ok: true, ...r, alt: item.alt, secs: Math.round((Date.now() - started) / 1000) }); console.log(`OK   ${item.slot} ${r.from} -> ${Math.round(r.bytes / 1024)}KB (${Math.round((Date.now() - started) / 1000)}s)`); }
    catch (e) { results.push({ ok: false, slot: item.slot, error: e.message }); console.log(`FAIL ${item.slot}: ${e.message}`); }
  }
}
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify({ generator: 'codex native image generation', aiGenerated: true, images: results }, null, 2));
console.log(`done: ${results.filter(r => r.ok).length}/${results.length} images in ${outDir}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
