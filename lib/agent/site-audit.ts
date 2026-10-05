import path from 'node:path';

import { composeDesignCss, compileTailwind } from '@/lib/preview/design-css';

export type AuditInput = {
  workspaceRoot: string;
  /** Artifact-relative file names that exist (any type, including binary). */
  fileNames: string[];
  /** Text content of html/css/js files by artifact-relative name. */
  texts: Record<string, string>;
};

export type AuditReport = { errors: string[]; warnings: string[] };

const SAMPLE_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /\b555[-. ]?\d{4}\b/g, what: 'fake phone number' },
  { re: /\b\d(?:\.\d)?\s?\/\s?5\b/g, what: 'invented star rating' },
  {
    re: /\b\d{2,3}(?:,\d{3})?\+?\s+(?:[A-Za-z-]+\s+){0,2}(?:families|clients|customers|seniors|caregivers|reviews|homes|visits|members|companies)\b/gi,
    what: 'invented count',
  },
  {
    re: /\b\d{1,3}%\s+(?:of\s+)?(?:clients|families|customers|satisfaction|satisfied|recommend)/gi,
    what: 'invented percentage',
  },
];

function stripSvgAndScripts(html: string) {
  return html
    .replace(/<svg[\s\S]*?<\/svg>/gi, '<svg/>')
    .replace(/<script[\s\S]*?<\/script>/gi, '<script/>')
    .replace(/<style[\s\S]*?<\/style>/gi, '<style/>');
}

function nearestOpenTag(html: string, index: number) {
  const before = html.slice(Math.max(0, index - 400), index);
  const tags = before.match(/<[a-zA-Z][^<>]*>/g);
  return tags ? tags[tags.length - 1] : '';
}

export function findUnmarkedSample(html: string) {
  const hits: string[] = [];
  const body = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, (m) =>
    ' '.repeat(m.length),
  );
  for (const { re, what } of SAMPLE_PATTERNS) {
    re.lastIndex = 0;
    for (const match of body.matchAll(re)) {
      const index = match.index ?? 0;
      // Skip matches inside a tag (attributes) — only visible text counts.
      const lastLt = body.lastIndexOf('<', index);
      const lastGt = body.lastIndexOf('>', index);
      if (lastLt > lastGt) continue;
      if (!/data-sample/.test(nearestOpenTag(body, index))) {
        hits.push(`"${match[0].trim()}" (${what})`);
      }
    }
  }
  return [...new Set(hits)];
}

function localRefs(html: string) {
  const refs: Array<{ ref: string; kind: 'src' | 'css' }> = [];
  for (const m of html.matchAll(/\b(?:src|poster|href)=["']([^"']+)["']/gi)) {
    refs.push({ ref: m[1], kind: 'src' });
  }
  for (const m of html.matchAll(/\bsrcset=["']([^"']+)["']/gi)) {
    for (const part of m[1].split(',')) refs.push({ ref: part.trim().split(/\s+/)[0], kind: 'src' });
  }
  for (const m of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    refs.push({ ref: m[1], kind: 'css' });
  }
  return refs;
}

function isLocalAsset(ref: string) {
  return (
    ref &&
    !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{\{)/i.test(ref) &&
    !ref.startsWith('.runtime/') &&
    /\.[a-z0-9]{2,5}(?:[?#].*)?$/i.test(ref) &&
    !/\.html?(?:[?#].*)?$/i.test(ref)
  );
}

export async function auditSite(input: AuditInput): Promise<AuditReport> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const names = new Set(input.fileNames);
  const htmlFiles = Object.keys(input.texts).filter((n) => /\.html?$/i.test(n));
  const html = htmlFiles.map((n) => input.texts[n]).join('\n');
  const visible = stripSvgAndScripts(html);

  // 1. CSS compiles, and site.css is isolated.
  const composed = await composeDesignCss(input.workspaceRoot);
  if (composed.baseError) errors.push(`design-system.css does not compile: ${composed.baseError}`);
  if (composed.siteError) {
    errors.push(
      `site.css does not compile and is being ignored (the page falls back to the plain design system): ${composed.siteError}. Common cause: @apply of a class that is not a real Tailwind utility; use plain CSS declarations for custom classes.`,
    );
  }

  // 2. Assets: local references must exist; remote images are not allowed.
  const missing = new Set<string>();
  const remote = new Set<string>();
  for (const name of Object.keys(input.texts)) {
    if (!/\.(html?|css)$/i.test(name)) continue;
    const dir = path.posix.dirname(name);
    for (const { ref, kind } of localRefs(input.texts[name])) {
      const isImage = /\.(png|jpe?g|webp|gif|avif|svg|ico)(?:[?#].*)?$/i.test(ref);
      if (/^(?:https?:)?\/\//i.test(ref)) {
        if (isImage) remote.add(ref);
        continue;
      }
      if (!isLocalAsset(ref)) continue;
      // design-system.css is virtual (composed by the preview server), not a workspace file.
      if (ref.split(/[?#]/)[0] === 'design-system.css' && !names.has('design-system.css')) continue;
      const clean = ref.split(/[?#]/)[0];
      const resolved = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
      if (!names.has(resolved) && !names.has(clean)) missing.add(`${clean} (in ${name}, ${kind})`);
    }
  }
  if (missing.size) errors.push(`Referenced files do not exist: ${[...missing].slice(0, 8).join('; ')}. Create them, or remove the references.`);
  if (remote.size) {
    errors.push(
      `Remote images cannot be verified or may be blocked: ${[...remote].slice(0, 5).join('; ')}. Use files under images/ or inline SVG.`,
    );
  }
  const jsMissing = new Set<string>();
  for (const name of Object.keys(input.texts)) {
    if (!/\.js$/i.test(name)) continue;
    for (const m of input.texts[name].matchAll(/["'`]((?:\.?\/)?images\/[\w./-]+\.(?:jpe?g|png|webp|gif|svg))["'`]/gi)) {
      const clean = m[1].replace(/^\.?\//, '');
      if (!names.has(clean)) jsMissing.add(clean);
    }
  }
  if (jsMissing.size) warnings.push(`script.js refers to files that do not exist (they will 404 in the console): ${[...jsMissing].slice(0, 8).join(', ')}.`);

  // 3. Unknown classes (typos, or classes invented without CSS).
  if (composed.css) {
    const classes = [
      ...new Set(
        [...html.matchAll(/\bclass=["']([^"']*)["']/gi)]
          .flatMap((m) => m[1].split(/\s+/))
          .filter((c) => c && !c.includes('{{')),
      ),
    ];
    const built = await compileTailwind(composed.css, classes);
    if (built.ok) {
      const extraCss = Object.keys(input.texts)
        .filter((n) => /\.css$/i.test(n) && n !== 'design-system.css' && n !== 'site.css')
        .map((n) => input.texts[n])
        .join('\n');
      const unknown = classes.filter((c) => {
        const escaped = c.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
        return !built.css.includes(`.${escaped}`) && !extraCss.includes(`.${c}`) && !/^(?:group|peer|dark|sr-only)$/.test(c);
      });
      if (unknown.length > 5) {
        errors.push(`${unknown.length} classes in the HTML have no CSS (typos or invented names): ${unknown.slice(0, 10).join(', ')}. Use design-system tokens/classes or define them in site.css.`);
      } else if (unknown.length) {
        warnings.push(`Classes with no CSS: ${unknown.join(', ')}.`);
      }
    }
  }

  // 4. Sample content must be marked.
  const unmarked = findUnmarkedSample(html);
  if (unmarked.length) {
    errors.push(
      `Invented content is not marked as sample: ${unmarked.slice(0, 6).join('; ')}. Remove it, or put data-sample on the element that contains it (the preview highlights it so the owner replaces it).`,
    );
  }

  // 5. Design-system discipline (warnings).
  const inlineStyles = (visible.match(/\sstyle=["']/g) ?? []).length;
  if (inlineStyles > 8) errors.push(`${inlineStyles} inline style attributes. Move them to site.css classes or use design-system tokens.`);
  else if (inlineStyles > 0) warnings.push(`${inlineStyles} inline style attribute(s); prefer tokens and site.css classes.`);
  const rawHex = (visible.match(/#[0-9a-fA-F]{6}\b/g) ?? []).length;
  if (rawHex > 3) warnings.push(`${rawHex} raw hex colours in the HTML; use colour tokens.`);
  if (htmlFiles.length && !/data-theme-toggle|bm-ds-theme[\s\S]{0,400}(?:setItem|toggle)|Toggle (?:dark|theme)/i.test(html + Object.values(input.texts).join('\n').slice(0, 60000))) {
    warnings.push('No light/dark theme toggle found; the design system supports it (data-theme-toggle button + script).');
  }
  for (const m of html.matchAll(/<dl\b[^>]*>([\s\S]*?)<\/dl>/gi)) {
    const rest = m[1].replace(/<dt\b[\s\S]*?<\/dt>|<dd\b[\s\S]*?<\/dd>/gi, '');
    if (/<(?:p|span|h[1-6]|ul|a|img)\b/i.test(rest)) {
      warnings.push('A <dl> has children other than <dt>/<dd> (inside div groups); this fails accessibility checks.');
      break;
    }
  }

  return { errors, warnings };
}
