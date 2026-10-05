import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let snap: typeof import('../lib/projects/snapshots');
let wsDir: (projectId: string, slug: string) => string;

beforeAll(async () => {
  const ws = await mkdtemp(path.join(tmpdir(), 'ws-'));
  const snapRoot = await mkdtemp(path.join(tmpdir(), 'snap-'));
  process.env.PROJECT_WORKSPACE_ROOT = ws; // only takes effect if no other test file imported project-files first
  process.env.SNAPSHOT_ROOT = snapRoot;
  snap = await import('../lib/projects/snapshots');
  // Use whatever workspace root the module resolved, so the suite passes alone or alongside other files.
  wsDir = (await import('../lib/project-files')).artifactWorkspaceDir;
});

afterAll(async () => {
  // Remove every fixture this file created, wherever the workspace root resolved to.
  for (const id of ['p1', 'p-prune', 'p-empty']) await rm(path.dirname(wsDir(id, 'main')), { recursive: true, force: true });
});

async function seed(files: Record<string, string>, projectId = 'p1') {
  const dir = wsDir(projectId, 'main');
  await mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), content);
  }
  return dir;
}

describe('snapshots', () => {
  test('an empty workspace has nothing to snapshot', async () => {
    expect(await snap.createSnapshot('p-empty', 'main', 'x')).toBeNull();
  });

  test('create, change, restore: the original comes back and the restore itself is undoable', async () => {
    const dir = await seed({ 'index.html': 'v1', 'images/a.jpg': 'img1' });
    const first = await snap.createSnapshot('p1', 'main', 'before change');
    expect(first?.files).toBe(2);

    await writeFile(path.join(dir, 'index.html'), 'v2 BROKEN');
    await writeFile(path.join(dir, 'extra.txt'), 'new file');

    const { safetySnapshot } = await snap.restoreSnapshotFiles('p1', 'main', first!.id);
    expect(await readFile(path.join(dir, 'index.html'), 'utf8')).toBe('v1');
    expect((await readdir(dir)).includes('extra.txt')).toBe(false); // files added after the snapshot are removed
    expect(await readFile(path.join(dir, 'images/a.jpg'), 'utf8')).toBe('img1');
    expect(safetySnapshot).toBeTruthy();

    // undo the restore using the safety snapshot
    await snap.restoreSnapshotFiles('p1', 'main', safetySnapshot!);
    expect(await readFile(path.join(dir, 'index.html'), 'utf8')).toBe('v2 BROKEN');
    expect(await readFile(path.join(dir, 'extra.txt'), 'utf8')).toBe('new file');
  });

  test('list is newest first', async () => {
    await seed({ 'index.html': 'x' });
    const a = await snap.createSnapshot('p1', 'main', 'a');
    await new Promise((r) => setTimeout(r, 1100));
    const b = await snap.createSnapshot('p1', 'main', 'b');
    const list = await snap.listSnapshots('p1', 'main');
    expect(list.findIndex((m) => m.id === b!.id)).toBeLessThan(list.findIndex((m) => m.id === a!.id));
  });

  test('bad ids and traversal are refused', async () => {
    for (const bad of ['../../etc', '..', 'x/y', '20260101-000000-zzzz', '']) {
      await expect(snap.restoreSnapshotFiles('p1', 'main', bad)).rejects.toThrow();
    }
    await expect(snap.createSnapshot('../escape', 'main', 'x')).rejects.toThrow();
    await expect(snap.createSnapshot('p1', '../x', 'x')).rejects.toThrow();
  });

  test('only the newest 25 snapshots are kept', async () => {
    await seed({ 'index.html': 'prune' }, 'p-prune');
    for (let i = 0; i < 27; i++) await snap.createSnapshot('p-prune', 'main', `n${i}`);
    expect((await snap.listSnapshots('p-prune', 'main')).length).toBeLessThanOrEqual(25);
  }, 120000);
});
