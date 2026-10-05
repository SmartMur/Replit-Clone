import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cssInjectPlugin } from '@/lib/preview/css-inject-plugin';
import {
  detectProjectStack,
  extractIndexBodyContent,
  extractIndexHeadContent,
  findBundleEntry,
  readArtifactIndexHtml,
  type ProjectStack,
} from '@/lib/preview/detect-preview-mode';
import { ensureReactEntryFiles } from '@/lib/preview/ensure-react-entry';
import { artifactWorkspaceDir } from '@/lib/preview/list-workspace-paths';
import { isPathInside } from '@/lib/project-files';
import type { Plugin } from 'esbuild';

type BundleCacheEntry = {
  bundleJs: string;
  fingerprint: string;
  builtAt: number;
};

const bundleCache = new Map<string, BundleCacheEntry>();

const REACT_ESM_IMPORT_MAP = {
  imports: {
    react: 'https://esm.sh/react@19?dev',
    'react-dom': 'https://esm.sh/react-dom@19?dev',
    'react-dom/client': 'https://esm.sh/react-dom@19/client?dev',
    'react/jsx-runtime': 'https://esm.sh/react@19/jsx-runtime?dev',
    'react-router-dom': 'https://esm.sh/react-router-dom@7?dev',
    'lucide-react': 'https://esm.sh/lucide-react?dev',
  },
};

/**
 * Keeps esbuild inside the artifact folder. Without this, `import '../../../x.json'`
 * or a bare package import can pull arbitrary host files into the served bundle.
 * Only the CDN-mapped packages (REACT_ESM_IMPORT_MAP) may stay external.
 */
function confineToWorkspacePlugin(root: string, externals: string[]): Plugin {
  const allowedExternal = new Set(externals);
  return {
    name: 'confine-to-workspace',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.confined) return undefined;
        if (allowedExternal.has(args.path)) {
          return { path: args.path, external: true };
        }
        if (args.kind === 'entry-point') return undefined;

        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          namespace: args.namespace,
          resolveDir: args.resolveDir,
          pluginData: { confined: true },
        });
        if (resolved.errors.length > 0) return resolved;
        if (!isPathInside(root, resolved.path)) {
          return {
            errors: [
              {
                text: `Import "${args.path}" resolves outside the project folder and is not allowed.`,
              },
            ],
          };
        }
        return resolved;
      });
    },
  };
}

function cacheKey(projectId: string, artifactSlug: string) {
  return `${projectId}:${artifactSlug}`;
}

async function fingerprintWorkspace(
  absoluteDir: string,
  relativePaths: string[],
) {
  const { readFile } = await import('node:fs/promises');
  const parts: string[] = [];
  for (const relativePath of relativePaths.sort()) {
    const absolute = path.join(absoluteDir, relativePath);
    try {
      const content = await readFile(absolute);
      parts.push(
        `${relativePath}:${content.length}:${content.toString('utf8').slice(0, 64)}`,
      );
    } catch {
      parts.push(`${relativePath}:missing`);
    }
  }
  return parts.join('|');
}

export async function bundleArtifact({
  projectId,
  artifactSlug,
  relativePaths,
  stack,
}: {
  projectId: string;
  artifactSlug: string;
  relativePaths: string[];
  stack?: ProjectStack;
}) {
  const absoluteDir = artifactWorkspaceDir(projectId, artifactSlug);
  const key = cacheKey(projectId, artifactSlug);
  const indexHtml = await readArtifactIndexHtml(projectId, artifactSlug);
  const resolvedStack = stack ?? detectProjectStack(relativePaths, indexHtml);

  let pathsToBundle = relativePaths;
  if (resolvedStack === 'esbuild-react') {
    pathsToBundle = await ensureReactEntryFiles(absoluteDir, relativePaths, {
      projectId,
      artifactSlug,
    });
  }

  const fingerprint = await fingerprintWorkspace(absoluteDir, pathsToBundle);
  const cached = bundleCache.get(key);

  if (cached && cached.fingerprint === fingerprint) {
    return cached.bundleJs;
  }

  const entry = findBundleEntry(pathsToBundle, resolvedStack, indexHtml);
  if (!entry) {
    throw new Error('No bundle entry point found for this artifact.');
  }

  const entryPath = path.join(absoluteDir, entry);
  const isReact = resolvedStack === 'esbuild-react';

  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    jsx: isReact ? 'automatic' : 'preserve',
    external: isReact ? Object.keys(REACT_ESM_IMPORT_MAP.imports) : [],
    absWorkingDir: absoluteDir,
    plugins: [
      confineToWorkspacePlugin(
        absoluteDir,
        isReact ? Object.keys(REACT_ESM_IMPORT_MAP.imports) : [],
      ),
      cssInjectPlugin(),
    ],
    loader: {
      '.jsx': 'jsx',
      '.tsx': 'tsx',
      '.js': 'js',
      '.ts': 'ts',
      '.json': 'json',
      '.svg': 'dataurl',
    },
  });

  const bundleJs = result.outputFiles[0]?.text ?? '';
  const bundlePath = path.join(absoluteDir, '.preview-bundle.js');
  await mkdir(absoluteDir, { recursive: true });
  await writeFile(bundlePath, bundleJs, 'utf8');

  bundleCache.set(key, {
    bundleJs,
    fingerprint,
    builtAt: Date.now(),
  });

  return bundleJs;
}

export async function buildBundledPreviewHtml({
  projectId,
  artifactSlug,
  bundleUrl,
  stack,
}: {
  projectId: string;
  artifactSlug: string;
  bundleUrl: string;
  stack?: ProjectStack;
}) {
  const baseHref = `/api/projects/${projectId}/preview/${artifactSlug}/`;
  const indexHtml = await readArtifactIndexHtml(projectId, artifactSlug);
  const userHead = indexHtml ? extractIndexHeadContent(indexHtml) : '';
  const userBody = indexHtml ? extractIndexBodyContent(indexHtml) : null;
  const resolvedStack = stack ?? 'esbuild-react';
  const importMap =
    resolvedStack === 'esbuild-react'
      ? `<script type="importmap">${JSON.stringify(REACT_ESM_IMPORT_MAP)}</script>`
      : '';

  const defaultStyles =
    resolvedStack === 'esbuild-react'
      ? `
    html, body, #root { margin: 0; min-height: 100%; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
  `
      : `
    html, body { margin: 0; min-height: 100%; }
  `;

  const bodyContent =
    resolvedStack === 'esbuild-react'
      ? `<div id="root"></div>`
      : (userBody ?? `<div id="root"></div>`);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <base href="${baseHref}" />
  ${importMap}
  ${userHead ? userHead : ''}
  <style>${defaultStyles}</style>
</head>
<body>
  ${bodyContent}
  <script type="module" src="${bundleUrl}"></script>
</body>
</html>`;
}

export function invalidateBundleCache(projectId: string, artifactSlug: string) {
  bundleCache.delete(cacheKey(projectId, artifactSlug));
}
