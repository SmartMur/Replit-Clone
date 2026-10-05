import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { authorizePreviewAccess } from '@/lib/preview/access';
import { serveArtifactIndex } from '@/lib/preview/serve-preview';

async function getSessionUserId() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ projectId: string; artifactSlug: string }> },
) {
  const userId = await getSessionUserId();
  const { projectId, artifactSlug } = await context.params;
  const access = await authorizePreviewAccess(projectId, userId);

  if (!access.allowed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const served = await serveArtifactIndex(projectId, artifactSlug);
    return new NextResponse(served.body, {
      headers: {
        'Content-Type': served.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found.' }, { status: 404 });
  }
}
