import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { auditSite, findUnmarkedSample } from '../lib/agent/site-audit';
import { compileTailwind, composeDesignCss } from '../lib/preview/design-css';

async function workspace(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'audit-'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

const PAGE = (body: string, extraHead = '') => `<!doctype html><html lang="en"><head><link rel="stylesheet" href="design-system.css">${extraHead}</head><body><button data-theme-toggle>Theme</button>${body}</body></html>`;

describe('compile isolation (the @apply serif bug that unstyled a whole page)', () => {
  test('@apply of a custom class fails to compile', async () => {
    const r = await compileTailwind('.serif { font-family: serif; }\n.step { @apply serif; }');
    expect(r.ok).toBe(false);
  });
  test('valid custom CSS compiles', async () => {
    expect((await compileTailwind('.step { font-family: serif; }')).ok).toBe(true);
  });
  test('a broken site.css is dropped, design system still served', async () => {
    const dir = await workspace({ 'site.css': '.x { @apply not-a-real-utility; }' });
    const c = await composeDesignCss(dir);
    expect(c.siteError).toBeTruthy();
    expect(c.css).toContain('--color-accent'); // base design system intact
    expect(c.css).not.toContain('not-a-real-utility');
    await rm(dir, { recursive: true });
  });
  test('brand override in site.css wins over the design system accent', async () => {
    const dir = await workspace({ 'site.css': '@theme { --color-accent: oklch(60% 0.15 250); }' });
    const c = await composeDesignCss(dir);
    expect(c.siteError).toBeUndefined();
    expect(c.css!.lastIndexOf('oklch(60% 0.15 250)')).toBeGreaterThan(c.css!.indexOf('--color-accent:'));
    await rm(dir, { recursive: true });
  });
  test('no site.css and no legacy file means no design system', async () => {
    const dir = await workspace({ 'index.html': '<p>x</p>' });
    expect((await composeDesignCss(dir)).css).toBeNull();
    await rm(dir, { recursive: true });
  });
});

describe('sample content must be marked', () => {
  test('flags fake phone, rating and counts', () => {
    const hits = findUnmarkedSample('<p>Call 780-555-0142</p><p>4.9/5 from 300+ Edmonton families</p>');
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });
  test('data-sample on the containing element clears it', () => {
    expect(findUnmarkedSample('<p data-sample>Call 780-555-0142</p><span data-sample>300+ families</span>')).toEqual([]);
  });
  test('ignores attributes, scripts and normal numbers', () => {
    expect(findUnmarkedSample('<a href="tel:7805550142" title="555-0142">Call us</a><script>var a="555-0142"</script><p>Open 9 to 5, 24 hours a day</p>')).toEqual([]);
  });
});

describe('auditSite', () => {
  test('clean page passes', async () => {
    const dir = await workspace({ 'site.css': '' });
    const r = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css', 'images/hero.jpg'], texts: { 'index.html': PAGE('<img src="images/hero.jpg" alt="x"><h1 class="text-ink-display">Hi</h1>') } });
    expect(r.errors).toEqual([]);
    await rm(dir, { recursive: true });
  });
  test('missing local asset, remote image and unknown classes are errors', async () => {
    const dir = await workspace({ 'site.css': '' });
    const html = PAGE('<img src="images/missing.jpg" alt=""><img src="https://images.unsplash.com/x.jpg" alt=""><div class="aa bb cc dd ee ff gg"></div>');
    const r = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css'], texts: { 'index.html': html } });
    const all = r.errors.join('\n');
    expect(all).toContain('images/missing.jpg');
    expect(all).toContain('Remote images');
    expect(all).toContain('no CSS');
    await rm(dir, { recursive: true });
  });
  test('broken site.css is reported', async () => {
    const dir = await workspace({ 'site.css': '.a { @apply nope-nope; }' });
    const r = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css'], texts: { 'index.html': PAGE('<p>x</p>'), 'site.css': '.a { @apply nope-nope; }' } });
    expect(r.errors.join(' ')).toContain('site.css does not compile');
    await rm(dir, { recursive: true });
  });
  test('unmarked sample content is an error; marked is fine', async () => {
    const dir = await workspace({ 'site.css': '' });
    const bad = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css'], texts: { 'index.html': PAGE('<p>4.9/5 from 300+ families</p>') } });
    expect(bad.errors.join(' ')).toContain('not marked as sample');
    const ok = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css'], texts: { 'index.html': PAGE('<p data-sample>4.9/5 from 300+ families</p>') } });
    expect(ok.errors).toEqual([]);
    await rm(dir, { recursive: true });
  });
  test('warnings: missing toggle, inline styles, malformed dl, script 404s', async () => {
    const dir = await workspace({ 'site.css': '' });
    const html = '<html><head><link rel="stylesheet" href="design-system.css"></head><body><p style="color:red">x</p><dl><div><p>bad</p></div></dl></body></html>';
    const r = await auditSite({ workspaceRoot: dir, fileNames: ['index.html', 'site.css', 'script.js'], texts: { 'index.html': html, 'script.js': 'img.src = "images/hero.jpg"' } });
    const w = r.warnings.join('\n');
    expect(w).toContain('theme toggle');
    expect(w).toContain('inline style');
    expect(w).toContain('<dl>');
    expect(w).toContain('images/hero.jpg');
    await rm(dir, { recursive: true });
  });
});
