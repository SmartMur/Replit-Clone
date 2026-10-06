'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { generateImageAction, uploadImageAction } from '@/lib/actions/images';
import type { AppProjectDetail } from '@/lib/app-types';
import { cn } from '@/lib/utils';

type Slot = { slot: string; path: string; exists: boolean; referenced: boolean; bytes: number };
type Notice = { slot: string; kind: 'ok' | 'error'; text: string };

const button =
  'shrink-0 rounded-md border border-app-border px-2 py-1 text-[10px] font-medium text-app-text-secondary transition-colors hover:bg-app-surface-hover hover:text-app-text disabled:cursor-not-allowed disabled:opacity-50';

export function ImageSlotsPanel({
  project,
  previewVersion,
  onChanged,
}: {
  project: AppProjectDetail;
  previewVersion: number;
  onChanged: () => void;
}) {
  const artifact = project.artifacts.find(
    (a) => a.type === 'WEB_APP' || a.type === 'MOBILE_APP' || a.type === 'DESIGN',
  );
  const slug = artifact?.slug;
  const [slots, setSlots] = useState<Slot[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafting, setDrafting] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [version, setVersion] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const pendingSlot = useRef<string>('');

  const refresh = useCallback(async () => {
    if (!slug) return;
    try {
      const response = await fetch(`/api/projects/${project.id}/images?artifact=${encodeURIComponent(slug)}`, { cache: 'no-store' });
      if (!response.ok) return;
      setSlots(((await response.json()) as { slots: Slot[] }).slots);
    } catch {
      // transient
    }
  }, [project.id, slug]);

  useEffect(() => {
    const timer = setTimeout(() => void refresh(), 10);
    return () => clearTimeout(timer);
  }, [refresh, previewVersion]);

  if (!slug) return null;

  async function afterChange(slot: string, text: string) {
    setNotice({ slot, kind: 'ok', text });
    setVersion((v) => v + 1);
    await refresh();
    onChanged();
  }

  async function upload(file: File) {
    const slot = pendingSlot.current;
    setBusy(slot);
    setNotice(null);
    const form = new FormData();
    form.set('projectId', project.id);
    form.set('artifactSlug', slug as string);
    form.set('slot', slot);
    form.set('image', file);
    const result = await uploadImageAction(form);
    setBusy(null);
    if (result.ok) await afterChange(slot, `Saved ${result.path} (${Math.round(result.bytes / 1024)} KB).`);
    else setNotice({ slot, kind: 'error', text: result.error });
  }

  async function generate(slot: string) {
    setBusy(slot);
    setNotice(null);
    const result = await generateImageAction(project.id, slug as string, slot, description);
    setBusy(null);
    if (result.ok) {
      setDrafting(null);
      setDescription('');
      await afterChange(slot, `Generated ${result.path} (${Math.round(result.bytes / 1024)} KB).`);
    } else setNotice({ slot, kind: 'error', text: result.error });
  }

  const missing = slots.filter((s) => s.referenced && !s.exists).length;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-app-text-muted">Images</h3>
        {missing > 0 ? (
          <span className="rounded-full bg-replit-orange/15 px-2 py-0.5 text-[10px] font-medium text-replit-orange">{missing} missing</span>
        ) : null}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/heic"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      {slots.length === 0 ? (
        <p className="rounded-lg border border-dashed border-app-border bg-app-surface/50 px-3 py-4 text-xs leading-relaxed text-app-text-muted">
          Photos your site uses will appear here. Upload your own, or generate one.
        </p>
      ) : (
        <ul className="space-y-2">
          {slots.map((s) => (
            <li key={s.path} className="rounded-lg border border-app-border-subtle bg-app-surface/70 p-2">
              <div className="flex items-center gap-2">
                {s.exists ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/projects/${project.id}/preview/${slug}/${s.path}?v=${previewVersion}-${version}`}
                    alt=""
                    className="h-10 w-14 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-10 w-14 shrink-0 items-center justify-center rounded border border-dashed border-replit-orange/50 text-[9px] text-replit-orange">
                    missing
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[11px] text-app-text" title={s.path}>{s.slot}</p>
                  <p className={cn('text-[10px]', s.exists ? 'text-app-text-muted' : 'text-replit-orange')}>
                    {busy === s.slot ? 'Working…' : s.exists ? `${Math.round(s.bytes / 1024)} KB` : 'Needs a photo'}
                  </p>
                </div>
                <button
                  type="button"
                  className={button}
                  disabled={busy !== null}
                  onClick={() => {
                    pendingSlot.current = s.slot;
                    fileInput.current?.click();
                  }}>
                  Upload
                </button>
                <button
                  type="button"
                  className={button}
                  disabled={busy !== null}
                  onClick={() => {
                    setDrafting(drafting === s.slot ? null : s.slot);
                    setNotice(null);
                  }}>
                  Generate
                </button>
              </div>

              {drafting === s.slot ? (
                <div className="mt-2 space-y-1.5">
                  <label className="sr-only" htmlFor={`desc-${s.slot}`}>Describe the photo</label>
                  <textarea
                    id={`desc-${s.slot}`}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    maxLength={400}
                    rows={3}
                    placeholder="Describe the photo, e.g. a caregiver and an older woman walking in a park in autumn"
                    className="w-full rounded-md border border-app-border bg-app-bg px-2 py-1.5 text-[11px] text-app-text placeholder:text-app-text-muted"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] text-app-text-muted">Takes about a minute.</span>
                    <button
                      type="button"
                      className={cn(button, 'border-replit-orange/50 text-replit-orange')}
                      disabled={busy !== null || description.trim().length < 10}
                      onClick={() => void generate(s.slot)}>
                      {busy === s.slot ? 'Generating…' : 'Generate photo'}
                    </button>
                  </div>
                </div>
              ) : null}

              {notice?.slot === s.slot ? (
                <p role="status" className={cn('mt-1.5 text-[10px]', notice.kind === 'error' ? 'text-replit-orange' : 'text-app-text-secondary')}>
                  {notice.text}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
