import type { ArtifactType } from '@/lib/generated/prisma/client';
import type Anthropic from '@anthropic-ai/sdk';

import { DESIGN_SYSTEM_BLOCK } from '@/lib/agent/skills-adapter';
import {
  detectProjectStack,
  type ProjectStack,
} from '@/lib/preview/detect-preview-mode';

export const PLAN_MODE_ENABLED_MARKER = 'Plan mode is enabled';
export const PLAN_MODE_SYSTEM_PROMPT = `${PLAN_MODE_ENABLED_MARKER}. You are in planning phase only — do not write code or files yet.`;

export const PLAN_MODE_BLOCK = [
  'Plan mode workflow:',
  "1. Understand the user's request from their message and any context.",
  "2. If a key detail is missing, call ask_plan_question with ONE question and exactly 3–4 short clickable options (under 8 words each). Pick sensible defaults as options. Ask at most one question per turn, then stop and wait for the user's choice.",
  '3. When you have enough information (or after the user picks an option), call complete_plan with a markdown plan: ## Overview, ## Features, ## Design & UX, ## Tech stack, ## Build steps.',
  '4. After complete_plan succeeds, building starts automatically — implement the full approved plan using write_file and complete_build.',
  '5. Do NOT call write_file or complete_build until complete_plan has succeeded.',
  '6. Prefer multiple-choice questions over open-ended ones. Minimize back-and-forth.',
  '7. If the request is already clear, skip questions and go straight to complete_plan.',
].join('\n');

const READ_SKILL_TOOL = {
    name: 'read_skill',
    description:
      'Read a file from the vendored bm-skills design engine. Call with only skill to list its files; add path (e.g. SKILL.md or references/styles/design-system.css) to read one. Read-only.',
    input_schema: {
      type: 'object' as const,
      properties: {
        skill: {
          type: 'string',
          description: 'bm-design-system, bm-prd-creator or bm-favicon-creator',
        },
        path: {
          type: 'string',
          description: 'File path inside the skill, e.g. SKILL.md',
        },
      },
      required: ['skill'],
    },
  } satisfies Anthropic.Tool;

const READ_ONLY_TOOLS = [
  READ_SKILL_TOOL,
  {
    name: 'list_files',
    description: 'List all files in the active artifact workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the active artifact. Path is relative to the artifact root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path, e.g. index.html',
        },
      },
      required: ['path'],
    },
  },
] satisfies Anthropic.Tool[];

export const PLAN_MODE_TOOLS = [
  {
    name: 'ask_plan_question',
    description:
      'Ask the user one clarifying question with 3–4 short clickable options. Use when a key requirement is ambiguous. Ask only ONE question per turn, then wait for the user to pick an option.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'The clarifying question for the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '3–4 concise options the user can pick from (max 4)',
        },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'complete_plan',
    description:
      'Finalize the build plan when you have enough information. After this, implementation begins automatically.',
    input_schema: {
      type: 'object' as const,
      properties: {
        plan: {
          type: 'string',
          description:
            'Markdown plan with ## Overview, ## Features, ## Design & UX, ## Tech stack, ## Build steps',
        },
      },
      required: ['plan'],
    },
  },
  ...READ_ONLY_TOOLS,
] satisfies Anthropic.Tool[];

export function getAgentTools(planMode: boolean): Anthropic.Tool[] {
  return planMode ? PLAN_MODE_TOOLS : AGENT_TOOLS;
}

export function isPlanModeMessage(content: string) {
  return content.includes(PLAN_MODE_ENABLED_MARKER);
}

const STACK_GUIDANCE: Record<ProjectStack, string> = {
  static:
    'Static stack: single-page HTML/CSS/JS with index.html. Use for calculators, timers, slides (full-screen sections + keyboard nav), and simple tools. Do not add React.',
  'esbuild-esm':
    'ESM stack: index.html + main.js (or script.js) with ES module imports across multiple .js files. Use for multi-file vanilla apps without JSX.',
  'esbuild-react':
    "React stack: index.html + main.jsx + App.jsx + components/*. Always wire every component in App.jsx. Use `import React from 'react'` — dependencies resolve via CDN. In JSX, use camelCase DOM/SVG attributes (fontFamily, fontSize, fontWeight, strokeWidth) — never HTML kebab-case like font-family.",
};

const EDIT_WORKFLOW = [
  'Edit workflow (when artifact already has files):',
  '1. Call list_files first.',
  '2. Call read_file on every file you plan to change.',
  '3. Prefer edit_file for changes to existing files — it replaces only the matched old_string span.',
  '4. Use write_file ONLY for brand-new files, or when most of a file must be restructured.',
  '5. Never use write_file on an existing file without read_file first; when using write_file, copy every unchanged line exactly from the read content.',
  '6. Never delete component files or features unless the user asked.',
  '7. React projects must keep App.jsx importing all used components.',
  '8. Call complete_build only after files are saved and should preview successfully.',
].join('\n');

export function buildAgentSystemPrompt({
  projectName,
  projectDescription,
  artifactName,
  artifactType,
  artifactSnapshot,
  projectStack,
  planMode,
  attachmentContext,
  hasExistingFiles,
}: {
  projectName: string;
  projectDescription: string | null;
  artifactName: string;
  artifactType: ArtifactType;
  artifactSnapshot: string;
  projectStack: ProjectStack;
  planMode: boolean;
  attachmentContext?: string;
  hasExistingFiles?: boolean;
}) {
  const stackRules = [
    'Stack selection rules:',
    '- Calculator / simple tools → vanilla static (index.html + script.js), no React.',
    '- Landing pages → React only if interactivity/components justify it; always include complete App.jsx.',
    '- Weather / fetch apps → vanilla fetch + DOM, or small React app with one App.jsx.',
    '- Slides → static HTML sections in one index.html, optional vanilla JS for keyboard nav.',
    '- Multi-file vanilla (imports between .js files) → ESM stack with main.js entry.',
    STACK_GUIDANCE[projectStack],
  ].join('\n');

  const buildGuidance =
    artifactType === 'DESIGN'
      ? 'Build static HTML/CSS wireframes and mockups. No backend or JavaScript unless needed for layout demos.'
      : artifactType === 'MOBILE_APP'
        ? [
            'Build polished, mobile-first web apps that feel native on phones.',
            'Use a narrow viewport layout (max-width ~420px), touch-friendly tap targets (min 44px), and safe-area padding.',
            'Prefer vanilla HTML + CSS + JS with index.html unless React is clearly needed.',
            'Always link assets with relative paths (style.css, script.js).',
            'Use CSS Grid or Flexbox — never rely on unstyled HTML.',
            'Wire up real interactivity (click handlers, state, keyboard support).',
            'Write the full updated file only after reading it.',
            'Before complete_build, verify layout, styles, and interactivity on a phone-sized screen.',
          ].join(' ')
        : [
            'Build polished, fully functional web apps.',
            stackRules,
            hasExistingFiles
              ? [
                  'IMPORTANT: This artifact already has files. The user is requesting changes — do NOT rebuild from scratch.',
                  EDIT_WORKFLOW,
                ].join('\n')
              : EDIT_WORKFLOW,
            'Always link assets with relative paths.',
            'Use CSS Grid or Flexbox — never rely on unstyled HTML.',
            'Wire up real interactivity (click handlers, state, keyboard support).',
          ].join('\n\n');

  const parts = [
    `You are Replit Agent, an AI coding assistant inside a project editor.`,
    `Help the user build real, polished artifacts using the provided tools.`,
    `Never output raw code, XML, or pseudo tool calls in chat text.`,
    `Use tools to read and write files, then call complete_build with a concise user-facing summary.`,
    `The complete_build summary MUST use markdown: a short intro paragraph, then **Design:** and **Functionality:** sections with bullet lists.`,
    buildGuidance,
    planMode ? PLAN_MODE_BLOCK : null,
    artifactType === 'WEB_APP' ? DESIGN_SYSTEM_BLOCK : null,
    attachmentContext
      ? [
          'Prompt attachments from the user:',
          attachmentContext,
          'Incorporate attachment content, assets, and requirements into your plan and build. Reference images with relative paths like `_attachments/filename.png`.',
        ].join('\n\n')
      : null,
    `Project: ${projectName}`,
    `Description: ${projectDescription ?? 'No description'}`,
    `Active artifact: ${artifactName} (${artifactType})`,
    `Detected stack: ${projectStack}`,
    `Artifact context:\n${artifactSnapshot}`,
  ].filter(Boolean);

  return parts.join('\n\n');
}

export function detectProjectStackFromPaths(
  relativePaths: string[],
  indexHtml?: string | null,
): ProjectStack {
  return detectProjectStack(relativePaths, indexHtml);
}

export const AGENT_TOOLS = [
  READ_SKILL_TOOL,
  {
    name: 'list_files',
    description: 'List all files in the active artifact workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [] as string[],
    },
  },
  {
    name: 'read_file',
    description:
      'Read a file from the active artifact. Path is relative to the artifact root. Required before edit_file or write_file on existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path, e.g. index.html',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'edit_file',
    description:
      'Apply a surgical edit to an existing file by replacing old_string with new_string. Prefer this over write_file when modifying existing code. You must read_file first. Copy old_string exactly from the file (including whitespace). Use replace_all only when every match should change.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path, e.g. script.js or App.jsx',
        },
        old_string: {
          type: 'string',
          description:
            'Exact text to find and replace (must match the file contents)',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text',
        },
        replace_all: {
          type: 'boolean',
          description:
            'Replace every occurrence (default false — must be unique)',
        },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description:
      'Create a new file or fully rewrite an existing one. For existing files you must read_file first and preserve all unrelated code. Prefer edit_file for small or medium changes to existing files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Relative file path, e.g. index.html or App.jsx',
        },
        content: {
          type: 'string',
          description: 'Full file contents',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'complete_build',
    description:
      'Signal that building is complete and provide a markdown summary for the user (no code). Only succeeds when the preview builds successfully.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description:
            'Markdown summary with intro, **Design:** bullets, and **Functionality:** bullets',
        },
      },
      required: ['summary'],
    },
  },
] satisfies Anthropic.Tool[];
