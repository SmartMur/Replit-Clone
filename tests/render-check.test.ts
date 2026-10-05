import { describe, expect, test } from 'bun:test';
import { renderCheck, type RenderDeps } from '../lib/preview/render-check';

function page(html: string, files: Record<string, string> = {}): RenderDeps {
  return {
    serveIndex: async () => ({ body: html, contentType: 'text/html; charset=utf-8' }),
    serveFile: async (rel) => {
      if (rel in files) return { body: files[rel], contentType: 'text/css' };
      throw new Error('missing');
    },
    pages: ['index.html'],
    basePrefix: '/',
  };
}
const doc = (css: string, body: string, head = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title><style>body{margin:0;font:16px sans-serif;background:#fff;color:#111}${css}</style>${head}</head><body><main><h1>Title</h1>${body}</main></body></html>`;

const run = (html: string) => renderCheck(page(html));

describe('renderCheck (headless Chrome)', () => {
  test('a good page has no errors and returns screenshots', async () => {
    const r = await run(doc('.btn{display:inline-block;background:#0072bc;color:#fff;padding:12px 20px}', '<a class="btn" href="#x">Book now</a><p>Plain readable text.</p>'));
    if (!r.available) return console.warn('Chrome unavailable, skipped');
    expect(r.errors).toEqual([]);
    expect(r.shots.length).toBeGreaterThanOrEqual(3);
    expect(Buffer.from(r.shots[0].data, 'base64').subarray(0, 3).toString('hex')).toBe('ffd8ff'); // JPEG
  }, 60000);

  test('white text on a white card inside a blue band is flagged invisible (the bug Lighthouse missed)', async () => {
    const r = await run(doc('.band{background:#0072bc;padding:24px}.band a{color:#fff}.card{background:#fff;padding:16px}', '<div class="band"><div class="card">See the <a href="#p">privacy notice</a>.</div></div>'));
    if (!r.available) return;
    expect(r.errors.join(' ')).toContain('INVISIBLE TEXT');
    expect(r.errors.join(' ')).toContain('privacy notice');
    expect(r.shots.some((s) => s.label.startsWith('invisible text'))).toBe(true);
  }, 60000);

  test('white button label on a white button is flagged', async () => {
    const r = await run(doc('.b{display:inline-block;background:#fff;color:#fff;padding:12px 20px;border:1px solid #ccc}', '<a class="b" href="#x">Meet your companion</a>'));
    if (!r.available) return;
    expect(r.errors.join(' ')).toContain('Meet your companion');
  }, 60000);

  test('sideways scrolling at phone width is an error', async () => {
    const r = await run(doc('.wide{width:900px;height:20px;background:#ddd}', '<div class="wide"></div>'));
    if (!r.available) return;
    expect(r.errors.join(' ')).toContain('scrolls sideways');
  }, 60000);

  test('remote images are blocked and reported; local missing images fail', async () => {
    const r = await run(doc('', '<img src="https://images.unsplash.com/x.jpg" alt="x" width="100" height="50"><img src="nope.jpg" alt="y" width="100" height="50">'));
    if (!r.available) return;
    const all = r.errors.join(' ');
    expect(all).toContain('Blocked external requests');
    expect(all).toContain('nope.jpg');
  }, 60000);

  test('uncaught JavaScript errors are reported', async () => {
    const r = await run(doc('', '<p>x</p><script>throw new Error("boom")</script>'));
    if (!r.available) return;
    expect(r.errors.join(' ')).toContain('boom');
  }, 60000);
});

describe('look_at', () => {
  test('returns crops around the requested text in every view, and reports a miss', async () => {
    const filler = Array.from({ length: 30 }, (_, i) => `<p>Filler paragraph number ${i} with some words to push content down the page.</p>`).join('');
    const html = doc('', `${filler}<p id="target">Open seven days a week</p>${filler}`);
    const r = await renderCheck(page(html), { lookAt: 'Open seven days a week' });
    if (!r.available) return;
    const labels = r.shots.map((s) => s.label);
    expect(labels.filter((l) => l.includes('around "Open seven days a week"')).length).toBe(3);
    const miss = await renderCheck(page(html), { lookAt: 'no such text anywhere' });
    expect(miss.notes.join(' ')).toContain('matched nothing');
  }, 90000);
});
