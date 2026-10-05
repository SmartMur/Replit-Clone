import { access } from 'node:fs/promises';
import path from 'node:path';

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import {
  BUILDER_TOOL_PREFIX,
  createBuilderServer,
} from '@/lib/agent/mcp-tools';
import { applyFileEdit } from '@/lib/agent/apply-file-edit';
import { buildArtifactContextSnapshot } from '@/lib/agent/build-artifact-context';
import { getArtifactForProject } from '@/lib/agent/access';
import {
  ANTHROPIC_MAX_TOKENS,
  MAX_AGENT_CONTINUE_NUDGES,
  MAX_AGENT_TURNS,
  getAnthropicModel,
} from '@/lib/agent/constants';
import type { AgentLimits } from '@/lib/billing/entitlements';
import {
  buildAgentSystemPrompt,
  detectProjectStackFromPaths,
  isPlanModeMessage,
  PLAN_MODE_ENABLED_MARKER,
} from '@/lib/agent/prompts';
import {
  buildAttachmentContextForAgent,
  isImageAttachmentPath,
  isTextAttachmentPath,
  readAttachmentBuffer,
  readAttachmentText,
} from '@/lib/project-attachments';
import { PROMPT_ATTACHMENTS_DIR } from '@/lib/prompt-attachments';
import {
  dedupeActionSteps,
  dedupeFileWrites,
  normalizeFileContent,
} from '@/lib/agent/step-utils';
import {
  extractCompleteBuildPartial,
  extractWriteFilePartial,
  languageFromPath,
} from '@/lib/agent/tool-input-parser';
import type {
  AgentFileWriteSnapshot,
  AgentRunResult,
  AgentStep,
  AgentStreamEvent,
} from '@/lib/agent/types';
import { bundleArtifact } from '@/lib/preview/bundle-artifact';
import {
  resolveProjectStack,
  type ProjectStack,
} from '@/lib/preview/detect-preview-mode';
import { formatBundleError } from '@/lib/preview/format-bundle-error';
import { artifactWorkspaceDir } from '@/lib/project-files';
import { mkdir } from 'node:fs/promises';
import { readSkill } from '@/lib/agent/skills';
import {
  PLACEHOLDER,
  formatTemplateList,
  listTemplates,
  readTemplate,
} from '@/lib/agent/templates';
import { createHash } from 'node:crypto';
import { auditSite } from '@/lib/agent/site-audit';
import { DESIGN_SYSTEM_CSS, SITE_CSS_STUB } from '@/lib/agent/skills-adapter';
import { SITE_CSS } from '@/lib/preview/design-css';
import {
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from '@/lib/project-files';
import { prisma } from '@/lib/prisma';

const MAX_AGENT_MESSAGES = 50;
const BUILD_NOT_READY_PREFIX = 'BUILD_NOT_READY:';

type ValidateArtifactPreviewResult =
  | { ok: true; stack: ProjectStack }
  | { ok: false; stack: ProjectStack; errors: string[] };

async function validateArtifactPreview(
  projectId: string,
  artifactSlug: string,
): Promise<ValidateArtifactPreviewResult> {
  const { stack, relativePaths } = await resolveProjectStack(
    projectId,
    artifactSlug,
  );

  if (stack === 'static') {
    const indexPath = path.join(
      artifactWorkspaceDir(projectId, artifactSlug),
      'index.html',
    );
    try {
      await access(indexPath);
      return { ok: true, stack };
    } catch {
      return {
        ok: false,
        stack,
        errors: [
          'Missing index.html — static previews require an index.html entry file.',
        ],
      };
    }
  }

  try {
    await bundleArtifact({ projectId, artifactSlug, relativePaths, stack });
    return { ok: true, stack };
  } catch (error) {
    return {
      ok: false,
      stack,
      errors: [formatBundleError(error)],
    };
  }
}

type RunAgentLoopOptions = {
  conversationId: string;
  projectId: string;
  artifactId: string;
  limits?: AgentLimits;
  signal?: AbortSignal;
  onEvent?: (event: AgentStreamEvent) => void;
};

type ToolContext = {
  conversationId: string;
  projectId: string;
  artifactId: string;
  artifactSlug: string;
  artifactName: string;
  artifactType: string;
  planMode: boolean;
  skillsRead: Set<string>;
  auditAck: string | null;
  existingPaths: Set<string>;
  readPaths: Set<string>;
  writtenPaths: Set<string>;
  readCache: Map<string, string>;
  steps: AgentStep[];
  fileWrites: AgentFileWriteSnapshot[];
  previewVersion: number;
  buildValid: boolean;
  planQuestion?: { question: string; options: string[] };
  planCompleted?: boolean;
  lastFileStreamEmit: Map<string, number>;
  onEvent?: (event: AgentStreamEvent) => void;
};

type StreamingToolBlock = {
  id: string;
  name: string;
  json: string;
};

function emitAction(
  ctx: ToolContext,
  label: string,
  path?: string,
  status: 'running' | 'done' = 'done',
) {
  const step: AgentStep = { type: 'action', label, path, status };
  ctx.steps.push(step);
  ctx.onEvent?.({ type: 'action', label, path, status });
  ctx.onEvent?.({
    type: 'status',
    phase: 'working',
    actionCount: ctx.steps.length,
  });
}

function upsertFileWrite(
  ctx: ToolContext,
  relativePath: string,
  content: string,
  status: 'streaming' | 'done',
) {
  const dbPath = `${ctx.artifactSlug}/${relativePath}`;
  const language = languageFromPath(relativePath);
  const existingIndex = ctx.fileWrites.findIndex(
    (file) => file.path === dbPath,
  );

  const snapshot: AgentFileWriteSnapshot = {
    path: dbPath,
    content: normalizeFileContent(content),
    language,
    status,
  };

  if (existingIndex >= 0) {
    ctx.fileWrites[existingIndex] = snapshot;
  } else {
    ctx.fileWrites.push(snapshot);
  }

  if (status === 'streaming') {
    const now = Date.now();
    const lastEmit = ctx.lastFileStreamEmit.get(dbPath) ?? 0;
    const isNewFile = existingIndex < 0;
    if (!isNewFile && now - lastEmit < 200) {
      return;
    }
    ctx.lastFileStreamEmit.set(dbPath, now);
  } else {
    ctx.lastFileStreamEmit.delete(dbPath);
  }

  ctx.onEvent?.({
    type: 'file_write',
    path: dbPath,
    content,
    language,
    status,
  });
}

function handleStreamingToolDelta(ctx: ToolContext, block: StreamingToolBlock) {
  if (block.name === 'write_file') {
    const parsed = extractWriteFilePartial(block.json);
    if (parsed.path) {
      upsertFileWrite(ctx, parsed.path, parsed.content ?? '', 'streaming');
    }
    return;
  }

  if (block.name === 'complete_build') {
    const parsed = extractCompleteBuildPartial(block.json);
    if (parsed.summary) {
      ctx.onEvent?.({ type: 'text_delta', content: parsed.summary });
    }
  }
}

async function exitPlanMode(conversationId: string, plan: string) {
  await prisma.agentMessage.updateMany({
    where: {
      conversationId,
      role: 'SYSTEM',
      content: { contains: PLAN_MODE_ENABLED_MARKER },
    },
    data: {
      content: `Plan mode completed.\n\nApproved plan:\n${plan}`,
    },
  });
}

function normalizePlanOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((option) => String(option ?? '').trim())
    .filter(Boolean)
    .slice(0, 4);
}

/**
 * Deterministic enforcement of the design engine: a site seeded with design-system.css
 * must have read the skill and must actually use the stylesheet.
 */
async function checkDesignSystemGate(ctx: ToolContext) {
  const files = await listProjectFiles(ctx.projectId, ctx.artifactSlug);
  const prefix = `${ctx.artifactSlug}/`;
  const names = files.map((file) => file.path.slice(prefix.length));
  if (!names.includes(DESIGN_SYSTEM_CSS) && !names.includes(SITE_CSS)) return null;

  const readSkillMd = [...ctx.skillsRead].some((entry) =>
    entry.startsWith('bm-design-system/SKILL.md'),
  );
  if (!readSkillMd) {
    return 'This site uses the bm-design-system engine. Call read_skill with skill "bm-design-system" and path "SKILL.md" (and references/agent-instructions.md), then restyle using its tokens and component classes before completing.';
  }

  const texts: Record<string, string> = {};
  for (const name of names) {
    if (!/\.(html?|css|js)$/i.test(name) || name.startsWith(`${PROMPT_ATTACHMENTS_DIR}/`)) continue;
    const text = await readProjectFile(ctx.projectId, ctx.artifactSlug, name);
    if (text === null) continue;
    texts[name] = text;
    if (/\.html$/i.test(name) && /<table\b/i.test(text) && !/overflow-x-auto/.test(text)) {
      return `${name} has a <table> that is not inside a scroll container, which overflows phones. Wrap every table in <div class="overflow-x-auto"> (keep the page itself from scrolling sideways at 375px), then call complete_build again.`;
    }
    if (/\.(html|js)$/i.test(name) && PLACEHOLDER.test(text)) {
      const sample = text.match(PLACEHOLDER)?.[0];
      return `${name} still contains template placeholders such as ${sample}. Replace every {{placeholder}} with real content (or remove the element) in every file, then call complete_build again.`;
    }
  }

  const html = texts['index.html'];
  if (html === undefined) return null;
  if (!/<link\b[^>]*href=["']design-system\.css["']/i.test(html)) {
    return `index.html must include <link rel="stylesheet" href="${DESIGN_SYSTEM_CSS}"> in <head> (the server turns it into the Tailwind runtime). Add it, use the design-system tokens and classes, and remove duplicate hand-rolled styling.`;
  }

  const audit = await auditSite({
    workspaceRoot: artifactWorkspaceDir(ctx.projectId, ctx.artifactSlug),
    fileNames: names,
    texts,
  });
  if (audit.errors.length > 0) {
    return `The automated site audit found problems. Fix them, then call complete_build again:\n${audit.errors.map((line) => `- ${line}`).join('\n')}`;
  }
  if (audit.warnings.length > 0) {
    const key = createHash('sha1').update(audit.warnings.join('|')).digest('hex');
    if (ctx.auditAck !== key) {
      ctx.auditAck = key;
      return `The audit has warnings. Fix the ones that matter (theme toggle, tokens over raw hex and inline styles, missing files), then call complete_build again to proceed:\n${audit.warnings.map((line) => `- ${line}`).join('\n')}`;
    }
  }
  return null;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<{ result: string; stopForQuestion?: boolean }> {
  if (
    (name === 'write_file' || name === 'edit_file') &&
    String(input.path ?? '').replace(/^\.?\//, '') === DESIGN_SYSTEM_CSS &&
    !ctx.existingPaths.has(DESIGN_SYSTEM_CSS)
  ) {
    return {
      result: `${DESIGN_SYSTEM_CSS} is provided and maintained by the platform and cannot be created or edited. Put brand colour overrides and custom CSS in ${SITE_CSS} (read it first). Use read_skill to read the design-system stylesheet.`,
    };
  }

  switch (name) {
    case 'ask_plan_question': {
      const question = String(input.question ?? '').trim();
      const options = normalizePlanOptions(input.options);

      if (!question) {
        return { result: 'Question text is required.' };
      }
      if (options.length < 2) {
        return { result: 'Provide 3–4 options for the user to pick from.' };
      }

      ctx.planQuestion = { question, options };
      ctx.onEvent?.({ type: 'plan_question', question, options });
      emitAction(ctx, 'Asked planning question');
      return {
        result: 'Question sent to user. Wait for their choice.',
        stopForQuestion: true,
      };
    }

    case 'complete_plan': {
      const plan = String(input.plan ?? '').trim();
      if (!plan) {
        return { result: 'Plan content is required.' };
      }

      await exitPlanMode(ctx.conversationId, plan);
      ctx.planMode = false;
      ctx.planCompleted = true;
      ctx.onEvent?.({ type: 'plan_completed' });
      emitAction(ctx, 'Finalized plan');

      return {
        result: `Plan approved. Begin building immediately according to this plan:\n\n${plan}`,
      };
    }

    case 'list_files': {
      const files = await listProjectFiles(ctx.projectId, ctx.artifactSlug);
      emitAction(ctx, 'Listed project files');
      if (files.length === 0) {
        return { result: 'No files yet.' };
      }
      return {
        result: files
          .map((file) => file.path.replace(`${ctx.artifactSlug}/`, ''))
          .join('\n'),
      };
    }

    case 'use_template': {
      const id = String(input.template ?? '').trim();
      if (!id) {
        return { result: formatTemplateList(await listTemplates()) };
      }
      if (ctx.planMode) {
        return {
          result:
            'Plan mode is still active. Name the chosen template in your plan, call complete_plan, then call use_template.',
        };
      }

      const current = await listProjectFiles(ctx.projectId, ctx.artifactSlug);
      const prefix = `${ctx.artifactSlug}/`;
      const buildable = current
        .map((file) => file.path.slice(prefix.length))
        .filter(
          (file) =>
            !file.startsWith(`${PROMPT_ATTACHMENTS_DIR}/`) &&
            file !== DESIGN_SYSTEM_CSS &&
            file !== SITE_CSS,
        );
      if (buildable.length > 0) {
        return {
          result: `This artifact already has files (${buildable.slice(0, 5).join(', ')}). Templates only seed an empty artifact; edit the existing files instead.`,
        };
      }

      const template = await readTemplate(id);
      if (!template) {
        return {
          result: `Unknown template "${id}".\n${formatTemplateList(await listTemplates())}`,
        };
      }

      for (const [name, content] of Object.entries(template.files)) {
        await writeProjectFile({
          projectId: ctx.projectId,
          artifactSlug: ctx.artifactSlug,
          artifactId: ctx.artifactId,
          relativePath: name,
          content,
        });
        ctx.writtenPaths.add(name);
        ctx.existingPaths.add(name);
        ctx.readPaths.add(name);
        ctx.readCache.set(name, content);
        upsertFileWrite(ctx, name, content, 'done');
      }
      ctx.previewVersion += 1;
      emitAction(ctx, `Started from template: ${template.meta.name}`);

      return {
        result: `Template "${template.meta.id}" saved: ${Object.keys(template.files).join(', ')}. You have effectively read these files. Replace EVERY {{placeholder}} with real content for this project (page titles, copy, links, labels), delete sections that do not apply, add what is missing, then call complete_build. index.html currently contains:\n\n${template.files['index.html'] ?? ''}`,
      };
    }

    case 'read_skill': {
      const skill = String(input.skill ?? '').trim();
      const skillPath = String(input.path ?? '').trim();
      ctx.skillsRead.add(`${skill}/${skillPath}`);
      emitAction(
        ctx,
        'Read design skill',
        skillPath ? `${skill}/${skillPath}` : skill,
      );
      return { result: await readSkill(skill, skillPath || undefined) };
    }

    case 'read_file': {
      const filePath = String(input.path ?? '');
      emitAction(ctx, `Read ${filePath}`, `${ctx.artifactSlug}/${filePath}`);

      if (isImageAttachmentPath(filePath)) {
        ctx.readPaths.add(filePath);
        return {
          result: `Image attachment at \`${filePath}\`. It is included in the conversation when vision is available. Reference it in HTML with src="${filePath}".`,
        };
      }

      if (filePath.startsWith(`${PROMPT_ATTACHMENTS_DIR}/`)) {
        if (isTextAttachmentPath(filePath)) {
          try {
            const { text } = await readAttachmentText(
              ctx.projectId,
              ctx.artifactSlug,
              filePath,
            );
            ctx.readPaths.add(filePath);
            return { result: text };
          } catch {
            return { result: `File not found: ${filePath}` };
          }
        }

        try {
          const { mimeType, sizeBytes } = await readAttachmentBuffer(
            ctx.projectId,
            ctx.artifactSlug,
            filePath,
          );
          ctx.readPaths.add(filePath);
          return {
            result: `Binary attachment \`${filePath}\` (${mimeType}, ${sizeBytes} bytes). Use the filename and user prompt for context.`,
          };
        } catch {
          return { result: `File not found: ${filePath}` };
        }
      }

      const content = await readProjectFile(
        ctx.projectId,
        ctx.artifactSlug,
        filePath,
      );
      if (content == null) {
        return { result: `File not found: ${filePath}` };
      }
      ctx.readPaths.add(filePath);
      ctx.readCache.set(filePath, content);
      return { result: content };
    }

    case 'edit_file': {
      if (ctx.planMode) {
        return {
          result:
            'Plan mode is still active. Call complete_plan first, then build.',
        };
      }

      const filePath = String(input.path ?? '');
      const oldString = String(input.old_string ?? '');
      const newString = String(input.new_string ?? '');
      const replaceAll = input.replace_all === true;

      const pathExists = ctx.existingPaths.has(filePath);

      if (
        pathExists &&
        !ctx.readPaths.has(filePath) &&
        !ctx.writtenPaths.has(filePath)
      ) {
        return {
          result: `You must read_file "${filePath}" before editing an existing file.`,
        };
      }

      if (!pathExists) {
        return {
          result: `File not found: ${filePath}. Use write_file to create new files.`,
        };
      }

      const currentContent =
        ctx.readCache.get(filePath) ??
        (await readProjectFile(ctx.projectId, ctx.artifactSlug, filePath));

      if (currentContent == null) {
        return { result: `File not found: ${filePath}` };
      }

      const editResult = applyFileEdit(
        currentContent,
        oldString,
        newString,
        replaceAll,
      );
      if (!editResult.ok) {
        return { result: editResult.error };
      }

      await writeProjectFile({
        projectId: ctx.projectId,
        artifactSlug: ctx.artifactSlug,
        artifactId: ctx.artifactId,
        relativePath: filePath,
        content: editResult.content,
      });

      ctx.readCache.set(filePath, editResult.content);
      ctx.writtenPaths.add(filePath);
      ctx.readPaths.add(filePath);
      ctx.previewVersion += 1;
      upsertFileWrite(ctx, filePath, editResult.content, 'done');
      emitAction(
        ctx,
        `Edited ${filePath} (${editResult.replacements} replacement${editResult.replacements === 1 ? '' : 's'})`,
        `${ctx.artifactSlug}/${filePath}`,
      );

      return {
        result: `Applied edit to ${filePath} (${editResult.replacements} replacement${editResult.replacements === 1 ? '' : 's'}, ${editResult.content.length} bytes).`,
      };
    }

    case 'write_file': {
      if (ctx.planMode) {
        return {
          result:
            'Plan mode is still active. Call complete_plan first, then build.',
        };
      }

      const filePath = String(input.path ?? '');
      const content = String(input.content ?? '');

      const pathExists = ctx.existingPaths.has(filePath);

      if (
        pathExists &&
        !ctx.readPaths.has(filePath) &&
        !ctx.writtenPaths.has(filePath)
      ) {
        return {
          result: `You must read_file "${filePath}" before overwriting an existing file. Prefer edit_file for targeted changes.`,
        };
      }

      const previousContent = pathExists
        ? ctx.readCache.get(filePath)
        : undefined;
      if (
        pathExists &&
        previousContent &&
        content.length < previousContent.length * 0.55
      ) {
        return {
          result: `Refusing full rewrite: new content (${content.length} bytes) is much shorter than the read file (${previousContent.length} bytes) and may drop existing functionality. Use edit_file for targeted changes, or include ALL original code plus your edits in write_file.`,
        };
      }

      await writeProjectFile({
        projectId: ctx.projectId,
        artifactSlug: ctx.artifactSlug,
        artifactId: ctx.artifactId,
        relativePath: filePath,
        content,
      });

      ctx.writtenPaths.add(filePath);
      ctx.existingPaths.add(filePath);
      ctx.readCache.set(filePath, content);
      ctx.previewVersion += 1;
      upsertFileWrite(ctx, filePath, content, 'done');
      return { result: `Saved ${filePath} (${content.length} bytes).` };
    }

    case 'complete_build': {
      if (ctx.planMode) {
        return {
          result:
            'Plan mode is still active. Call complete_plan first, then build.',
        };
      }

      const designGate = await checkDesignSystemGate(ctx);
      if (designGate) {
        ctx.buildValid = false;
        return { result: `${BUILD_NOT_READY_PREFIX} ${designGate}` };
      }

      const summary = String(input.summary ?? '').trim();
      emitAction(ctx, 'Validating preview');

      const validation = await validateArtifactPreview(
        ctx.projectId,
        ctx.artifactSlug,
      );
      if (!validation.ok) {
        ctx.buildValid = false;
        return {
          result: `${BUILD_NOT_READY_PREFIX} Preview validation failed (${validation.stack}). Fix these errors, then call complete_build again:\n\n${validation.errors.join('\n\n')}`,
        };
      }

      ctx.buildValid = true;
      emitAction(ctx, 'Completed build');
      return { result: summary || 'Build complete.' };
    }

    default:
      return { result: `Unknown tool: ${name}` };
  }
}

type ImageInput = {
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;
};

/** Minimal async queue so we can feed follow-up user messages into one running query. */
function createInputQueue() {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  async function* iterate(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      if (pending.length > 0) {
        yield pending.shift()!;
        continue;
      }
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return {
    iterable: iterate(),
    push(message: SDKUserMessage) {
      pending.push(message);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
  };
}

function userMessage(text: string, images: ImageInput[] = []): SDKUserMessage {
  return {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content:
        images.length === 0
          ? text
          : [
              ...images.map((image) => ({
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  media_type: image.mediaType,
                  data: image.data,
                },
              })),
              { type: 'text' as const, text },
            ],
    },
  };
}

/** Environment for the CLI child: only what it needs to find its login. No app secrets, no API key. */
function childEnv(): Record<string, string | undefined> {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME'];
  const env: Record<string, string | undefined> = {};
  for (const key of keep) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

type SessionOutcome = {
  restartAfterPlan: boolean;
  finalText: string;
  hitTurnLimit: boolean;
};

/** New static website artifacts start with the bm-design-system stylesheet so the agent builds on tokens. */
async function seedDesignSystem(ctx: ToolContext) {
  if (ctx.planMode || ctx.artifactType !== 'WEB_APP') return;
  const files = await listProjectFiles(ctx.projectId, ctx.artifactSlug);
  const prefix = `${ctx.artifactSlug}/`;
  const buildable = files.filter(
    (file) => !file.path.startsWith(`${prefix}${PROMPT_ATTACHMENTS_DIR}/`),
  );
  if (buildable.length > 0) return;

  await writeProjectFile({
    projectId: ctx.projectId,
    artifactSlug: ctx.artifactSlug,
    artifactId: ctx.artifactId,
    relativePath: SITE_CSS,
    content: SITE_CSS_STUB,
  });
  ctx.existingPaths.add(SITE_CSS);
  ctx.onEvent?.({ type: 'action', label: 'Applied design system', path: SITE_CSS, status: 'done' });
}

async function runSession({
  ctx,
  systemPrompt,
  firstMessage,
  limits,
  signal,
}: {
  ctx: ToolContext;
  systemPrompt: string;
  firstMessage: SDKUserMessage;
  limits: AgentLimits;
  signal?: AbortSignal;
}): Promise<SessionOutcome & { summary: string }> {
  const workspaceDir = artifactWorkspaceDir(ctx.projectId, ctx.artifactSlug);
  await mkdir(workspaceDir, { recursive: true });
  await seedDesignSystem(ctx);

  let summary = '';
  let done = false;
  let restartAfterPlan = false;

  const { server, allowedTools } = createBuilderServer(
    ctx.planMode,
    async (name, args) => {
      const { result, stopForQuestion } = await executeTool(name, args, ctx);

      if (name === 'complete_plan' && ctx.planCompleted) {
        restartAfterPlan = true;
      }
      if (name === 'ask_plan_question' && stopForQuestion) {
        summary = ctx.planQuestion?.question ?? result;
        done = true;
      }
      if (name === 'complete_build' && !result.startsWith(BUILD_NOT_READY_PREFIX)) {
        summary = result;
        done = true;
      }
      return result;
    },
  );

  const inputQueue = createInputQueue();
  inputQueue.push(firstMessage);

  const abort = new AbortController();
  const onExternalAbort = () => abort.abort();
  signal?.addEventListener('abort', onExternalAbort);
  if (signal?.aborted) abort.abort();

  const stream = query({
    prompt: inputQueue.iterable,
    options: {
      abortController: abort,
      cwd: workspaceDir,
      model: limits.model,
      maxTurns: limits.maxTurns,
      systemPrompt,
      // Lockdown: no built-in tools (no Bash/Read/Write/Web), no user settings,
      // hooks, plugins or extra MCP servers. Only the builder tools below exist.
      tools: [],
      mcpServers: { builder: server },
      allowedTools,
      strictMcpConfig: true,
      settingSources: [],
      plugins: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      includePartialMessages: true,
      env: childEnv(),
      extraArgs: { 'disable-slash-commands': null },
      ...(process.env.CLAUDE_CODE_PATH
        ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH }
        : {}),
    },
  });

  const toolBlocks = new Map<number, StreamingToolBlock>();
  let textSnapshot = '';
  let lastText = '';
  let nudges = 0;
  let hitTurnLimit = false;

  try {
    for await (const message of stream) {
      // A terminal tool already fired: stop as soon as the model moves on.
      if (done || restartAfterPlan) break;

      if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'message_start') {
          textSnapshot = '';
          toolBlocks.clear();
        }

        if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          toolBlocks.set(event.index, {
            id: event.content_block.id,
            name: event.content_block.name.replace(BUILDER_TOOL_PREFIX, ''),
            json: '',
          });
        }

        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'input_json_delta') {
            const block = toolBlocks.get(event.index);
            if (block) {
              block.json += event.delta.partial_json;
              handleStreamingToolDelta(ctx, block);
            }
          }
          if (event.delta.type === 'text_delta') {
            textSnapshot += event.delta.text;
            lastText = textSnapshot;
            ctx.onEvent?.({ type: 'text_delta', content: textSnapshot });
          }
        }
        continue;
      }

      if (message.type === 'result') {
        if (message.subtype === 'error_max_turns') {
          hitTurnLimit = true;
          break;
        }
        if (message.subtype !== 'success') {
          throw new Error('The agent stopped unexpectedly. Try again.');
        }

        const text = (message.result || lastText).trim();
        const buildInProgress =
          !ctx.buildValid &&
          !ctx.planQuestion &&
          (ctx.writtenPaths.size > 0 ||
            ctx.fileWrites.length > 0 ||
            ctx.planCompleted);

        if (buildInProgress && nudges < MAX_AGENT_CONTINUE_NUDGES) {
          nudges += 1;
          if (text) ctx.onEvent?.({ type: 'text_delta', content: text });
          inputQueue.push(
            userMessage(
              'The build is not finished yet. Continue implementing the remaining files, then call complete_build when the preview is ready.',
            ),
          );
          continue;
        }

        summary = summary || text || 'Done.';
        break;
      }
    }
  } catch (error) {
    // After a terminal tool we abort the child ourselves; anything else is a real failure.
    if (!(done || restartAfterPlan)) throw error;
  } finally {
    inputQueue.close();
    abort.abort();
    signal?.removeEventListener('abort', onExternalAbort);
  }

  return { restartAfterPlan, finalText: lastText, hitTurnLimit, summary };
}

export async function runAgentLoop({
  conversationId,
  projectId,
  artifactId,
  limits,
  signal,
  onEvent,
}: RunAgentLoopOptions): Promise<AgentRunResult> {
  const agentLimits: AgentLimits = limits ?? {
    maxTurns: MAX_AGENT_TURNS,
    maxTokens: ANTHROPIC_MAX_TOKENS,
    model: getAnthropicModel(),
  };

  const artifact = await getArtifactForProject(projectId, artifactId);
  if (!artifact) {
    throw new Error('Artifact not found.');
  }

  if (
    artifact.type !== 'WEB_APP' &&
    artifact.type !== 'MOBILE_APP' &&
    artifact.type !== 'DESIGN'
  ) {
    throw new Error(
      'This artifact type does not support file-based builds yet.',
    );
  }

  const [project, rawMessages, artifactFiles] = await Promise.all([
    prisma.project.findUnique({
      where: { id: projectId },
      select: { name: true, description: true },
    }),
    prisma.agentMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: MAX_AGENT_MESSAGES,
      select: { role: true, content: true },
    }),
    listProjectFiles(projectId, artifact.slug),
  ]);

  if (!project) {
    throw new Error('Project not found.');
  }

  const messages = rawMessages.slice().reverse();

  const planMode = messages.some(
    (message) =>
      message.role === 'SYSTEM' && isPlanModeMessage(message.content),
  );

  const relativePaths = artifactFiles.map((file) =>
    file.path.replace(`${artifact.slug}/`, ''),
  );

  const buildablePaths = relativePaths.filter(
    (path) => !path.startsWith(`${PROMPT_ATTACHMENTS_DIR}/`),
  );
  const hasExistingFiles = buildablePaths.length > 0;

  const indexHtml = relativePaths.includes('index.html')
    ? await readProjectFile(projectId, artifact.slug, 'index.html')
    : null;

  const artifactSnapshot = await buildArtifactContextSnapshot({
    projectId,
    artifactSlug: artifact.slug,
    artifactFiles: artifactFiles.map((file) => ({
      path: file.path,
      updatedAt: file.updatedAt,
    })),
  });

  const attachmentContext = await buildAttachmentContextForAgent(
    projectId,
    artifact.slug,
  );

  const promptContext = {
    projectName: project.name,
    projectDescription: project.description,
    artifactName: artifact.name,
    artifactType: artifact.type,
    artifactSnapshot,
    projectStack: detectProjectStackFromPaths(relativePaths, indexHtml),
  };

  // Each CLI session is stateless: the prior conversation is replayed as one transcript.
  const transcript = messages
    .filter(
      (message) =>
        message.role !== 'SYSTEM' || message.content.startsWith('Plan mode completed'),
    )
    .map((message) =>
      message.role === 'SYSTEM'
        ? `[approved plan]\n${message.content}`
        : `[${message.role === 'USER' ? 'user' : 'assistant'}]\n${message.content}`,
    )
    .join('\n\n');
  const transcriptPrompt = `Conversation so far (oldest first). Respond to the latest [user] message by using your tools.\n\n${transcript}`;

  const ctx: ToolContext = {
    conversationId,
    projectId,
    artifactId,
    artifactSlug: artifact.slug,
    artifactName: artifact.name,
    artifactType: artifact.type,
    planMode,
    skillsRead: new Set(),
    auditAck: null,
    existingPaths: new Set(relativePaths),
    readPaths: new Set(),
    writtenPaths: new Set(),
    readCache: new Map(),
    steps: [],
    fileWrites: [],
    previewVersion: 0,
    buildValid: false,
    lastFileStreamEmit: new Map(),
    onEvent,
  };

  onEvent?.({ type: 'status', phase: 'working', actionCount: 0 });

  const buildPrompt = (inPlanMode: boolean) =>
    buildAgentSystemPrompt({
      ...promptContext,
      planMode: inPlanMode,
      attachmentContext: attachmentContext.summary || undefined,
      hasExistingFiles,
    });

  let outcome = await runSession({
    ctx,
    systemPrompt: buildPrompt(ctx.planMode),
    firstMessage: userMessage(transcriptPrompt, attachmentContext.images),
    limits: agentLimits,
    signal,
  });

  // complete_plan switches the system prompt and tool set, so continue in a fresh session.
  if (outcome.restartAfterPlan) {
    outcome = await runSession({
      ctx,
      systemPrompt: buildPrompt(false),
      firstMessage: userMessage(
        `${transcriptPrompt}\n\n[system]\nThe plan was approved. Begin building immediately according to it, then call complete_build.`,
        attachmentContext.images,
      ),
      limits: agentLimits,
      signal,
    });
  }

  let summary = outcome.summary;
  const hitTurnLimit =
    outcome.hitTurnLimit && !ctx.buildValid && !ctx.planQuestion;

  if (!summary && ctx.planQuestion) {
    summary = ctx.planQuestion.question;
  }

  if (!summary) {
    summary = ctx.planCompleted
      ? 'Plan finalized — building your project now.'
      : hitTurnLimit
        ? "I made progress but ran out of steps before finishing. Reply **continue** and I'll pick up where I left off."
        : "I've updated your project. Check the preview to see the result.";
  } else if (hitTurnLimit && !ctx.buildValid) {
    summary = `${summary}\n\n—\nStill in progress. Reply **continue** to finish the build.`;
  }

  onEvent?.({ type: 'text', content: summary });

  const finalSteps = dedupeActionSteps(
    ctx.steps.map((step) =>
      step.type === 'action' ? { ...step, status: 'done' as const } : step,
    ),
  );

  const finalFileWrites = dedupeFileWrites(
    ctx.fileWrites.map((file) => ({
      ...file,
      status: 'done' as const,
    })),
  );

  return {
    summary,
    steps: finalSteps,
    fileWrites: finalFileWrites,
    previewVersion: ctx.previewVersion,
    presentedArtifactId: ctx.buildValid ? artifactId : undefined,
    buildValid: ctx.buildValid,
    planQuestion: ctx.planQuestion,
    planCompleted: ctx.planCompleted,
  };
}
