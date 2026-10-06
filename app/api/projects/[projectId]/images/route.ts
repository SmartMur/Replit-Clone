import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { listImageSlots, SLOT_NAME } from '@/lib/images/slots';
import { getAccessibleProject } from '@/lib/projects/access';

export async function GET(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { projectId } = await context.params;
  const artifactSlug = new URL(request.url).searchParams.get('artifact') ?? 'main';
  if (!SLOT_NAME.test(artifactSlug)) return NextResponse.json({ error: 'Invalid artifact' }, { status: 400 });

  const project = await getAccessibleProject(projectId, userId, { id: true, artifacts: { select: { slug: true } } });
  if (!project || !project.artifacts.some((a) => a.slug === artifactSlug)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ slots: await listImageSlots(projectId, artifactSlug) });
}
