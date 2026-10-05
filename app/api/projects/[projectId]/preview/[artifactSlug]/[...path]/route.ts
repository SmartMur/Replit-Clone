import { headers } from 'next/headers';
import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth';
import { authorizePreviewAccess } from '@/lib/preview/access';
import { serveArtifactFile } from '@/lib/preview/serve-preview';
import { normalizeRelativePath } from '@/lib/project-files';

async function getSessionUserId() {
  const session = await auth.api.getSession({ headers: await headers() });
  return session?.user?.id ?? null;
}

export async function GET(
  request: Request,
  context: {
    params: Promise<{
      projectId: string;
      artifactSlug: string;
      path?: string[];
    }>;
  },
) {
  const userId = await getSessionUserId();
  const {
    projectId,
    artifactSlug,
    path: pathSegments = [],
  } = await context.params;
  const access = await authorizePreviewAccess(projectId, userId);

  if (!access.allowed) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const relativePath =
    pathSegments.length > 0
      ? pathSegments.map(normalizeRelativePath).join('/')
      : 'index.html';

  const download = new URL(request.url).searchParams.get('download') === '1';
  const fileName = relativePath.split('/').pop() ?? 'download';
  const safeFileName = fileName.replace(/[^\w.\-() ]+/g, '_') || 'download';

  try {
    const served = await serveArtifactFile(
      projectId,
      artifactSlug,
      relativePath,
      {
        forDownload: download,
      },
    );
    return new NextResponse(served.body, {
      headers: {
        'Content-Type': served.contentType,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...(download
          ? {
              'Content-Disposition': `attachment; filename="${safeFileName}"`,
            }
          : {}),
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found.' }, { status: 404 });
  }
}
