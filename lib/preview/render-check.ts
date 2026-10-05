/* eslint-disable @typescript-eslint/no-explicit-any -- Chrome DevTools Protocol messages are untyped JSON */
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';

/**
 * Renders a static site in headless Chrome (driven over its debugging pipe, no extra dependency),
 * serving it from the workspace and blocking everything external except Google Fonts. Returns
 * measured findings plus screenshots so the agent can SEE its page.
 *
 * Invisible-text detector: for every visible text element it compares the computed text colour
 * with the dominant colour of the pixels actually rendered behind it. This catches white-on-white
 * text that automated accessibility tools missed.
 */
export type ServedFile = { body: string | Buffer; contentType: string };
export type RenderDeps = {
  serveIndex: () => Promise<ServedFile>;
  serveFile: (relativePath: string) => Promise<ServedFile>;
  pages: string[]; // html files in the artifact, index.html first
  /** path prefix used by the preview base tag, e.g. /api/projects/<id>/preview/<slug>/ */
  basePrefix: string;
};
export type RenderShot = { label: string; mimeType: 'image/jpeg'; data: string };
export type RenderReport = {
  available: boolean;
  reason?: string;
  errors: string[];
  warnings: string[];
  notes: string[];
  shots: RenderShot[];
  durationMs: number;
};

const ORIGIN = 'http://site.test';
const FONT_HOSTS = new Set(['fonts.googleapis.com', 'fonts.gstatic.com', 'esm.sh']); // fonts, and the CDN React previews import from
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean) as string[];

async function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

type CdpMessage = { id?: number; method?: string; params?: Record<string, any>; result?: any; error?: { message: string }; sessionId?: string };

class Cdp {
  private id = 0;
  private buffer = '';
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners: Array<(m: CdpMessage) => void> = [];

  constructor(private child: ChildProcess) {
    (child.stdio[4] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      let index: number;
      while ((index = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        let message: CdpMessage;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.id !== undefined && this.pending.has(message.id)) {
          const entry = this.pending.get(message.id)!;
          this.pending.delete(message.id);
          if (message.error) entry.reject(new Error(message.error.message));
          else entry.resolve(message.result);
        } else {
          this.listeners.forEach((listener) => listener(message));
        }
      }
    });
  }

  on(listener: (m: CdpMessage) => void) {
    this.listeners.push(listener);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      (this.child.stdio[3] as NodeJS.WritableStream).write(JSON.stringify({ id, method, params, sessionId }) + '\0');
    });
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- in-page probe: measurements + text boxes for the pixel check ----
const PROBE = `(() => {
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const vw = document.documentElement.clientWidth;
  const sel = (el) => el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '');
  const out = { vw, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, offenders: [], broken: [], noAlt: 0, h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang, viewportMeta: !!document.querySelector('meta[name=viewport]'), unnamed: [], dupIds: [], small: [], boxes: [], title: document.title };
  const seen = new Set();
  document.querySelectorAll('[id]').forEach((e) => { if (seen.has(e.id)) out.dupIds.push(e.id); seen.add(e.id); });
  document.querySelectorAll('img').forEach((i) => { if (i.complete && i.naturalWidth === 0) out.broken.push(i.getAttribute('src')); if (!i.hasAttribute('alt')) out.noAlt++; });
  document.querySelectorAll('a,button').forEach((e) => { const name = (e.getAttribute('aria-label') || e.textContent || '').trim() || e.querySelector('img[alt]:not([alt=""])'); if (!name && !e.closest('[hidden]')) out.unnamed.push(sel(e)); });
  const visible = (e, r) => r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none' && !e.closest('[hidden]');
  document.querySelectorAll('body *').forEach((e) => {
    const r = e.getBoundingClientRect();
    if (!visible(e, r)) return;
    const cs = getComputedStyle(e);
    if (cs.position !== 'fixed' && (r.right > vw + 1 || r.left < -1) && !e.closest('.hp,.sr-only')) { if (out.offenders.length < 6) out.offenders.push(sel(e) + ' L' + Math.round(r.left) + ' R' + Math.round(r.right)); }
    if (/^(A|BUTTON|SUMMARY|INPUT|SELECT|TEXTAREA)$/.test(e.tagName) && (r.width < 44 || r.height < 44) && !e.closest('.hp,.sr-only') && !(e.tagName === 'A' && cs.display === 'inline')) out.small.push(sel(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1);
    if (!hasText || e.closest('.sr-only,.hp') || cs.clip === 'rect(0px, 0px, 0px, 0px)') return;
    let opacity = 1; for (let p = e; p; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
    const [R, G, B, A] = rgba(cs.color);
    out.boxes.push({ x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, c: [R, G, B], a: A * opacity, fs: parseFloat(cs.fontSize), fw: parseInt(cs.fontWeight), sel: sel(e), text: e.textContent.trim().slice(0, 40) });
  });
  return JSON.stringify(out);
})()`;

type Box = { x: number; y: number; w: number; h: number; c: [number, number, number]; a: number; fs: number; fw: number; sel: string; text: string };

const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a: number[], b: number[]) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

function dominant(raw: Buffer, width: number, height: number, channels: number, box: { x: number; y: number; w: number; h: number }) {
  const x0 = Math.max(0, Math.floor(box.x) + 1), y0 = Math.max(0, Math.floor(box.y) + 1);
  const x1 = Math.min(width, Math.ceil(box.x + box.w) - 1), y1 = Math.min(height, Math.ceil(box.y + box.h) - 1);
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const stepX = Math.max(1, Math.floor((x1 - x0) / 60)), stepY = Math.max(1, Math.floor((y1 - y0) / 30));
  for (let y = y0; y < y1; y += stepY) {
    for (let x = x0; x < x1; x += stepX) {
      const i = (y * width + x) * channels;
      const key = ((raw[i] >> 4) << 8) | ((raw[i + 1] >> 4) << 4) | (raw[i + 2] >> 4);
      const entry = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      entry.n++; entry.r += raw[i]; entry.g += raw[i + 1]; entry.b += raw[i + 2];
      buckets.set(key, entry);
    }
  }
  let best: { n: number; r: number; g: number; b: number } | null = null;
  for (const entry of buckets.values()) if (!best || entry.n > best.n) best = entry;
  return best ? [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)] : null;
}

export async function findLowContrast(png: Buffer, boxes: Box[]) {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const invisible: Array<Box & { ratio: number }> = [];
  const low: Array<Box & { ratio: number }> = [];
  for (const box of boxes.slice(0, 600)) {
    if (box.w < 8 || box.h < 8 || box.fs < 9 || box.a < 0.05) continue;
    const bg = dominant(data, info.width, info.height, info.channels, box);
    if (!bg) continue;
    const eff = box.c.map((c, i) => Math.round(c * box.a + bg[i] * (1 - box.a)));
    const r = ratio(eff, bg);
    if (r < 1.6) invisible.push({ ...box, ratio: r });
    else if (r < (box.fs >= 24 || (box.fs >= 18.6 && box.fw >= 700) ? 3 : 4.5) && r < 3) low.push({ ...box, ratio: r });
  }
  return { invisible, low, width: info.width, height: info.height };
}

let queue: Promise<unknown> = Promise.resolve();

/** Renders are serialised: one Chrome at a time keeps memory and CPU bounded. */
export type RenderOptions = { full?: boolean; /** CSS selector or visible text to crop around in every view */ lookAt?: string };
export function renderCheck(deps: RenderDeps, options: RenderOptions = {}): Promise<RenderReport> {
  const run = queue.then(() => renderCheckNow(deps, options));
  queue = run.catch(() => undefined);
  return run;
}

async function renderCheckNow(deps: RenderDeps, options: RenderOptions): Promise<RenderReport> {
  const started = Date.now();
  const report: RenderReport = { available: true, errors: [], warnings: [], notes: [], shots: [], durationMs: 0 };
  const chrome = await findChrome();
  if (!chrome) return { ...report, available: false, reason: 'No Chrome/Chromium found on the server (set CHROME_PATH).', durationMs: 0 };

  const profile = await mkdtemp(path.join(tmpdir(), 'render-check-'));
  const child = spawn(
    chrome,
    ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--disable-background-networking', `--user-data-dir=${profile}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] },
  );
  const killer = setTimeout(() => child.kill('SIGKILL'), 45_000);

  const consoleErrors = new Set<string>();
  const blocked = new Set<string>();
  const missing = new Set<string>();
  try {
    const cdp = new Cdp(child);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId);
    await Promise.all([s('Page.enable'), s('Runtime.enable'), s('Log.enable'), s('Fetch.enable', { patterns: [{ urlPattern: '*' }] })]);

    let loaded: (() => void) | null = null;
    cdp.on(async (m) => {
      if (m.sessionId !== sessionId) return;
      if (m.method === 'Page.loadEventFired') loaded?.();
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.add(`JS error: ${m.params?.exceptionDetails?.exception?.description?.split('\n')[0] ?? m.params?.exceptionDetails?.text}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.add(`console.error: ${(m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 160)}`);
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error' && !/Failed to load resource/.test(m.params.entry.text)) consoleErrors.add(`log: ${String(m.params.entry.text).slice(0, 160)}`);
      if (m.method === 'Fetch.requestPaused') {
        const { requestId, request } = m.params as any;
        let url: URL;
        try { url = new URL(request.url); } catch { await s('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
        if (url.protocol === 'data:' || url.protocol === 'blob:') { await s('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
        if (url.origin === ORIGIN) {
          let rel = decodeURIComponent(url.pathname);
          if (rel.startsWith(deps.basePrefix)) rel = rel.slice(deps.basePrefix.length);
          rel = rel.replace(/^\/+/, '');
          if (rel === 'favicon.ico') { await s('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [], body: '' }).catch(() => {}); return; } // browsers ask for this on their own
          try {
            const served = rel === '' || rel === 'index.html' ? await deps.serveIndex() : await deps.serveFile(rel);
            const body = Buffer.isBuffer(served.body) ? served.body : Buffer.from(served.body);
            await s('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: served.contentType }, { name: 'Access-Control-Allow-Origin', value: '*' }], body: body.toString('base64') });
          } catch {
            missing.add(rel || '/');
            await s('Fetch.fulfillRequest', { requestId, responseCode: 404, responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }], body: Buffer.from('not found').toString('base64') }).catch(() => {});
          }
          return;
        }
        if (FONT_HOSTS.has(url.host)) { await s('Fetch.continueRequest', { requestId }).catch(() => {}); return; }
        blocked.add(url.host + url.pathname.slice(0, 40));
        await s('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      }
    });

    const probeScroll = `(async()=>{const h=document.documentElement.scrollHeight;for(let y=0;y<h;y+=500){scrollTo(0,y);await new Promise(r=>setTimeout(r,70));}scrollTo(0,0);await new Promise(r=>setTimeout(r,500));return 1})()`;
    async function load(url: string, width: number, mobile: boolean, dark: boolean) {
      await s('Emulation.setDeviceMetricsOverride', { width, height: mobile ? 812 : 800, deviceScaleFactor: 1, mobile });
      await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] });
      const done = new Promise<void>((resolve) => { loaded = resolve; setTimeout(resolve, 9000); });
      await s('Page.navigate', { url });
      await done;
      await sleep(700);
      if (dark) await s('Runtime.evaluate', { expression: "document.documentElement.classList.add('dark')" });
      await s('Runtime.evaluate', { expression: probeScroll, awaitPromise: true });
      await sleep(300);
    }
    async function measure() {
      const probe = JSON.parse((await s('Runtime.evaluate', { expression: PROBE, returnByValue: true })).result.value);
      const height = Math.min(Math.max(probe.scrollHeight, 400), 9000);
      const metrics = await s('Emulation.setDeviceMetricsOverride', { width: probe.vw, height, deviceScaleFactor: 1, mobile: probe.vw < 500 });
      void metrics;
      await sleep(350);
      const png = Buffer.from((await s('Page.captureScreenshot', { format: 'png', fromSurface: true })).data, 'base64');
      return { probe, png };
    }
    const shot = async (png: Buffer, label: string, top: number, width: number, maxH: number) => {
      const meta = await sharp(png).metadata();
      const h = Math.min(maxH, (meta.height ?? maxH) - top);
      const jpg = await sharp(png).extract({ left: 0, top, width: Math.min(width, meta.width ?? width), height: h }).resize({ width: Math.min(width, 1000) }).jpeg({ quality: 76 }).toBuffer();
      report.shots.push({ label, mimeType: 'image/jpeg', data: jpg.toString('base64') });
    };

    const home = `${ORIGIN}${deps.basePrefix}`;
    const passes: Array<{ name: string; width: number; mobile: boolean; dark: boolean }> = [
      { name: 'desktop 1280px', width: 1280, mobile: false, dark: false },
      { name: 'phone 375px', width: 375, mobile: true, dark: false },
      { name: 'desktop 1280px, dark mode', width: 1280, mobile: false, dark: true },
    ];
    for (const pass of passes) {
      await load(home, pass.width, pass.mobile, pass.dark);
      const { probe, png } = await measure();
      if (probe.scrollWidth > probe.vw + 1) report.errors.push(`${pass.name}: the page scrolls sideways (${probe.scrollWidth}px wide in a ${probe.vw}px window). Wide elements: ${probe.offenders.join(', ') || 'unknown'}.`);
      if (probe.broken.length) report.errors.push(`${pass.name}: images failed to load: ${[...new Set<string>(probe.broken)].slice(0, 5).join(', ')}.`);
      const contrast = await findLowContrast(png, probe.boxes as Box[]);
      if (contrast.invisible.length) {
        report.errors.push(`${pass.name}: INVISIBLE TEXT (text colour equals the colour behind it): ${contrast.invisible.slice(0, 6).map((b) => `"${b.text}" in ${b.sel} (contrast ${b.ratio.toFixed(2)}:1)`).join('; ')}. Look at the attached crop and fix the colours.`);
        for (const b of contrast.invisible.slice(0, 2)) {
          const top = Math.max(0, Math.round(b.y - 60));
          const left = Math.max(0, Math.round(b.x - 40));
          const crop = await sharp(png).extract({ left: Math.min(left, contrast.width - 20), top: Math.min(top, contrast.height - 20), width: Math.min(560, contrast.width - Math.min(left, contrast.width - 20)), height: Math.min(260, contrast.height - Math.min(top, contrast.height - 20)) }).jpeg({ quality: 80 }).toBuffer();
          report.shots.push({ label: `invisible text near ${b.sel} (${pass.name})`, mimeType: 'image/jpeg', data: crop.toString('base64') });
        }
      }
      if (contrast.low.length) report.warnings.push(`${pass.name}: low contrast text: ${contrast.low.slice(0, 5).map((b) => `"${b.text}" (${b.ratio.toFixed(1)}:1)`).join('; ')}.`);
      if (pass.mobile && probe.small.length) report.warnings.push(`${pass.name}: ${probe.small.length} tap targets under 44px, e.g. ${probe.small.slice(0, 4).join(', ')}.`);
      if (pass.name === 'desktop 1280px') {
        if (probe.h1 !== 1) report.warnings.push(`The page has ${probe.h1} h1 elements (expected 1).`);
        if (!probe.lang) report.warnings.push('The <html> element has no lang attribute.');
        if (probe.noAlt) report.warnings.push(`${probe.noAlt} image(s) have no alt attribute.`);
        if (probe.unnamed.length) report.warnings.push(`Links or buttons with no accessible name: ${probe.unnamed.slice(0, 4).join(', ')}.`);
        if (probe.dupIds.length) report.warnings.push(`Duplicate ids: ${[...new Set<string>(probe.dupIds)].join(', ')}.`);
        // axe-core: serious and critical violations
        try {
          const axeSource = await readFile(path.join(process.cwd(), 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
          await s('Runtime.evaluate', { expression: axeSource });
          const axe = JSON.parse((await s('Runtime.evaluate', { expression: "axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa']},resultTypes:['violations']}).then(r=>JSON.stringify(r.violations.filter(v=>v.impact==='serious'||v.impact==='critical').map(v=>({id:v.id,impact:v.impact,n:v.nodes.length,sample:(v.nodes[0]&&v.nodes[0].target||[]).join(' ')}))))", awaitPromise: true, returnByValue: true })).result.value);
          for (const v of axe) report.warnings.push(`axe ${v.impact}: ${v.id} (${v.n} element${v.n > 1 ? 's' : ''}, e.g. ${v.sample}).`);
        } catch {
          report.notes.push('axe-core check could not run.');
        }
      }
      const tileH = pass.mobile ? 812 : 800;
      await shot(png, `${pass.name}, top of page`, 0, pass.width, tileH);
      if (options.lookAt) {
        // Crop around the element the agent asked about (CSS selector, or the smallest element containing the text).
        const needle = JSON.stringify(options.lookAt.slice(0, 120));
        const found = JSON.parse((await s('Runtime.evaluate', { expression: `(() => { const q = ${needle}; let el = null; try { el = document.querySelector(q); } catch (e) {} if (!el) { const lower = q.toLowerCase(); let best = null; document.querySelectorAll('body *').forEach((e) => { const t = (e.textContent || '').toLowerCase(); if (t.includes(lower) && (!best || t.length < best.textContent.length)) best = e; }); el = best; } if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ top: r.top + scrollY, height: r.height, sel: el.tagName.toLowerCase() }); })()`, returnByValue: true })).result.value);
        if (found) {
          const total = contrast.height;
          const top = Math.max(0, Math.min(total - 40, Math.round(found.top - 180)));
          const height = Math.min(Math.max(480, Math.round(found.height + 360)), total - top, 900);
          await shot(png, `${pass.name}, around "${options.lookAt.slice(0, 40)}"`, top, pass.width, height);
        } else if (pass === passes[0]) {
          report.notes.push(`look_at "${options.lookAt.slice(0, 40)}" matched nothing on the page.`);
        }
      }
      if (options.full && !pass.dark) {
        // Walk the rest of the page too: middle and bottom, so the agent sees every section.
        const total = contrast.height;
        const offsets = total > tileH * 2.2 ? [Math.round((total - tileH) / 2), total - tileH] : total > tileH * 1.2 ? [total - tileH] : [];
        const names = offsets.length === 2 ? ['middle of page', 'bottom of page'] : ['bottom of page'];
        for (const [i, top] of offsets.entries()) await shot(png, `${pass.name}, ${names[i]}`, top, pass.width, tileH);
      }
      if (pass.mobile) report.notes.push(`phone page height ${probe.scrollHeight}px.`);
    }

    // other pages: load only, report errors
    for (const page of deps.pages.filter((p) => p !== 'index.html').slice(0, 3)) {
      await load(`${ORIGIN}${deps.basePrefix}${page}`, 1280, false, false);
      const { probe, png } = await measure();
      const contrast = await findLowContrast(png, probe.boxes as Box[]);
      if (contrast.invisible.length) report.errors.push(`${page}: INVISIBLE TEXT: ${contrast.invisible.slice(0, 4).map((b) => `"${b.text}" in ${b.sel}`).join('; ')}.`);
      if (probe.broken.length) report.errors.push(`${page}: images failed to load: ${probe.broken.slice(0, 3).join(', ')}.`);
      report.notes.push(`${page}: checked (no screenshot).`);
    }

    if (consoleErrors.size) report.errors.push(`Console errors: ${[...consoleErrors].slice(0, 5).join(' | ')}`);
    if (missing.size) report.errors.push(`Files requested by the page do not exist: ${[...missing].slice(0, 6).join(', ')}.`);
    if (blocked.size) report.errors.push(`Blocked external requests (only your own files and Google Fonts load): ${[...blocked].slice(0, 5).join(', ')}.`);
  } catch (error) {
    report.available = false;
    report.reason = `The render check failed to run: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(killer);
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    report.durationMs = Date.now() - started;
  }
  return report;
}
