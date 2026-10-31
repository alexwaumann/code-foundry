import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Pencil, SquarePen, Trash2 } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { FinderMark } from "@/components/icons/FinderMark";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { memberKey, workspaceKey } from "@/lib/projects";
import { membersByName } from "@/lib/workspaceCard";
import { openChangesTab } from "@/stores/changesPanel";
import { composeInWorkspace } from "@/stores/compose";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { PROJECTS_INDEX, useUiStore } from "@/stores/ui";
import { removeWorkspace, revealWorkspace } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { WorkspaceIcon } from "./bits";
import { usePageScroll } from "./pageHooks";
import { OverflowMenu } from "./OverflowMenu";
import { PagePicker, ProjectsCrumb } from "./PagePicker";
import { WorkspaceCard } from "./WorkspaceCard";

/**
 * A workspace's page. For now its header (crumb, picker, "workspace · N projects", Open in
 * Finder, New thread, Rename… and Remove workspace…) over the existing WorkspaceCard, so
 * the index's Workspaces rows open something; the body's redesign is a later step
 * (docs/notes/projects-redesign-1-index.md).
 */
export function WorkspacePage({ workspaceId, pageKey }: { workspaceId: string; pageKey: string }) {
  const loaded = useWorkspacesStore((s) => s.loaded);
  const exists = useWorkspacesStore((s) => s.byId[workspaceId] !== undefined);
  const name = useWorkspacesStore((s) => s.byId[workspaceId]?.name ?? workspaceId);
  const memberIds = useWorkspacesStore(useShallow((s) => (s.byId[workspaceId]?.members ?? []).map((m) => m.projectId)));
  const names = useProjectsStore(useShallow((s) => memberIds.map((p) => s.byId[p]?.name ?? "")));
  const collapsed = useUiStore((s) => s.collapsedWorkspaces.includes(workspaceId));
  const [renameSeq, setRenameSeq] = useState(0);

  // A workspace removed while its page shows: back to the index. Only once it was there: a
  // page opened for one just added comes before its event (stores/projectsPage.ts).
  const [seen, setSeen] = useState(exists);
  if (exists && !seen) setSeen(true);
  useEffect(() => {
    if (loaded && seen && !exists) useUiStore.getState().select(PROJECTS_INDEX);
  }, [loaded, seen, exists]);

  const members = useMemo(() => {
    const byId = new Map(memberIds.map((p, i) => [p, names[i] || undefined]));
    return membersByName(memberIds, (p) => byId.get(p));
  }, [memberIds, names]);
  const navItems = useMemo<NavItem[]>(
    () => [
      {
        key: workspaceKey(workspaceId),
        activate: () => { composeInWorkspace(workspaceId); },
        toggle: (open) => useUiStore.getState().setWorkspaceCollapsed(workspaceId, !open),
      },
      ...(collapsed
        ? []
        : members.map((projectId) => ({
            key: memberKey(workspaceId, projectId),
            // A member: its project's main worktree's changes; an unregistered one opens nothing.
            activate: () => {
              const at = mainWorktreePath(useProjectsStore.getState(), projectId);
              if (at) openChangesTab("current", projectId, at);
            },
          }))),
    ],
    [workspaceId, members, collapsed],
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
  const n = memberIds.length;

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label={name} data-testid="projects-page" data-page="workspace" data-workspace={workspaceId}>
      <PaneHeader className="gap-2 px-5">
        <ProjectsCrumb />
        <PagePicker icon={<WorkspaceIcon />} name={name} currentWorkspace={workspaceId} />
        <span className="min-w-0 shrink truncate text-caption text-cf-text-muted" data-testid="workspace-meta">
          workspace · {n} {n === 1 ? "project" : "projects"}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 [--wails-draggable:no-drag]">
          <Button type="button" variant="outline" size="sm" className="h-7" data-testid="workspace-page-reveal" onClick={() => void revealWorkspace(workspaceId)}>
            <FinderMark />
            Open in Finder
          </Button>
          <Button type="button" size="sm" className="h-7" data-testid="workspace-page-new-thread" onClick={() => { composeInWorkspace(workspaceId); }}>
            <SquarePen />
            New thread
          </Button>
          <OverflowMenu
            label="More workspace actions"
            testId="workspace-page-more"
            items={[
              { label: "Rename…", icon: Pencil, testId: "workspace-page-rename", onSelect: () => { setRenameSeq((x) => x + 1); } },
              "separator",
              { label: "Remove workspace…", icon: Trash2, destructive: true, testId: "workspace-page-remove", onSelect: () => void removeWorkspace(workspaceId) },
            ]}
          />
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
            {exists && <WorkspaceCard id={workspaceId} collapsed={collapsed} filtering={false} renameSeq={renameSeq} />}
          </div>
        </NavProvider>
      </div>
    </section>
  );
}
