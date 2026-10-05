import { headers } from 'next/headers';
import { z } from 'zod';

import { auth } from '@/lib/auth';
import {
  ensureConversation,
  getArtifactForProject,
  getAuthorizedProject,
} from '@/lib/agent/access';
import { runAgentLoop } from '@/lib/agent/run-agent';
import type { AgentMessageMetadata, AgentStreamEvent } from '@/lib/agent/types';
import { getAgentLimits, getAppTier } from '@/lib/billing/entitlements';
import { getUserBillingFields } from '@/lib/queries/billing';
import { prisma } from '@/lib/prisma';

const bodySchema = z.object({
  content: z.string().trim().min(1).max(8000).optional(),
  artifactId: z.string().min(1),
  conversationId: z.string().min(1).optional(),
  initialReply: z.boolean().optional(),
});

// One agent run per project at a time, and a global cap: runs share the owner's
// subscription rate limits and each spawns a CLI process.
const MAX_CONCURRENT_RUNS = Number(process.env.MAX_CONCURRENT_AGENT_RUNS ?? 2);
const RUN_TIMEOUT_MS = 10 * 60 * 1000;
const globalForRuns = globalThis as unknown as {
  agentRuns?: Map<string, AbortController>;
};
const activeRuns = (globalForRuns.agentRuns ??= new Map());

function encodeSse(event: AgentStreamEvent) {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export async function POST(
  request: Request,
  context: { params: Promise<{ projectId: string }> },
) {
  const session = await auth.api.getSession({ headers: await headers() });
  const userId = session?.user?.id;

  if (!userId) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
    });
  }

  const { projectId } = await context.params;
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);

  if (!parsed.success) {
    return new Response(JSON.stringify({ error: 'Invalid request.' }), {
      status: 400,
    });
  }

  const project = await getAuthorizedProject(projectId, userId);
  if (!project) {
    return new Response(JSON.stringify({ error: 'Project not found.' }), {
      status: 404,
    });
  }

  const artifact = await getArtifactForProject(
    projectId,
    parsed.data.artifactId,
  );
  if (!artifact) {
    return new Response(JSON.stringify({ error: 'Artifact not found.' }), {
      status: 404,
    });
  }

  const conversationId =
    parsed.data.conversationId ??
    project.conversations[0]?.id ??
    (await ensureConversation(projectId, userId));

  const billingUser = await getUserBillingFields(userId);
  const agentLimits = getAgentLimits(getAppTier(billingUser));

  if (activeRuns.has(projectId)) {
    return new Response(
      JSON.stringify({ error: 'The agent is already working on this project.' }),
      { status: 409 },
    );
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    return new Response(
      JSON.stringify({ error: 'The agent is busy. Try again in a minute.' }),
      { status: 429 },
    );
  }

  const runAbort = new AbortController();
  activeRuns.set(projectId, runAbort);
  const timeout = setTimeout(() => runAbort.abort(), RUN_TIMEOUT_MS);
  request.signal.addEventListener('abort', () => runAbort.abort());
  const release = () => {
    clearTimeout(timeout);
    if (activeRuns.get(projectId) === runAbort) activeRuns.delete(projectId);
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();

      function send(event: AgentStreamEvent) {
        controller.enqueue(encoder.encode(encodeSse(event)));
      }

      try {
        if (parsed.data.initialReply) {
          const [lastMessage, artifactFileCount] = await Promise.all([
            prisma.agentMessage.findFirst({
              where: { conversationId },
              orderBy: { createdAt: 'desc' },
              select: { role: true },
            }),
            prisma.projectFile.count({
              where: {
                projectId,
                path: { startsWith: `${artifact.slug}/` },
              },
            }),
          ]);

          if (lastMessage?.role === 'ASSISTANT' || artifactFileCount > 0) {
            send({
              type: 'done',
              messageId: '',
              summary: '',
              previewVersion: 0,
              steps: [],
            });
            controller.close();
            return;
          }
        } else if (parsed.data.content) {
          await prisma.agentMessage.create({
            data: {
              conversationId,
              role: 'USER',
              content: parsed.data.content,
            },
          });
        } else {
          send({ type: 'error', message: 'Message content is required.' });
          controller.close();
          return;
        }

        const result = await runAgentLoop({
          conversationId,
          projectId,
          artifactId: artifact.id,
          limits: agentLimits,
          signal: runAbort.signal,
          onEvent: send,
        });

        const metadata: AgentMessageMetadata = {
          steps: result.steps,
          fileWrites: result.fileWrites,
          presentedArtifactId: result.presentedArtifactId,
          previewVersion: result.previewVersion,
          buildValid: result.buildValid,
          planQuestion: result.planQuestion,
          planCompleted: result.planCompleted,
        };

        const assistantMessage = await prisma.agentMessage.create({
          data: {
            conversationId,
            role: 'ASSISTANT',
            content: result.summary,
            metadata,
          },
          select: { id: true, content: true, createdAt: true },
        });

        await prisma.agentConversation.update({
          where: { id: conversationId },
          data: { updatedAt: new Date() },
        });

        if (result.buildValid) {
          await prisma.artifact.update({
            where: { id: artifact.id },
            data: { status: 'READY' },
          });
        }

        send({
          type: 'done',
          messageId: assistantMessage.id,
          summary: assistantMessage.content,
          previewVersion: result.previewVersion,
          steps: result.steps,
          fileWrites: result.fileWrites,
          presentedArtifactId: result.presentedArtifactId,
          buildValid: result.buildValid,
          planQuestion: result.planQuestion,
          planCompleted: result.planCompleted,
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Agent failed.';
        send({ type: 'error', message });
      } finally {
        release();
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
