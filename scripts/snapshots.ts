// Usage: bun run scripts/snapshots.ts <list|create|restore> <projectId> <artifactSlug> [snapshotId]
import { createSnapshot, listSnapshots, restoreSnapshotFiles, syncProjectFilesFromDisk } from '../lib/projects/snapshots';

const [command, projectId, slug, id] = process.argv.slice(2);
if (!command || !projectId || !slug) {
  console.error('usage: snapshots.ts <list|create|restore> <projectId> <artifactSlug> [snapshotId]');
  process.exit(2);
}
if (command === 'list') {
  const metas = await listSnapshots(projectId, slug);
  if (!metas.length) console.log('no snapshots');
  for (const m of metas) console.log(`${m.id}  ${m.createdAt}  ${m.files} files  ${(m.bytes / 1024).toFixed(0)}KB  ${m.reason}`);
} else if (command === 'create') {
  const meta = await createSnapshot(projectId, slug, 'manual snapshot');
  console.log(meta ? `created ${meta.id} (${meta.files} files)` : 'nothing to snapshot');
} else if (command === 'restore') {
  if (!id) { console.error('restore needs a snapshot id (see list)'); process.exit(2); }
  const { safetySnapshot } = await restoreSnapshotFiles(projectId, slug, id);
  const sync = await syncProjectFilesFromDisk(projectId, slug);
  console.log(`restored ${id}. Safety snapshot of the previous state: ${safetySnapshot ?? 'none (workspace was empty)'}. Database rows synced (${sync.files} files, ${sync.removedRows} stale rows removed).`);
  process.exit(0);
} else {
  console.error(`unknown command ${command}`);
  process.exit(2);
}
