'use server';

import { getCachedSession } from '@/lib/auth/cached';
import { codexAvailable, generateImage, sanitizeDescription } from '@/lib/images/generate';
import { ImageError, MAX_UPLOAD_BYTES, toSiteJpeg } from '@/lib/images/process';
import { SLOT_NAME } from '@/lib/images/slots';
import { writeProjectBinaryFile, artifactWorkspaceDir } from '@/lib/project-files';
import { getAccessibleProject } from '@/lib/projects/access';
import { createSnapshot } from '@/lib/projects/snapshots';
import { access } from 'node:fs/promises';
import path from 'node:path';

type Result = { ok: true; path: string; bytes: number; width: number; height: number } | { ok: false; error: string };

// At most 20 generations per user per hour (each uses the owner's Codex quota) and one at a time per user.
const generationLog = new Map<string, number[]>();
const generating = new Set<string>();

type Auth = { ok: false; error: string } | { ok: true; userId: string; artifactId: string };

async function authorize(projectId: string, artifactSlug: string): Promise<Auth> {
  const session = await getCachedSession();
  const userId = session?.user?.id;
  if (!userId) return { ok: false, error: 'You must be signed in.' };
  if (!SLOT_NAME.test(artifactSlug)) return { ok: false, error: 'Invalid artifact.' };
  const project = await getAccessibleProject(projectId, userId, {
    id: true,
    artifacts: { select: { id: true, slug: true } },
  });
  const artifact = project?.artifacts.find((a) => a.slug === artifactSlug);
  if (!project || !artifact) return { ok: false, error: 'Project not found.' };
  return { ok: true, userId, artifactId: artifact.id };
}

async function save(projectId: string, artifactSlug: string, artifactId: string, slot: string, buffer: Buffer, width: number, height: number): Promise<Result> {
  const relativePath = `images/${slot}.jpg`;
  const exists = await access(path.join(artifactWorkspaceDir(projectId, artifactSlug), relativePath)).then(() => true, () => false);
  if (exists) await createSnapshot(projectId, artifactSlug, `before replacing image ${slot}`).catch(() => null);
  const written = await writeProjectBinaryFile({ projectId, artifactSlug, artifactId, relativePath, content: buffer, mimeType: 'image/jpeg' });
  return { ok: true, path: written.relativePath, bytes: written.bytes, width, height };
}

export async function uploadImageAction(formData: FormData): Promise<Result> {
  const projectId = String(formData.get('projectId') ?? '');
  const artifactSlug = String(formData.get('artifactSlug') ?? '');
  const slot = String(formData.get('slot') ?? '');
  const file = formData.get('image');
  const auth = await authorize(projectId, artifactSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!SLOT_NAME.test(slot)) return { ok: false, error: 'Invalid image name.' };
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: 'Choose an image to upload.' };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: `Images must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.` };
  try {
    const processed = await toSiteJpeg(Buffer.from(await file.arrayBuffer()));
    return await save(projectId, artifactSlug, auth.artifactId, slot, processed.buffer, processed.width, processed.height);
  } catch (error) {
    return { ok: false, error: error instanceof ImageError ? error.message : 'The image could not be saved.' };
  }
}

export async function generateImageAction(projectId: string, artifactSlug: string, slot: string, description: string): Promise<Result> {
  const auth = await authorize(projectId, artifactSlug);
  if (!auth.ok) return { ok: false, error: auth.error };
  if (!SLOT_NAME.test(slot)) return { ok: false, error: 'Invalid image name.' };
  const clean = sanitizeDescription(description);
  if (clean.length < 10) return { ok: false, error: 'Describe the photo in a few words.' };
  if (!(await codexAvailable())) return { ok: false, error: 'Image generation is not available on this server (Codex is not installed or not signed in).' };
  if (generating.has(auth.userId)) return { ok: false, error: 'An image is already being generated. Wait for it to finish.' };
  const recent = (generationLog.get(auth.userId) ?? []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= 20) return { ok: false, error: 'Image generation limit reached for this hour.' };
  generating.add(auth.userId);
  try {
    recent.push(Date.now());
    generationLog.set(auth.userId, recent);
    const generated = await generateImage(clean);
    return await save(projectId, artifactSlug, auth.artifactId, slot, generated.buffer, generated.width, generated.height);
  } catch (error) {
    return { ok: false, error: error instanceof ImageError ? error.message : 'The image could not be generated.' };
  } finally {
    generating.delete(auth.userId);
  }
}
