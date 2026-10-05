import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { getAgentTools } from '@/lib/agent/prompts';

export const BUILDER_SERVER_NAME = 'builder';
export const BUILDER_TOOL_PREFIX = `mcp__${BUILDER_SERVER_NAME}__`;

/** Zod shapes mirroring the JSON schemas in prompts.ts (same names, same fields). */
const SHAPES: Record<string, z.ZodRawShape> = {
  list_files: {},
  use_template: { template: z.string().optional() },
  read_skill: { skill: z.string(), path: z.string().optional() },
  read_file: { path: z.string().describe('Relative file path, e.g. index.html') },
  edit_file: {
    path: z.string(),
    old_string: z.string(),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
  },
  write_file: { path: z.string(), content: z.string() },
  complete_build: { summary: z.string() },
  ask_plan_question: {
    question: z.string(),
    options: z.array(z.string()).describe('3-4 concise options (max 4)'),
  },
  complete_plan: { plan: z.string() },
};

export type ToolRunner = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

/**
 * In-process MCP server exposing only the builder tools for the current phase.
 * The model has no other tools (built-ins are disabled in run-agent.ts), so every
 * file operation goes through executeTool and its path checks.
 */
export function createBuilderServer(planMode: boolean, run: ToolRunner) {
  const tools = getAgentTools(planMode).flatMap((def) => {
    const shape = SHAPES[def.name];
    if (!shape) return [];
    return [
      tool(def.name, def.description ?? def.name, shape, async (args) => ({
        content: [
          {
            type: 'text' as const,
            text: await run(def.name, args as Record<string, unknown>),
          },
        ],
      })),
    ];
  });

  return {
    server: createSdkMcpServer({
      name: BUILDER_SERVER_NAME,
      version: '1.0.0',
      tools,
    }),
    allowedTools: tools.map((t) => `${BUILDER_TOOL_PREFIX}${t.name}`),
  };
}
