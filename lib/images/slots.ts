import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { artifactWorkspaceDir } from '@/lib/project-files';

export type ImageSlot = { slot: string; path: string; exists: boolean; referenced: boolean; bytes: number };

const IMAGE_REF = /(?:^|["'(\s,=])((?:\.\/)?images\/([a-z0-9][a-z0-9_-]{0,60})\.(?:jpe?g|png|webp|gif|avif))(?=["')\s,?#]|$)/gi;
export const SLOT_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** Images a site refers to (HTML, CSS, JS) plus any already in images/, with whether the file exists. */
export async function listImageSlots(projectId: string, artifactSlug: string): Promise<ImageSlot[]> {
  const root = artifactWorkspaceDir(projectId, artifactSlug);
  const present = new Map<string, number>();
  for (const entry of await readdir(path.join(root, 'images'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /\.(jpe?g|png|webp|gif|avif)$/i.test(entry.name)) {
      const bytes = (await readFile(path.join(root, 'images', entry.name)).catch(() => Buffer.alloc(0))).length;
      present.set(entry.name, bytes);
    }
  }
  const referenced = new Map<string, string>(); // file name -> slot
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !/\.(html?|css|js)$/i.test(entry.name)) continue;
    const text = await readFile(path.join(root, entry.name), 'utf8').catch(() => '');
    for (const match of text.matchAll(IMAGE_REF)) referenced.set(path.basename(match[1]), match[2].toLowerCase());
  }
  const slots = new Map<string, ImageSlot>();
  for (const [file, slot] of referenced) {
    slots.set(file, { slot, path: `images/${file}`, exists: present.has(file), referenced: true, bytes: present.get(file) ?? 0 });
  }
  for (const [file, bytes] of present) {
    if (!slots.has(file)) slots.set(file, { slot: file.replace(/\.[^.]+$/, ''), path: `images/${file}`, exists: true, referenced: false, bytes });
  }
  return [...slots.values()].sort((a, b) => Number(a.exists) - Number(b.exists) || a.slot.localeCompare(b.slot));
}
