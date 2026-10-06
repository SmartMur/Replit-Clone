import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { ImageError, toSiteJpeg } from '@/lib/images/process';

/**
 * Image generation through Codex's native image tool, using the owner's Codex login (no API key).
 *
 * Hardened on purpose: the prompt comes from an AI agent (and indirectly from user attachments),
 * so Codex runs with its shell tool DISABLED and a read-only sandbox, ignoring user config, with no
 * session saved. The only thing it can do is generate an image. The finished PNG is collected from
 * Codex's own output folder by thread id; Codex never writes into our workspace.
 */
const CODEX = process.env.CODEX_PATH || 'codex';
const TIMEOUT_MS = 240_000;
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function sanitizeDescription(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
}

export function buildImagePrompt(description: string) {
  return [
    'Use your native image generation tool to create exactly ONE image. Do not run commands or read files.',
    `Subject: ${sanitizeDescription(description)}`,
    'Rules: no text, letters, logos or watermarks in the image; do not depict real, named or famous people; no brand marks; natural, believable composition; landscape 3:2 unless the subject clearly needs another shape.',
    'When the image is created, reply with only the word done.',
  ].join(' ');
}

export function codexArgs(cwd: string, prompt: string) {
  return ['exec', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--json', '-s', 'read-only', '--disable', 'shell_tool', '-C', cwd, prompt];
}

let active = 0;
const waiting: Array<() => void> = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = Number(process.env.IMAGE_GEN_CONCURRENCY ?? 2);
  if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** Only what Codex needs to find its login; none of the app's secrets. */
function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'CODEX_HOME'] as const;
  return Object.fromEntries(keep.flatMap((key) => (process.env[key] ? [[key, process.env[key]]] : []))) as NodeJS.ProcessEnv;
}

export function codexHome() {
  return process.env.CODEX_HOME || path.join(homedir(), '.codex');
}

export async function codexAvailable() {
  return new Promise<boolean>((resolve) => {
    const child = spawn(CODEX, ['--version'], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

export async function generateImage(description: string) {
  return slot(async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), 'imggen-'));
    let threadId = '';
    let lastMessage = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(CODEX, codexArgs(cwd, buildImagePrompt(description)), {
          stdio: ['ignore', 'pipe', 'ignore'],
          env: minimalEnv(),
        });
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ImageError('Image generation timed out.')); }, TIMEOUT_MS);
        let buffer = '';
        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();
          let nl: number;
          while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl);
            buffer = buffer.slice(nl + 1);
            try {
              const event = JSON.parse(line);
              if (event.type === 'thread.started' && THREAD_ID.test(event.thread_id)) threadId = event.thread_id;
              if (event.type === 'item.completed' && event.item?.type === 'agent_message') lastMessage = String(event.item.text ?? '');
            } catch { /* not JSON */ }
          }
        });
        child.on('error', (error) => { clearTimeout(timer); reject(new ImageError(`Codex could not be started: ${error.message}`)); });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new ImageError(`Codex exited with code ${code}.`));
        });
      });
      if (!threadId) throw new ImageError('Codex did not report a session, so the image could not be found.');
      const dir = path.join(codexHome(), 'generated_images', threadId);
      const pngs = (await readdir(dir).catch(() => [])).filter((name) => name.endsWith('.png')).sort();
      if (!pngs.length) throw new ImageError(`No image was produced. ${lastMessage ? `Codex said: ${lastMessage.slice(0, 160)}` : ''}`.trim());
      const png = await readFile(path.join(dir, pngs[pngs.length - 1]));
      return await toSiteJpeg(png);
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => {});
      if (threadId) await rm(path.join(codexHome(), 'generated_images', threadId), { recursive: true, force: true }).catch(() => {});
    }
  });
}
