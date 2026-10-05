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
import { composeDesignCss } from '@/lib/preview/design-css';
import { buildPreviewErrorHtml } from '@/lib/preview/preview-error-html';
import {
  getMimeType,
  injectPreviewBaseHref,
  isPathInside,
  stripPreviewBaseHref,
} from '@/lib/project-files';

const DESIGN_SYSTEM_LINK =
  /<link\b[^>]*href=["']design-system\.css["'][^>]*>/i;
const TAILWIND_RUNTIME_PATH = '.runtime/tailwind.js';
let tailwindRuntimeCache: string | null = null;

async function readTailwindRuntime() {
  if (!tailwindRuntimeCache) {
    const resolved = path.join(
      process.cwd(),
      'node_modules',
      '@tailwindcss',
      'browser',
      'dist',
      'index.global.js',
    );
    tailwindRuntimeCache = await readFile(resolved, 'utf8');
  }
  return tailwindRuntimeCache;
}

/**
 * bm-design-system output is Tailwind v4 CSS (@theme, @apply). The browser build of Tailwind
 * only reads inline <style type="text/tailwindcss">, so swap the stylesheet link for the
 * runtime plus the CSS inlined. The runtime comes from our own origin, not a CDN.
 */
async function applyDesignSystem(
  html: string,
  workspaceRoot: string,
  inlineRuntime: boolean,
) {
  if (!DESIGN_SYSTEM_LINK.test(html)) return html;
  const composed = await composeDesignCss(workspaceRoot);
  if (composed.css === null) return html;

  const runtime = inlineRuntime
    ? `<script>${(await readTailwindRuntime()).replace(/<\/script/gi, '<\\/script')}</script>`
    : `<script src="${TAILWIND_RUNTIME_PATH}"></script>`;
  // The browser runtime defines no utilities unless the stylesheet imports Tailwind itself.
  const source = /@import\s+["']tailwindcss/.test(composed.css)
    ? composed.css
    : `@import "tailwindcss";\n${composed.css}`;
  const note = composed.siteError
    ? `<!-- site.css ignored: ${composed.siteError.replace(/--+/g, '-').replace(/\n/g, ' ')} -->\n`
    : '';
  const style = `${note}<style type="text/tailwindcss">\n${source.replace(/<\/style/gi, '<\\/style')}\n</style>`;
  return html.replace(DESIGN_SYSTEM_LINK, () => `${runtime}\n${style}`);
}

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
  const html = injectPreviewBaseHref(
    await applyDesignSystem(
      content,
      artifactWorkspaceDir(projectId, artifactSlug),
      false,
    ),
    projectId,
    artifactSlug,
  );
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

  // The Tailwind browser runtime resolves @import "tailwindcss..." itself, but the page also
  // makes a stray request for these virtual paths. Answer with an empty stylesheet so the
  // console stays clean; styling is unaffected.
  if (/^tailwindcss(\/(theme|preflight|utilities)\.css)?$/.test(relativePath)) {
    return {
      body: '/* provided by the Tailwind browser runtime */',
      contentType: 'text/css; charset=utf-8',
    };
  }

  if (relativePath === TAILWIND_RUNTIME_PATH) {
    return {
      body: await readTailwindRuntime(),
      contentType: 'text/javascript; charset=utf-8',
    };
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
    const rawHtml = await applyDesignSystem(
      content.toString('utf8'),
      workspaceRoot,
      Boolean(options?.forDownload),
    );
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
