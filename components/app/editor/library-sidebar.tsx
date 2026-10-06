'use client';

import { CategoryIcon } from '@/components/shared/category-icons';
import { IconButton } from '@/components/ui/icon-button';
import {
  isAgentWorkingOnArtifact,
  type AgentActivity,
} from '@/lib/agent/agent-activity';
import { artifactTypeToCategoryId } from '@/lib/app-types';
import type { AppProjectDetail } from '@/lib/app-types';
import { cn } from '@/lib/utils';
import { AgentActivityPulse } from './agent-activity-indicator';
import { ImageSlotsPanel } from './image-slots-panel';
import { LibraryProjectFiles } from './library-project-files';

type LibrarySidebarProps = {
  project: AppProjectDetail;
  previewVersion: number;
  agentActivity: AgentActivity;
  onImagesChanged: () => void;
  open: boolean;
  onToggle: () => void;
};

export function LibrarySidebar({
  project,
  previewVersion,
  agentActivity,
  onImagesChanged,
  open,
  onToggle,
}: LibrarySidebarProps) {
  return (
    <div
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-app-border-subtle bg-app-sidebar-bg transition-[width] duration-200',
        open ? 'w-72' : 'w-12',
      )}>
      <div className="flex h-app-editor-topbar shrink-0 items-center justify-between border-b border-app-border-subtle px-2">
        {open ? (
          <span className="px-2 text-sm font-medium text-app-text">
            Library
          </span>
        ) : null}
        <IconButton
          label={open ? 'Collapse library' : 'Expand library'}
          size="sm"
          theme="app"
          onClick={onToggle}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true">
            <path
              d="M4 6h16M4 12h10M4 18h16"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </IconButton>
      </div>

      {open ? (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
          <section>
            <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-app-text-muted">
              Artifacts
            </h3>
            <ul className="space-y-1">
              {project.artifacts.map((artifact) => {
                const icon = artifactTypeToCategoryId[artifact.type];
                const isWorking = isAgentWorkingOnArtifact(
                  agentActivity,
                  artifact.id,
                );

                return (
                  <li key={artifact.id}>
                    <div
                      className={cn(
                        'flex w-full items-center gap-2 rounded-lg px-2 py-2 text-sm text-app-text-secondary',
                        isWorking &&
                          'bg-replit-orange/10 ring-1 ring-replit-orange/25',
                      )}>
                      {isWorking ? (
                        <AgentActivityPulse
                          label={`Agent working on ${artifact.name}`}
                        />
                      ) : null}
                      {icon ? <CategoryIcon icon={icon} /> : null}
                      <span className="truncate">{artifact.name}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <ImageSlotsPanel
            project={project}
            previewVersion={previewVersion}
            onChanged={onImagesChanged}
          />

          <LibraryProjectFiles
            project={project}
            previewVersion={previewVersion}
            agentActivity={agentActivity}
          />
        </div>
      ) : null}
    </div>
  );
}
