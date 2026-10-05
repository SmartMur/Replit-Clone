import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { isPathInside, normalizeRelativePath } from '@/lib/project-files';

/**
 * Read-only access to the vendored bm-skills (vendor/bm-skills, pinned commit).
 * The agent can read instructions and templates but never execute anything.
 */
const SKILLS_ROOT = path.join(process.cwd(), 'vendor', 'bm-skills', 'skills');
const SKILL_NAMES = ['bm-design-system', 'bm-prd-creator', 'bm-favicon-creator'];
const READABLE_EXTENSIONS = new Set(['.md', '.css', '.html', '.txt']);
const MAX_CHARS = 40_000;

export const SKILL_INDEX = [
  '- bm-design-system: tokens, palette rules, CSS components and layout guardrails (the design engine for every site).',
  '- bm-prd-creator: how to turn an idea into a PRD (use to shape planning questions and the plan).',
  '- bm-favicon-creator: favicon guidance (no shell here: write a hand-made icon.svg only).',
].join('\n');

async function listReadableFiles(dir: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...(await listReadableFiles(path.join(dir, entry.name), relative)));
    } else if (READABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(relative);
    }
  }
  return out.sort();
}

export async function readSkill(skill: string, relativePath?: string) {
  if (!SKILL_NAMES.includes(skill)) {
    return `Unknown skill "${skill}". Available skills:\n${SKILL_INDEX}`;
  }

  const skillDir = path.join(SKILLS_ROOT, skill);

  if (!relativePath?.trim()) {
    const files = await listReadableFiles(skillDir);
    return `Files in ${skill} (call read_skill with a path to read one; SKILL.md is the entry point):\n${files.join('\n')}`;
  }

  const normalized = normalizeRelativePath(relativePath);
  const absolute = path.resolve(skillDir, normalized);
  if (
    !normalized ||
    !isPathInside(skillDir, absolute) ||
    !READABLE_EXTENSIONS.has(path.extname(absolute).toLowerCase())
  ) {
    return `Cannot read "${relativePath}". Only .md, .css, .html and .txt files inside the skill are readable.`;
  }

  try {
    if (!(await stat(absolute)).isFile()) return `"${relativePath}" is not a file.`;
    const text = await readFile(absolute, 'utf8');
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n… [truncated]`
      : text;
  } catch {
    return `File not found: ${skill}/${normalized}`;
  }
}

/** Raw template used to seed design-system.css in new site artifacts. */
export async function readDesignSystemTemplate() {
  return readFile(
    path.join(SKILLS_ROOT, 'bm-design-system', 'references', 'styles', 'design-system.css'),
    'utf8',
  );
}
