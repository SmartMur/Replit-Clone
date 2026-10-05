'use server';

import { rm } from 'node:fs/promises';
import { revalidatePath } from 'next/cache';
import path from 'node:path';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCachedSession } from '../auth/cached';
import { validatePromptAttachment } from '../prompt-attachments';
import { getDefaultWorkspace } from '../queries/projects';
import { getUserBillingFields } from '../queries/billing';
import {
  getAppTier,
  getProjectLimit,
  projectLimitMessage,
} from '../billing/entitlements';
import { prisma } from '../prisma';
import {
  projectSlugFromPrompt,
  uniqueProjectSlug,
} from '../server/project-slug';
import { ArtifactType } from '@/lib/generated/prisma/client';
import { categoryToArtifactType } from '../app-types';
import { PLAN_MODE_SYSTEM_PROMPT } from '../agent/prompts';
import {
  formatAttachmentManifest,
  savePromptAttachmentsToArtifact,
} from '../project-attachments';
import { getAccessibleProject } from '../projects/access';
import { projectWorkspaceDir } from '../project-files';

const projectIdSchema = z.object({
  projectId: z.string().min(1),
});

const authorizedProjectForActionsSelect = {
  id: true,
  deletedAt: true,
  workspace: { select: { slug: true } },
  slug: true,
} as const;

function revalidateProjectPaths() {
  revalidatePath('/app/projects');
  revalidatePath('/app/trash');
}

async function removeProjectFilesFromDisk(projectId: string) {
  const dirs = [
    projectWorkspaceDir(projectId),
    path.join(process.cwd(), 'public', 'uploads', 'projects', projectId),
  ];

  await Promise.all(
    dirs.map(async (dir) => {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }),
  );
}

export async function createProjectAction(formData: FormData) {
  const session = await getCachedSession();
  const userId = session?.user?.id;

  if (!userId) {
    redirect('/?auth=login&callbackUrl=/app');
  }

  const prompt = String(formData.get('prompt') ?? '').trim();
  const categoryId = formData.get('categoryId');
  const planMode = formData.get('planMode') === 'true';

  const attachmentFiles: File[] = [];
  for (const [key, value] of formData.entries()) {
    if (
      key.startsWith('attachment-') &&
      value instanceof File &&
      value.size > 0
    ) {
      attachmentFiles.push(value);
    }
  }

  if (!prompt && attachmentFiles.length === 0) {
    return { error: 'Describe what you want to build or attacha file first.' };
  }

  for (const file of attachmentFiles) {
    const validationError = validatePromptAttachment(file);
    if (validationError) {
      return { error: validationError };
    }
  }

  const workspace = await getDefaultWorkspace(userId);
  if (!workspace) {
    return { error: 'No workspace found. Try signing in again.' };
  }

  const billingUser = await getUserBillingFields(userId);
  const projectLimit = getProjectLimit(getAppTier(billingUser));
  if (projectLimit !== null) {
    const activeProjectCount = await prisma.project.count({
      where: {
        deletedAt: null,
        OR: [
          { createdById: userId },
          { workspace: { ownerId: userId } },
          { members: { some: { userId } } },
        ],
      },
    });

    if (activeProjectCount >= projectLimit) {
      return { error: projectLimitMessage(projectLimit) };
    }
  }

  const effectivePrompt =
    prompt ||
    `Review the attached file${attachmentFiles.length === 1 ? '' : 's'} and help me plan next steps.`;

  const baseName =
    effectivePrompt.length > 48
      ? `${effectivePrompt.slice(0, 45)}...`
      : effectivePrompt;
  const slug = await uniqueProjectSlug(
    workspace.id,
    projectSlugFromPrompt(effectivePrompt),
  );

  const artifactType: ArtifactType =
    categoryId &&
    typeof categoryId === 'string' &&
    categoryId in categoryToArtifactType
      ? categoryToArtifactType[
          categoryId as keyof typeof categoryToArtifactType
        ]
      : 'WEB_APP';

  const project = await prisma.project.create({
    data: {
      name: baseName,
      slug,
      description: effectivePrompt,
      workspaceId: workspace.id,
      createdById: userId,
      members: {
        create: {
          userId,
          role: 'OWNER',
        },
      },
      preferences: {
        create: {
          userId,
          lastOpenedAt: new Date(),
        },
      },
      artifacts: {
        create: {
          name: 'Main artifact',
          slug: 'main',
          type: artifactType,
          status: 'DRAFT',
        },
      },
      conversations: {
        create: {
          userId,
          title: planMode ? 'Planning' : 'New conversation',
          messages: {
            create: [
              ...(planMode
                ? [
                    {
                      role: 'SYSTEM' as const,
                      content: PLAN_MODE_SYSTEM_PROMPT,
                    },
                  ]
                : []),
              {
                role: 'USER' as const,
                content: effectivePrompt,
              },
            ],
          },
        },
      },
    },
    select: {
      id: true,
      slug: true,
      workspace: { select: { slug: true } },
      artifacts: {
        where: { slug: 'main' },
        select: { id: true, slug: true },
        take: 1,
      },
    },
  });

  const mainArtifact = project.artifacts[0];
  let storedAttachments: Awaited<
    ReturnType<typeof savePromptAttachmentsToArtifact>
  > = [];

  if (attachmentFiles.length > 0 && mainArtifact) {
    storedAttachments = await savePromptAttachmentsToArtifact({
      projectId: project.id,
      artifactId: mainArtifact.id,
      artifactSlug: mainArtifact.slug,
      files: attachmentFiles,
    });

    const userMessageContent =
      effectivePrompt + formatAttachmentManifest(storedAttachments);

    const conversation = await prisma.agentConversation.findFirst({
      where: { projectId: project.id },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (conversation) {
      const userMessage = await prisma.agentMessage.findFirst({
        where: { conversationId: conversation.id, role: 'USER' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });

      if (userMessage) {
        await prisma.agentMessage.update({
          where: { id: userMessage.id },
          data: {
            content: userMessageContent,
            metadata: { attachments: storedAttachments },
          },
        });
      }
    }
  }

  redirect(`/app/projects/${project.workspace.slug}/${project.slug}`);
}

export async function moveProjectToTrashAction(projectId: string) {
  const session = await getCachedSession();
  const userId = session?.user?.id;

  if (!userId) return { error: 'Unauthorized' };

  const parsed = projectIdSchema.safeParse({ projectId });
  if (!parsed.success) return { error: 'Invalid project.' };

  const project = await getAccessibleProject(
    parsed.data.projectId,
    userId,
    authorizedProjectForActionsSelect,
    { includeTrashed: true },
  );
  if (!project) return { error: 'Project not found.' };

  if (project.deletedAt) {
    return { error: 'Project is already in trash.' };
  }

  await prisma.$transaction([
    prisma.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    }),
    prisma.userProjectPreference.updateMany({
      where: { userId, projectId: project.id },
      data: { isPinned: false },
    }),
  ]);

  revalidateProjectPaths();

  return { success: true };
}

export async function restoreProjectAction(projectId: string) {
  const session = await getCachedSession();
  const userId = session?.user?.id;

  if (!userId) return { error: 'Unauthorized' };

  const parsed = projectIdSchema.safeParse({ projectId });
  if (!parsed.success) return { error: 'Invalid project.' };

  const project = await getAccessibleProject(
    parsed.data.projectId,
    userId,
    authorizedProjectForActionsSelect,
    { includeTrashed: true },
  );
  if (!project) return { error: 'Project not found.' };

  if (!project.deletedAt) {
    return { error: 'Project is not in trash.' };
  }

  await prisma.project.update({
    where: { id: project.id },
    data: { deletedAt: null },
  });

  revalidateProjectPaths();

  return { success: true };
}

export async function permanentlyDeleteProjectAction(projectId: string) {
  const session = await getCachedSession();
  const userId = session?.user?.id;

  if (!userId) return { error: 'Unauthorized' };

  const parsed = projectIdSchema.safeParse({ projectId });
  if (!parsed.success) return { error: 'Invalid project.' };

  const project = await getAccessibleProject(
    parsed.data.projectId,
    userId,
    authorizedProjectForActionsSelect,
    { includeTrashed: true },
  );
  if (!project) return { error: 'Project not found.' };

  if (!project.deletedAt) {
    return { error: 'Move the project to trash before deleting permanently.' };
  }

  await prisma.project.delete({ where: { id: project.id } });
  await removeProjectFilesFromDisk(project.id);

  revalidateProjectPaths();

  return { success: true };
}
