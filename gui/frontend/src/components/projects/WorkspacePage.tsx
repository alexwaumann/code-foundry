import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { SquarePen } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { FinderIcon } from "@/components/icons/AppIcon";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { memberKey } from "@/lib/projects";
import { membersByName } from "@/lib/workspaceCard";
import { workspaceThreadKey } from "@/lib/workspacePage";
import { openChangesTab } from "@/stores/changesPanel";
import { composeInWorkspace } from "@/stores/compose";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { PROJECTS_INDEX, useUiStore } from "@/stores/ui";
import { revealWorkspace } from "@/stores/workspaceActions";
import { endWorkspaceRename, useWorkspaceRenameStore } from "@/stores/workspaceRename";
import { useWorkspacesStore } from "@/stores/workspaces";
import { WorkspaceIcon } from "./bits";
import { usePageScroll } from "./pageHooks";
import { workspaceMenu } from "./menus";
import { OverflowMenu } from "./OverflowMenu";
import { PagePicker, ProjectsCrumb } from "./PagePicker";
import { WorkspaceInstructions } from "./WorkspaceInstructions";
import { WorkspaceNameEditor } from "./WorkspaceNameEditor";
import { WorkspaceProjects } from "./WorkspaceProjects";
import { openThread, useWorkspaceTerminal, useWorkspaceThreads } from "./workspaceHooks";
import { WorkspaceThreads } from "./WorkspaceThreads";

/** The workspace's member ids by project name (lib/workspaceCard.ts membersByName); the stored order is by id. */
function useMembersByName(workspaceId: string): string[] {
  const ids = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => m.projectId)));
  const names = useProjectsStore(useShallow((s) => ids.map((p) => s.byId[p]?.name ?? "")));
  return useMemo(() => {
    const byId = new Map(ids.map((p, i) => [p, names[i] || undefined]));
    return membersByName(ids, (p) => byId.get(p));
  }, [ids, names]);
}

/**
 * A workspace's page (docs/notes/projects-redesign-3-workspace-page.md): the header
 * (crumb › name + picker, "workspace · N projects", Open in Finder, New thread, and its ⋯: the index
 * row's context menu, components/projects/menus.ts workspaceMenu), then its Projects (where threads start, Start here, Remove, Add
 * project), its Threads (one column per member's checkout) and its Instructions and
 * skills. Keyboard: ↑/↓ walk the member rows (Enter shows the project's main checkout's
 * changes) and the thread rows (Enter opens the thread).
 */
export function WorkspacePage({ workspaceId, pageKey }: { workspaceId: string; pageKey: string }) {
  const loaded = useWorkspacesStore((s) => s.loaded);
  const exists = useWorkspacesStore((s) => s.byId[workspaceId] !== undefined);
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  const rooted = useWorkspacesStore((s) => (s.byId[workspaceId]?.rootPath ?? "") !== "");
  const members = useMembersByName(workspaceId);
  const threads = useWorkspaceThreads(workspaceId);
  const renaming = useWorkspaceRenameStore((s) => s.renamingWorkspaceId === workspaceId);
  // Leaving the page closes its editor (the field's blur has renamed by then).
  useEffect(() => () => { endWorkspaceRename(workspaceId); }, [workspaceId]);
  const terminal = useWorkspaceTerminal(workspaceId);

  // A workspace removed while its page shows: back to the index. Only once it was there: a
  // page opened for one just added comes before its event (stores/projectsPage.ts).
  const [seen, setSeen] = useState(exists);
  if (exists && !seen) setSeen(true);
  useEffect(() => {
    if (loaded && seen && !exists) useUiStore.getState().select(PROJECTS_INDEX);
  }, [loaded, seen, exists]);

  const navItems = useMemo<NavItem[]>(
    () => [
      ...members.map((projectId) => ({
        key: memberKey(workspaceId, projectId),
        // A member: its project's main worktree's changes; an unregistered one opens nothing.
        activate: () => {
          const at = mainWorktreePath(useProjectsStore.getState(), projectId);
          if (at) openChangesTab("current", projectId, at);
        },
      })),
      ...threads.ids.map((id) => ({ key: workspaceThreadKey(workspaceId, id), activate: () => { openThread(id); } })),
    ],
    [workspaceId, members, threads.ids],
  );
  const nav = useNav(navItems);
  const reveal = useProjectsPageStore((s) => s.reveal);
  const setCursor = nav.ctx.setCursor;
  useEffect(() => {
    if (reveal === null || !navItems.some((it) => it.key === reveal)) return;
    setCursor(reveal);
    clearProjectsPageReveal(reveal);
  }, [reveal, navItems, setCursor]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = usePageScroll(pageKey);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const n = members.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label={name} data-testid="projects-page" data-page="workspace" data-workspace={workspaceId}>
      <PaneHeader className="gap-2 px-5">
        <ProjectsCrumb />
        {renaming ? (
          <span className="flex min-w-0 shrink-0 items-center gap-2 px-1 [--wails-draggable:no-drag]">
            <WorkspaceIcon />
            <WorkspaceNameEditor
              workspaceId={workspaceId}
              name={name}
              onDone={() => {
                endWorkspaceRename(workspaceId);
                // Enter or Escape: the keyboard goes back to the page's list (the field is not inside it).
                // Leaving the field for something else keeps the focus there.
                requestAnimationFrame(() => {
                  const active = document.activeElement;
                  if (!active || active === document.body) rootRef.current?.focus({ preventScroll: true });
                });
              }}
            />
          </span>
        ) : (
          <PagePicker icon={<WorkspaceIcon />} name={name} currentWorkspace={workspaceId} />
        )}
        <span className="min-w-0 shrink truncate text-caption text-cf-text-muted" data-testid="workspace-meta">
          workspace · {n} {n === 1 ? "project" : "projects"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 [--wails-draggable:no-drag]">
          <Button type="button" variant="outline" size="sm" className="h-7" data-testid="workspace-page-reveal" onClick={() => void revealWorkspace(workspaceId)}>
            <FinderIcon />
            Open in Finder
          </Button>
          <Button type="button" size="sm" className="h-7" data-testid="workspace-page-new-thread" onClick={() => { composeInWorkspace(workspaceId); }}>
            <SquarePen />
            New thread
          </Button>
          <OverflowMenu label="More workspace actions" testId="workspace-page-more" items={workspaceMenu(workspaceId, { folder: terminal })} />
        </span>
        <span className="-mr-2 flex shrink-0 items-center">
          <BottomToggle />
          <PanelToggle />
        </span>
      </PaneHeader>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-testid="projects-scroll">
        <NavProvider value={nav.ctx}>
          <div
            ref={rootRef}
            tabIndex={0}
            role="listbox"
            aria-label={`${name} workspace`}
            aria-activedescendant={nav.activeDescendant}
            className="mx-auto flex max-w-5xl flex-col gap-6 outline-none"
            data-testid="projects-list"
            data-focus-root
            onKeyDown={nav.onKeyDown}
          >
            {exists && (
              <div className="flex flex-col gap-6" data-testid="workspace" data-workspace={workspaceId} data-rooted={rooted || undefined}>
                <WorkspaceProjects workspaceId={workspaceId} members={members} />
                <WorkspaceThreads workspaceId={workspaceId} members={members} ids={threads.ids} caption={threads.caption} />
                <WorkspaceInstructions workspaceId={workspaceId} />
              </div>
            )}
          </div>
        </NavProvider>
      </div>
    </section>
  );
}
