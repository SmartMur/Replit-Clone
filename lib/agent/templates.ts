import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Starter templates (templates/<id>/): static pages written with the bm-design-system
 * classes. Structures are modelled on buildermethods/build-new (app shell, auth shell,
 * page header, list rows); the files themselves are our own.
 */
const TEMPLATES_ROOT = path.join(process.cwd(), 'templates');

export type TemplateMeta = {
  id: string;
  name: string;
  description: string;
  bestFor: string;
  files: string[];
};

const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export async function listTemplates(): Promise<TemplateMeta[]> {
  const entries = await readdir(TEMPLATES_ROOT, { withFileTypes: true });
  const metas: TemplateMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try {
      const meta = JSON.parse(
        await readFile(path.join(TEMPLATES_ROOT, entry.name, 'template.json'), 'utf8'),
      ) as TemplateMeta;
      if (meta.id === entry.name) metas.push(meta);
    } catch {
      // skip folders without a valid template.json
    }
  }
  return metas.sort((a, b) => a.id.localeCompare(b.id));
}

export function formatTemplateList(metas: TemplateMeta[]) {
  return [
    'Templates (call use_template with template set to an id to start from one):',
    ...metas.map(
      (meta) =>
        `- ${meta.id}: ${meta.name}. ${meta.description} Best for: ${meta.bestFor}. Files: ${meta.files.join(', ')}`,
    ),
  ].join('\n');
}

export async function readTemplate(id: string) {
  if (!SAFE_ID.test(id)) return null;
  const meta = (await listTemplates()).find((candidate) => candidate.id === id);
  if (!meta) return null;

  const files: Record<string, string> = {};
  for (const file of meta.files) {
    // Only plain file names listed in template.json; never a path.
    if (file !== path.basename(file)) continue;
    files[file] = await readFile(path.join(TEMPLATES_ROOT, id, file), 'utf8');
  }
  return { meta, files };
}

export const PLACEHOLDER = /\{\{[^}]+\}\}/;
