import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";
import { useProjectKind } from "@/components/icons/projectKind";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { tildify } from "@/lib/path";
import { projectKind, projectNextStep, refreshedText, refreshFailedText } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { refreshProject } from "@/stores/projectActions";
import { findWorktree, mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { MetaDot, TitleBlock } from "./bits";
import { DefaultBranch } from "./DefaultBranch";
import { projectMenu } from "./menus";
import { OverflowMenu } from "./OverflowMenu";
import { useCleanableCount } from "./useCleanable";

/** Fetch (with a remote) and refresh the project's git status; the icon spins meanwhile. */
function RefreshButton({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Tip label={busy ? "Refreshing…" : "Fetch and refresh"}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        tabIndex={-1}
        className="size-5 text-cf-text-muted hover:text-cf-text"
        aria-label="Fetch and refresh"
        data-testid="project-refresh"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void refreshProject(projectId).finally(() => {
            setBusy(false);
          });
        }}
      >
        <RefreshCw className={cn("size-3", busy && "animate-spin")} data-busy={busy || undefined} />
      </Button>
    </Tip>
  );
}

/**
 * "refreshed just now" (when the main checkout's git status was last read), or in red
 * "Refresh failed · 14m ago" with the error as its tooltip.
 */
function Refreshed({ projectId }: { projectId: string }) {
  const main = useProjectsStore((s) => mainWorktreePath(s, projectId));
  const error = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.error ?? "");
  const at = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.refreshedAtMs ?? null);
  const now = useNow(30_000);
  if (error) {
    return (
      <Tip label={error}>
        <span className="shrink-0 text-cf-error-text" data-testid="project-refreshed" data-failed="true">
          {refreshFailedText(at, now)}
        </span>
      </Tip>
    );
  }
  return (
    <span className="shrink-0" data-testid="project-refreshed">
      {refreshedText(at, now)}
    </span>
  );
}

/**
 * A project page's title block (docs/notes/project-page-1-title-block.md): its kind icon and
 * name, and a meta line: the GitHub slug, the kind's meta (another remote, no remote) or,
 * without git, the tildified path; the default branch with its checks (DefaultBranch); when
 * git status was last read with the Refresh button. `compact` (a narrow content pane) drops
 * the slug or kind meta first; without git the path is all there is and stays. At the right
 * only the page's ⋯ (menus.ts projectMenu, `page`).
 */
export function ProjectTitle({ projectId, compact }: { projectId: string; compact: boolean }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const kind = useProjectKind(projectId);
  const git = kind !== "nogit";
  const lead = useProjectsStore((s) => {
    const r = s.byId[projectId];
    if (!r) return "";
    return r.git ? projectKind(r).meta : tildify(r.path);
  });
  const step = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? projectNextStep(r) : null;
  });
  const hasRemote = useProjectsStore((s) => (s.byId[projectId]?.remotes.length ?? 0) > 0);
  const branch = useProjectsStore((s) => s.byId[projectId]?.defaultBranch ?? "");
  const cleanable = useCleanableCount(projectId);
  const showLead = lead !== "" && (!git || !compact);
  return (
    <TitleBlock
      testId="project-title"
      icon={<ProjectKindIcon kind={kind} className="text-cf-text-muted" />}
      name={name}
      meta={
        <>
          {showLead && (
            <Tip label={lead} whenTruncated>
              <span className="min-w-0 shrink truncate" data-testid="project-meta">
                {lead}
              </span>
            </Tip>
          )}
          {git && (
            <>
              {branch !== "" && (
                <>
                  {showLead && <MetaDot />}
                  <DefaultBranch projectId={projectId} variant="title" />
                </>
              )}
              {(showLead || branch !== "") && <MetaDot />}
              <Refreshed projectId={projectId} />
              <RefreshButton projectId={projectId} />
            </>
          )}
        </>
      }
      right={<OverflowMenu label="More project actions" testId="project-more" size="md" items={projectMenu(projectId, { kind, step, cleanup: git && hasRemote ? cleanable : null }, { page: true })} />}
    />
  );
}
