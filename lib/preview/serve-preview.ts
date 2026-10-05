import { access, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  buildBundledPreviewHtml,
  bundleArtifact,
  invalidateBundleCache,
} from '@/lib/preview/bundle-artifact';
import { resolveProjectStack } from '@/lib/preview/detect-preview-mode';
import { formatBundleError } from '@/lib/preview/format-bundle-error';
import { artifactWorkspaceDir } from '@/lib/preview/list-workspace-paths';
import { buildPreviewErrorHtml } from '@/lib/preview/preview-error-html';
import {
  getMimeType,
  injectPreviewBaseHref,
  isPathInside,
  stripPreviewBaseHref,
} from '@/lib/project-files';

export async function serveArtifactIndex(
  projectId: string,
  artifactSlug: string,
) {
  const { stack, relativePaths } = await resolveProjectStack(
    projectId,
    artifactSlug,
  );

  if (stack !== 'static') {
    invalidateBundleCache(projectId, artifactSlug);
    try {
      await bundleArtifact({ projectId, artifactSlug, relativePaths, stack });
      const html = await buildBundledPreviewHtml({
        projectId,
        artifactSlug,
        bundleUrl: '.preview-bundle.js',
        stack,
      });
      return {
        body: html,
        contentType: getMimeType('index.html'),
      };
    } catch (error) {
      const label =
        stack === 'esbuild-react'
          ? 'The React preview failed to bundle. Ask Agent to fix missing files or imports.'
          : 'The preview failed to bundle. Ask Agent to fix missing files or imports.';
      return {
        body: buildPreviewErrorHtml(label, formatBundleError(error)),
        contentType: getMimeType('index.html'),
      };
    }
  }

  const absolute = path.join(
    artifactWorkspaceDir(projectId, artifactSlug),
    'index.html',
  );
  try {
    await access(absolute);
  } catch {
    return {
      body: buildPreviewErrorHtml(
        'No preview available yet.',
        'This artifact is missing index.html. Ask Agent to create an entry file.',
      ),
      contentType: getMimeType('index.html'),
    };
  }

  const content = await readFile(absolute, 'utf8');
  const html = injectPreviewBaseHref(content, projectId, artifactSlug);
  return {
    body: html,
    contentType: getMimeType('index.html'),
  };
}

export async function serveArtifactFile(
  projectId: string,
  artifactSlug: string,
  relativePath: string,
  options?: { forDownload?: boolean },
) {
  if (relativePath === '.preview-bundle.js') {
    const { stack, relativePaths } = await resolveProjectStack(
      projectId,
      artifactSlug,
    );
    try {
      const bundleJs = await bundleArtifact({
        projectId,
        artifactSlug,
        relativePaths,
        stack,
      });
      return {
        body: bundleJs,
        contentType: 'text/javascript; charset=utf-8',
      };
    } catch (error) {
      const details = formatBundleError(error);
      return {
        body: `throw new Error(${JSON.stringify(details)});`,
        contentType: 'text/javascript; charset=utf-8',
      };
    }
  }

  const workspaceRoot = artifactWorkspaceDir(projectId, artifactSlug);
  const absolute = path.resolve(workspaceRoot, relativePath);

  if (!isPathInside(workspaceRoot, absolute)) {
    throw new Error('Invalid path.');
  }

  const fileStat = await stat(absolute);
  if (!fileStat.isFile()) {
    throw new Error('Not a file.');
  }

  const content = await readFile(absolute);
  const mimeType = getMimeType(relativePath);

  if (mimeType.startsWith('text/html')) {
    const rawHtml = content.toString('utf8');
    return {
      body: options?.forDownload
        ? stripPreviewBaseHref(rawHtml)
        : injectPreviewBaseHref(rawHtml, projectId, artifactSlug),
      contentType: mimeType,
    };
  }

  return {
    body: content,
    contentType: mimeType,
  };
}
