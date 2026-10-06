'use client';

import {
  idleAgentActivity,
  type AgentActivity,
} from '@/lib/agent/agent-activity';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppProjectDetail } from '@/lib/app-types';
import type { AppTier } from '@/lib/billing/entitlements';
import { setActiveArtifactPreferenceAction } from '@/lib/actions/artifacts';
import { useToast } from '@/components/ui/toast';
import { EditorTopBar } from './editor-topbar';
import { LibrarySidebar } from './library-sidebar';
import { AgentPanel } from './agent-panel';
import { PreviewPanel } from './preview-panel';

type ProjectEditorProps = {
  project: AppProjectDetail;
  appTier: AppTier;
};

function getInitialActiveArtifactId(project: AppProjectDetail) {
  const saved = project.lastActiveArtifactId;
  if (saved && project.artifacts.some((artifact) => artifact.id === saved)) {
    return saved;
  }

  return project.artifacts[0]?.id ?? null;
}

function getInitialPreviewVersion(project: AppProjectDetail) {
  const assistantMessages = project.messages.filter(
    (message) => message.role === 'assistant',
  );

  const lastAssistant = assistantMessages.at(-1);
  if (lastAssistant?.metadata?.previewVersion) {
    return lastAssistant.metadata.previewVersion;
  }

  const activeslug = project.artifacts[0]?.slug;
  if (!activeslug) return 0;

  return project.files.filter((file) => file.path.startsWith(`${activeslug}/`))
    .length;
}

export function ProjectEditor({ project, appTier }: ProjectEditorProps) {
  const { error: toastError } = useToast();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [artifacts, setArtifacts] = useState(project.artifacts);
  const [files, setFiles] = useState(project.files);
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(() =>
    getInitialActiveArtifactId(project),
  );
  const [previewVersion, setPreviewVersion] = useState(() =>
    getInitialPreviewVersion(project),
  );
  const [agentActivity, setAgentActivity] =
    useState<AgentActivity>(idleAgentActivity);
  const [deployment, setDeployment] = useState(project.deployment);

  const editorProject = useMemo(
    () => ({ ...project, artifacts, files, deployment }),
    [artifacts, deployment, files, project],
  );

  const handlePreviewVersionChange = useCallback((delta: number) => {
    setPreviewVersion((current) => current + delta);
  }, []);

  const syncProjectFiles = useCallback(async () => {
    try {
      const response = await fetch(`/api/projects/${project.id}/files`, {
        cache: 'no-store',
      });
      if (!response.ok) return;

      const data = (await response.json()) as {
        files: AppProjectDetail['files'];
      };
      setFiles(data.files);
    } catch {
      // Ignore transient fetch errors.
    }
  }, [project.id]);

  useEffect(() => {
    if (previewVersion === 0) return;

    setTimeout(() => {
      void syncProjectFiles();
    }, 10);
  }, [previewVersion, syncProjectFiles]);

  const persistActiveArtifact = useCallback(
    (artifactId: string) => {
      void setActiveArtifactPreferenceAction(project.id, artifactId);
    },
    [project.id],
  );

  const handleArtifactChange = useCallback(
    (artifactId: string) => {
      setActiveArtifactId(artifactId);
      persistActiveArtifact(artifactId);
    },
    [persistActiveArtifact],
  );

  const handleAgentActivityChange = useCallback((activity: AgentActivity) => {
    setAgentActivity(activity);
  }, []);

  const handleAgentRunComplete = useCallback(
    async (result: {
      artifactId: string;
      buildValid: boolean;
      previewVersion: number;
    }) => {
      if (!result.buildValid) return;

      await syncProjectFiles();
      setArtifacts((current) =>
        current.map((artifact) =>
          artifact.id === result.artifactId
            ? { ...artifact, status: 'READY' as const }
            : artifact,
        ),
      );
    },
    [syncProjectFiles],
  );

  return (
    <div className="flex h-screen flex-col bg-app-bg text-app-text">
      <EditorTopBar
        project={editorProject}
        appTier={appTier}
        onPublished={(nextDeployment) => setDeployment(nextDeployment)}
      />

      <div className="flex min-h-0 flex-1">
        <LibrarySidebar
          project={editorProject}
          previewVersion={previewVersion}
          agentActivity={agentActivity}
          onImagesChanged={() => handlePreviewVersionChange(1)}
          open={libraryOpen}
          onToggle={() => setLibraryOpen((value) => !value)}
        />

        <div className="flex min-w-0 flex-1">
          <AgentPanel
            project={editorProject}
            activeArtifactId={activeArtifactId}
            onPreviewVersionChange={handlePreviewVersionChange}
            onAgentRunComplete={handleAgentRunComplete}
            onAgentActivityChange={handleAgentActivityChange}
          />

          <PreviewPanel
            project={editorProject}
            activeArtifactId={activeArtifactId}
            previewVersion={previewVersion}
            agentActivity={agentActivity}
            onArtifactChange={handleArtifactChange}
            onArtifactCreated={(artifact) => {
              setArtifacts((current) => [...current, artifact]);
              setActiveArtifactId(artifact.id);
              persistActiveArtifact(artifact.id);
            }}
            onArtifactDeleted={(artifact) => {
              setFiles((current) =>
                current.filter(
                  (file) => !file.path.startsWith(`${artifact.slug}/`),
                ),
              );
              setArtifacts((current) => {
                const remaining = current.filter(
                  (item) => item.id !== artifact.id,
                );
                setActiveArtifactId((activeId) => {
                  const next =
                    activeId === artifact.id
                      ? (remaining[0]?.id ?? null)
                      : activeId;
                  if (next) persistActiveArtifact(next);
                  return next;
                });
                return remaining;
              });
            }}
            onError={toastError}
          />
        </div>
      </div>
    </div>
  );
}
