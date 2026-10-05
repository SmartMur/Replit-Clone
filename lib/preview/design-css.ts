import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { renderDesignSystemCss } from '@/lib/agent/skills-adapter';

/**
 * The design-system stylesheet is platform-managed: upstream CSS + accessibility overlay are
 * composed at serve time and are not editable by the agent. Custom CSS and brand token
 * overrides go in the artifact's site.css, which is compile-checked on its own so one bad rule
 * can never unstyle the page. Artifacts that already own a design-system.css keep working
 * unchanged ("legacy" mode).
 */
export const SITE_CSS = 'site.css';
export const DESIGN_SYSTEM_CSS_FILE = 'design-system.css';

type CompileResult =
  | { ok: true; css: string }
  | { ok: false; error: string };

const compileCache = new Map<string, CompileResult>();

export async function compileTailwind(
  source: string,
  candidates: string[] = [],
): Promise<CompileResult> {
  const key = createHash('sha1')
    .update(source)
    .update('\0')
    .update(candidates.join(' '))
    .digest('hex');
  const hit = compileCache.get(key);
  if (hit) return hit;

  let result: CompileResult;
  try {
    const { compile } = await import('@tailwindcss/node');
    const compiler = await compile(`@import "tailwindcss";\n${source}`, {
      base: process.cwd(),
      onDependency() {},
    });
    result = { ok: true, css: compiler.build(candidates) };
  } catch (error) {
    result = {
      ok: false,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 400),
    };
  }
  if (compileCache.size > 200) compileCache.clear();
  compileCache.set(key, result);
  return result;
}

async function readIfExists(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

export type ComposedDesignCss = {
  /** Base design system (+ site.css when it compiles). Null when the artifact has no site.css/legacy file. */
  css: string | null;
  legacy: boolean;
  hasSiteCss: boolean;
  siteError?: string;
  baseError?: string;
};

export async function composeDesignCss(
  workspaceRoot: string,
): Promise<ComposedDesignCss> {
  const legacy = await readIfExists(path.join(workspaceRoot, DESIGN_SYSTEM_CSS_FILE));
  const site = await readIfExists(path.join(workspaceRoot, SITE_CSS));

  if (legacy === null && site === null) {
    return { css: null, legacy: false, hasSiteCss: false };
  }

  const base = legacy ?? (await renderDesignSystemCss());
  const baseCheck = await compileTailwind(base);
  if (!baseCheck.ok) {
    return { css: base, legacy: legacy !== null, hasSiteCss: site !== null, baseError: baseCheck.error };
  }
  if (site === null) {
    return { css: base, legacy: legacy !== null, hasSiteCss: false };
  }

  const combined = `${base}\n/* ---- site.css ---- */\n${site}`;
  const check = await compileTailwind(combined);
  if (!check.ok) {
    return {
      css: base,
      legacy: legacy !== null,
      hasSiteCss: true,
      siteError: check.error,
    };
  }
  return { css: combined, legacy: legacy !== null, hasSiteCss: true };
}
