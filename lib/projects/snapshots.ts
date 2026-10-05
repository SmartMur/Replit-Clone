import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { artifactWorkspaceDir, assertSafeId, getMimeType, isPathInside } from '@/lib/project-files';

/**
 * Point-in-time copies of an artifact's files, taken before an agent run changes an existing site.
 * Restoring takes a snapshot first, so a restore can itself be undone. Kept outside the workspace
 * and outside public/, so previews can never serve them.
 */
export const SNAPSHOT_ROOT = path.resolve(
  process.env.SNAPSHOT_ROOT || path.join(process.cwd(), '.data', 'snapshots'),
);
const KEEP = 25;
const MAX_BYTES = 250 * 1024 * 1024;
const SNAPSHOT_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

export type SnapshotMeta = { id: string; createdAt: string; reason: string; files: number; bytes: number };

function artifactSnapshotDir(projectId: string, artifactSlug: string) {
  return path.join(SNAPSHOT_ROOT, assertSafeId(projectId, 'project id'), assertSafeId(artifactSlug, 'artifact slug'));
}

async function walk(dir: string, prefix = ''): Promise<Array<{ rel: string; size: number }>> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ rel: string; size: number }> = [];
  for (const entry of entries) {
    if (entry.name === '.preview-bundle.js') continue; // regenerated build output
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else if (entry.isFile()) out.push({ rel, size: (await stat(full)).size });
  }
  return out;
}

function newId() {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `${stamp}-${Math.floor(Math.random() * 65536).toString(16).padStart(4, '0')}`;
}

/** Returns null when there is nothing to snapshot (empty workspace) or it is too large. */
export async function createSnapshot(projectId: string, artifactSlug: string, reason: string): Promise<SnapshotMeta | null> {
  const source = artifactWorkspaceDir(projectId, artifactSlug);
  const files = await walk(source);
  if (files.length === 0) return null;
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (bytes > MAX_BYTES) return null;

  const id = newId();
  const target = path.join(artifactSnapshotDir(projectId, artifactSlug), id);
  await mkdir(path.join(target, 'files'), { recursive: true });
  await cp(source, path.join(target, 'files'), { recursive: true, filter: (src) => path.basename(src) !== '.preview-bundle.js' });
  const meta: SnapshotMeta = { id, createdAt: new Date().toISOString(), reason: reason.slice(0, 200), files: files.length, bytes };
  await writeFile(path.join(target, 'meta.json'), JSON.stringify(meta, null, 2));
  await prune(projectId, artifactSlug);
  return meta;
}

export async function listSnapshots(projectId: string, artifactSlug: string): Promise<SnapshotMeta[]> {
  const dir = artifactSnapshotDir(projectId, artifactSlug);
  let ids: string[];
  try {
    ids = (await readdir(dir)).filter((n) => SNAPSHOT_ID.test(n));
  } catch {
    return [];
  }
  const metas: SnapshotMeta[] = [];
  for (const id of ids) {
    try {
      metas.push(JSON.parse(await readFile(path.join(dir, id, 'meta.json'), 'utf8')) as SnapshotMeta);
    } catch {
      // incomplete snapshot, ignore
    }
  }
  return metas.sort((a, b) => b.id.localeCompare(a.id));
}

async function prune(projectId: string, artifactSlug: string) {
  const metas = await listSnapshots(projectId, artifactSlug);
  for (const old of metas.slice(KEEP)) {
    await rm(path.join(artifactSnapshotDir(projectId, artifactSlug), old.id), { recursive: true, force: true });
  }
}

/**
 * Replace the artifact's files with a snapshot's. A snapshot of the current state is taken first,
 * so the restore can be undone. Returns the id of that safety snapshot (null if there was nothing).
 */
export async function restoreSnapshotFiles(projectId: string, artifactSlug: string, id: string) {
  if (!SNAPSHOT_ID.test(id)) throw new Error('Invalid snapshot id.');
  const dir = path.join(artifactSnapshotDir(projectId, artifactSlug), id);
  const source = path.join(dir, 'files');
  if (!isPathInside(artifactSnapshotDir(projectId, artifactSlug), dir) || !(await stat(source).catch(() => null))) {
    throw new Error('Snapshot not found.');
  }
  const safety = await createSnapshot(projectId, artifactSlug, `before restoring ${id}`);
  const workspace = artifactWorkspaceDir(projectId, artifactSlug);
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  await cp(source, workspace, { recursive: true });
  return { safetySnapshot: safety?.id ?? null };
}

/** Make the project_files table match what is on disk (after a restore). */
export async function syncProjectFilesFromDisk(projectId: string, artifactSlug: string) {
  const { prisma } = await import('@/lib/prisma');
  const workspace = artifactWorkspaceDir(projectId, artifactSlug);
  const files = await walk(workspace);
  const artifact = await prisma.artifact.findFirst({ where: { projectId, slug: artifactSlug }, select: { id: true } });
  const present = new Set(files.map((f) => `${artifactSlug}/${f.rel}`));
  const existing = await prisma.projectFile.findMany({ where: { projectId, path: { startsWith: `${artifactSlug}/` } }, select: { path: true } });
  const stale = existing.filter((row) => !present.has(row.path)).map((row) => row.path);
  if (stale.length) await prisma.projectFile.deleteMany({ where: { projectId, path: { in: stale } } });
  for (const file of files) {
    const dbPath = `${artifactSlug}/${file.rel}`;
    const data = { artifactId: artifact?.id ?? null, storageKey: `workspace/${projectId}/${dbPath}`, mimeType: getMimeType(file.rel), sizeBytes: file.size };
    await prisma.projectFile.upsert({ where: { projectId_path: { projectId, path: dbPath } }, create: { projectId, path: dbPath, ...data }, update: data });
  }
  return { files: files.length, removedRows: stale.length };
}
