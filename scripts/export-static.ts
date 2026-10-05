// Production export for a static site built in the editor.
// Usage: bun run scripts/export-static.ts <projectDir> <outDir> [--origin https://example.com] [--no-fonts]
// - precompiles + minifies the design-system CSS (no Tailwind runtime in production)
// - self-hosts Inter + DM Sans (no Google Fonts request from visitors)
// - moves inline scripts to files so a strict Content-Security-Policy works
// - writes _headers, nginx-security.conf, robots.txt, 404.html, BUILD.json (+ sitemap.xml, canonical and social tags with --origin;
//   .well-known/security.txt with --security-contact)
// - REFUSES to export while any data-sample content remains (use --allow-samples only for rehearsals)
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { compileTailwind, composeDesignCss } from '../lib/preview/design-css';

const [srcDir, outDir] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const flag = (name: string) => process.argv.includes(name);
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
if (!srcDir || !outDir) {
  console.error('usage: export-static.ts <projectDir> <outDir> [--origin https://example.com] [--no-fonts]');
  process.exit(2);
}
const origin = arg('--origin')?.replace(/\/$/, '');
const securityContact = arg('--security-contact');
const sha = (s: string | Buffer, n = 10) => createHash('sha256').update(s).digest('hex').slice(0, n);

await rm(outDir, { recursive: true, force: true });
await mkdir(path.join(outDir, 'assets', 'fonts'), { recursive: true });

const names = await readdir(srcDir);
const htmlFiles = names.filter((n) => /\.html?$/i.test(n));
const htmls = Object.fromEntries(await Promise.all(htmlFiles.map(async (n) => [n, await readFile(path.join(srcDir, n), 'utf8')])));
const scriptNames = names.filter((n) => /\.js$/i.test(n));
const scripts = Object.fromEntries(await Promise.all(scriptNames.map(async (n) => [n, await readFile(path.join(srcDir, n), 'utf8')])));

// 0. launch gate: invented content must be replaced before production
const sampleHits = Object.entries(htmls).flatMap(([name, html]) => {
  const count = (html.match(/\sdata-sample\b/g) ?? []).length;
  return count ? [`${name}: ${count}`] : [];
});
if (sampleHits.length && !flag('--allow-samples')) {
  throw new Error(`Refusing to export: sample content is still marked data-sample (${sampleHits.join(', ')}). Replace it with real, verified content and remove the attribute, or pass --allow-samples for a rehearsal build.`);
}

// 1. candidates: every class token in the HTML plus every word in any JS string literal (safe superset)
const candidates = new Set<string>();
for (const html of Object.values(htmls)) {
  for (const m of html.matchAll(/\bclass=["']([^"']*)["']/g)) m[1].split(/\s+/).forEach((c) => c && candidates.add(c));
}
for (const js of Object.values(scripts)) {
  for (const m of js.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)) m[2].split(/\s+/).forEach((w) => w && w.length < 80 && candidates.add(w));
}

// 2. CSS
const composed = await composeDesignCss(srcDir);
if (composed.css === null) throw new Error('no design system CSS (site.css / design-system.css) in project');
if (composed.baseError || composed.siteError) throw new Error(`CSS does not compile: ${composed.baseError ?? composed.siteError}`);
const compiled = await compileTailwind(composed.css, [...candidates]);
if (!compiled.ok) throw new Error(`CSS compile failed: ${compiled.error}`);
let css = compiled.css;

// 3. fonts (latin subset only, self-hosted)
const fontPreloads: string[] = [];
if (!flag('--no-fonts')) {
  const gf = /fonts\.googleapis\.com\/css2\?[^"']+/.exec(Object.values(htmls).join('\n'))?.[0]?.replace(/&amp;/g, '&');
  if (gf) {
    const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const res = await fetch(`https://${gf}`, { headers: { 'user-agent': UA } });
    const faces = (await res.text()).split('@font-face').slice(1).map((b) => '@font-face' + b);
    let n = 0;
    for (const face of faces) {
      // Keep the latin subset only (identified by its unicode-range)
      if (!/unicode-range:\s*U\+0000-00FF/.test(face)) continue;
      const url = /url\((https:\/\/fonts\.gstatic\.com[^)]+\.woff2)\)/.exec(face)?.[1];
      if (!url) continue;
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      const file = `${sha(buf, 8)}.woff2`;
      await writeFile(path.join(outDir, 'assets', 'fonts', file), buf);
      const family = /font-family:\s*'([^']+)'/.exec(face)![1];
      const weight = /font-weight:\s*(\d+)/.exec(face)![1];
      css += `\n@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(fonts/${file}) format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`;
      if ((family === 'DM Sans' && weight === '400') || (family === 'Inter' && weight === '600')) fontPreloads.push(`assets/fonts/${file}`);
      n += 1;
    }
    console.log(`fonts: self-hosted ${n} latin faces`);
  }
}

const { transform } = await import('lightningcss');
const minified = transform({ filename: 'site.css', code: Buffer.from(css), minify: true }).code.toString();
const cssName = `site.${sha(minified)}.css`;
await writeFile(path.join(outDir, 'assets', cssName), minified);

// 4. HTML rewrite: stylesheet, fonts, inline scripts, comments
let inlineCount = 0;
const warnings: string[] = [];
for (const [name, original] of Object.entries(htmls)) {
  let html = original;
  html = html.replace(/<link\b[^>]*href=["']design-system\.css["'][^>]*>/i, `<link rel="stylesheet" href="assets/${cssName}">`);
  html = html.replace(/<link\b[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\s*/gi, '');
  html = html.replace(/<script>([\s\S]*?)<\/script>/gi, (_m, code: string) => {
    inlineCount += 1;
    const file = `inline-${sha(code)}.js`;
    void writeFile(path.join(outDir, 'assets', file), code.trim() + '\n');
    return `<script src="assets/${file}"></script>`;
  });
  html = html.replace(/<!--[\s\S]*?-->/g, '');
  if (fontPreloads.length) {
    const tags = fontPreloads.map((f) => `<link rel="preload" href="${f}" as="font" type="font/woff2" crossorigin>`).join('\n  ');
    html = html.replace(/<link rel="stylesheet" href="assets\//, `${tags}\n  <link rel="stylesheet" href="assets/`);
  }
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    if (!/data-endpoint="[^"]+"/.test(m[0])) warnings.push(`${name}: a form has no data-endpoint (submissions fall back to opening an email draft, which is not a real submission flow)`);
  }
  if (/\son[a-z]+=["']/i.test(html)) warnings.push(`${name}: inline event handler attributes (break strict CSP)`);
  if (/\sstyle=["']/i.test(html)) warnings.push(`${name}: inline style attributes (need style-src 'unsafe-inline')`);
  if (origin) {
    const url = `${origin}/${name === 'index.html' ? '' : name}`;
    const tags = [`<link rel="canonical" href="${url}">`, `<meta property="og:url" content="${url}">`];
    if (name === 'index.html' && names.includes('images')) {
      tags.push(`<meta property="og:image" content="${origin}/images/hero.jpg">`, `<meta name="twitter:image" content="${origin}/images/hero.jpg">`);
    }
    html = html.replace('</head>', `  ${tags.join('\n  ')}\n</head>`);
  }
  await writeFile(path.join(outDir, name), html.replace(/\n{3,}/g, '\n\n'));
}
await new Promise((r) => setTimeout(r, 50));

// 5. other files
for (const [name, js] of Object.entries(scripts)) await writeFile(path.join(outDir, name), js);
for (const n of names) {
  if (/\.(html?|js|css)$/i.test(n)) continue;
  await cp(path.join(srcDir, n), path.join(outDir, n), { recursive: true });
}
for (const [name, js] of Object.entries(scripts)) {
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  if (/\binnerHTML\b|\beval\(|document\.write|insertAdjacentHTML/.test(code)) warnings.push(`${name}: uses innerHTML/eval/document.write/insertAdjacentHTML (review for XSS)`);
}

// 6. security + crawl files
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; upgrade-insecure-requests";
const headers = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};
await writeFile(path.join(outDir, '_headers'),
  `/*\n${Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n\n/images/*\n  Cache-Control: public, max-age=2592000\n`);
await writeFile(path.join(outDir, 'nginx-security.conf'),
  `# include inside the server { } block of a TLS-enabled site\n${Object.entries(headers).map(([k, v]) => `add_header ${k} "${v}" always;`).join('\n')}\nlocation /assets/ { add_header Cache-Control "public, max-age=31536000, immutable"; ${Object.entries(headers).map(([k, v]) => `add_header ${k} "${v}" always;`).join(' ')} }\n`);
await writeFile(path.join(outDir, 'robots.txt'), `User-agent: *\nAllow: /\n${origin ? `Sitemap: ${origin}/sitemap.xml\n` : ''}`);
if (origin) {
  await writeFile(path.join(outDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${htmlFiles.map((f) => `  <url><loc>${origin}/${f === 'index.html' ? '' : f}</loc></url>`).join('\n')}\n</urlset>\n`);
}

// 6b. 404 page (reuses the home page head so styling and CSP match) and security.txt
const homeHtml = htmls['index.html'] ?? Object.values(htmls)[0];
if (homeHtml) {
  const head = (await readFile(path.join(outDir, htmls['index.html'] ? 'index.html' : htmlFiles[0]), 'utf8')).split('<body')[0]
    .replace(/<title>[^<]*<\/title>/, '<title>Page not found</title>')
    .replace(/<meta (?:name="description"|property="og:[^"]+"|name="twitter:[^"]+")[^>]*>\s*/g, '')
    .replace(/<link rel="(?:canonical|preload)"[^>]*>\s*/g, '')
    .replace('</head>', '  <meta name="robots" content="noindex">\n</head>');
  await writeFile(path.join(outDir, '404.html'), `${head}<body>\n  <main class="mx-auto max-w-xl px-5 py-24 text-center">\n    <h1>Page not found</h1>\n    <p class="mt-4">The page you were looking for does not exist.</p>\n    <p class="mt-6"><a class="btn btn-primary" href="/">Back to the home page</a></p>\n  </main>\n</body>\n</html>\n`);
}
if (securityContact) {
  await mkdir(path.join(outDir, '.well-known'), { recursive: true });
  const expires = new Date(Date.now() + 365 * 86400000).toISOString();
  await writeFile(path.join(outDir, '.well-known', 'security.txt'), `Contact: ${securityContact}\nExpires: ${expires}\nPreferred-Languages: en\n${origin ? `Canonical: ${origin}/.well-known/security.txt\n` : ''}`);
}

// 7. report
const all: Array<[string, number]> = [];
async function walk(dir: string, prefix = '') {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, `${prefix}${e.name}/`);
    else all.push([`${prefix}${e.name}`, (await stat(p)).size]);
  }
}
await walk(outDir);
const total = all.reduce((n, [, s]) => n + s, 0);
await writeFile(path.join(outDir, 'BUILD.json'), JSON.stringify({ builtAt: new Date().toISOString(), css: `assets/${cssName}`, cssBytes: minified.length, candidates: candidates.size, inlineScriptsExternalized: inlineCount, warnings, totalBytes: total, files: Object.fromEntries(all) }, null, 2));
console.log(`css: ${(minified.length / 1024).toFixed(1)}KB (was runtime ~275KB JS + ${(composed.css.length / 1024).toFixed(1)}KB source CSS)`);
console.log(`inline scripts externalized: ${inlineCount}; files: ${all.length}; total ${(total / 1024).toFixed(0)}KB`);
if (warnings.length) console.log('WARNINGS:\n' + warnings.map((w) => ' - ' + w).join('\n'));
