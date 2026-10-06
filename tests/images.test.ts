import { afterAll, describe, expect, test } from 'bun:test';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

import { buildImagePrompt, codexArgs, generateImage, sanitizeDescription } from '../lib/images/generate';
import { ImageError, toSiteJpeg } from '../lib/images/process';
import { listImageSlots } from '../lib/images/slots';
import { artifactWorkspaceDir } from '../lib/project-files';

const png = (w: number, h: number, rgba = { r: 255, g: 0, b: 0, alpha: 1 }) => sharp({ create: { width: w, height: h, channels: 4, background: rgba } }).png().toBuffer();

describe('toSiteJpeg (uploads)', () => {
  test('a PNG becomes a JPEG, width capped', async () => {
    const out = await toSiteJpeg(await png(3000, 2000));
    expect(out.buffer.subarray(0, 3).toString('hex')).toBe('ffd8ff');
    expect(out.width).toBe(1600);
    expect(out.height).toBe(1067);
  });
  test('small images are not enlarged', async () => {
    expect((await toSiteJpeg(await png(300, 200))).width).toBe(300);
  });
  test('SVG is rejected (it can carry script)', async () => {
    await expect(toSiteJpeg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>'))).rejects.toBeInstanceOf(ImageError);
  });
  test('garbage, empty and text files are rejected', async () => {
    await expect(toSiteJpeg(Buffer.from('not an image at all'))).rejects.toBeInstanceOf(ImageError);
    await expect(toSiteJpeg(Buffer.alloc(0))).rejects.toBeInstanceOf(ImageError);
    await expect(toSiteJpeg(Buffer.from('<?php system($_GET["x"]); ?>'))).rejects.toBeInstanceOf(ImageError);
  });
  test('a decompression bomb (huge pixel count, tiny file) is rejected', async () => {
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#fff' } }).png({ compressionLevel: 9 }).toBuffer();
    expect(bomb.length).toBeLessThan(2_000_000);
    await expect(toSiteJpeg(bomb)).rejects.toBeInstanceOf(ImageError);
  });
  test('metadata (EXIF/GPS) is stripped and orientation is applied', async () => {
    const tagged = await sharp(await png(100, 50)).jpeg().withExif({ IFD0: { Copyright: 'secret-owner' }, GPS: { GPSLatitudeRef: 'N' } }).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(tagged).metadata()).exif).toBeTruthy(); // the input really has metadata
    const out = await toSiteJpeg(tagged);
    const meta = await sharp(out.buffer).metadata();
    expect(meta.exif).toBeUndefined();
    expect(out.buffer.includes(Buffer.from('secret-owner'))).toBe(false);
    expect([out.width, out.height]).toEqual([50, 100]); // rotated upright
  });
  test('transparency is flattened to white', async () => {
    const out = await toSiteJpeg(await png(40, 40, { r: 0, g: 0, b: 0, alpha: 0 }));
    const { data } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245);
  });
});

describe('Codex generation is locked down', () => {
  test('arguments disable the shell, use a read-only sandbox, ignore user config and keep no session', () => {
    const args = codexArgs('/tmp/x', 'prompt');
    expect(args).toContain('--ephemeral');
    expect(args).toContain('--ignore-user-config');
    expect(args.join(' ')).toContain('-s read-only');
    expect(args.join(' ')).toContain('--disable shell_tool');
    expect(args.join(' ')).not.toContain('workspace-write');
    expect(args.join(' ')).not.toContain('danger');
  });
  test('descriptions are cleaned and capped; the prompt carries the safety rules', () => {
    const dirty = 'a woman\u0000\n\n  at a   desk\u001b[31m ' + 'x'.repeat(600);
    const clean = sanitizeDescription(dirty);
    expect(clean.length).toBeLessThanOrEqual(400);
    expect(/[\u0000-\u001f]/.test(clean)).toBe(false);
    const prompt = buildImagePrompt('a golden retriever on a beach');
    expect(prompt).toContain('golden retriever');
    expect(prompt).toContain('Do not run commands or read files');
    expect(prompt).toContain('real, named or famous people');
  });
  test.skipIf(!process.env.RUN_LIVE_IMAGE_TEST)('LIVE: generates a real image through Codex', async () => {
    const out = await generateImage('a simple flat illustration of a red apple on a white table');
    expect(out.width).toBeGreaterThan(800);
    expect(out.buffer.subarray(0, 3).toString('hex')).toBe('ffd8ff');
  }, 300000);
});

describe('listImageSlots', () => {
  const id = 'img-test-project';
  const root = artifactWorkspaceDir(id, 'main');
  afterAll(async () => { await rm(path.dirname(root), { recursive: true, force: true }); });
  test('finds referenced slots in html, css and js, flags missing, lists unreferenced files', async () => {
    await mkdir(path.join(root, 'images'), { recursive: true });
    await writeFile(path.join(root, 'index.html'), '<img src="images/hero.jpg"><img src="images/team.jpg" srcset="images/team.jpg 1x"><div style="x"></div>');
    await writeFile(path.join(root, 'site.css'), '.b{background:url(images/bg-pattern.png)}');
    await writeFile(path.join(root, 'script.js'), 'img.src = "images/story-one.webp"');
    await writeFile(path.join(root, 'images', 'hero.jpg'), 'x'.repeat(10));
    await writeFile(path.join(root, 'images', 'spare.jpg'), 'y');
    const slots = await listImageSlots(id, 'main');
    const by = Object.fromEntries(slots.map((s) => [s.slot, s]));
    expect(by['hero'].exists).toBe(true);
    expect(by['team'].exists).toBe(false);
    expect(by['bg-pattern'].referenced).toBe(true);
    expect(by['story-one'].exists).toBe(false);
    expect(by['spare'].referenced).toBe(false);
    expect(slots[0].exists).toBe(false); // missing ones first
  });
});
