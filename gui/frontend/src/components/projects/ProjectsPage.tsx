import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Broom, CloudUpload, Diff, Folder, FolderGit2, FolderPlus, GitBranchPlus, Layers, Play, RefreshCw, Search, SquarePen, SquareTerminal, Trash2, Unlink } from "lucide-react";
import { ActionsMenu } from "@/components/actions/ActionsMenu";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { GithubMark } from "@/components/icons/GithubMark";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Freshness, SectionTitle } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import {
  collapsedProjectSummary,
  filterProjects,
  NONE_COLLAPSED,
  pageItems,
  PROJECT_STALE_MS,
  projectKey,
  projectKind,
  projectNextStep,
  projectsModel,
  projectWorktreeKey,
  type Collapsed,
  type ProjectKind,
  type ProjectModel,
  type ProjectNextStep,
  type ProjectsSearch,
  type ProjectsWorkspaces,
} from "@/lib/projects";
import { cn } from "@/lib/utils";
import { openActionEditor } from "@/stores/actionDialog";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import {
  addProject,
  cleanupMergedWorktrees,
  cleanupWorktree,
  initGitIn,
  newTerminalIn,
  newWorktreeIn,
  publishProject,
  refreshProject,
  removeWorktree,
  unregisterProject,
} from "@/stores/projectActions";
import { findWorktree, mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { useUiStore } from "@/stores/ui";
import { openNewWorkspaceDialog } from "@/stores/workspaceActions";
import { openChangesTab } from "@/stores/changesPanel";
import { useWorkspacesStore } from "@/stores/workspaces";
import { CollapseToggle } from "./CollapseToggle";
import { useCleanable, useCleanableCount } from "./useCleanable";
import { NoGitBadge } from "./NoGitBadge";
import { OverflowMenu, type OverflowItem } from "./OverflowMenu";
import { WorkspaceCard } from "./WorkspaceCard";
import { RowAction, WorktreeState } from "./WorktreeState";

const ROW_H = 32;
const SEP = "\u0001";

/**
 * The page's structure inputs as strings, so it rebuilds on membership changes only (not
 * git status). A project's name is in it: a workspace card's rows are ordered by it.
 */
function useStructure(): { projects: string[]; workspaces: string[] } {
  const projects = useProjectsStore(useShallow((s) => s.order.map((id) => [id, s.byId[id]?.name ?? "", ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
  const workspaces = useWorkspacesStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.members.map((m) => m.projectId) ?? [])].join(SEP))));
  return { projects, workspaces };
}

function decode(projectKeys: readonly string[], wsKeys: readonly string[]) {
  const projects = {
    order: projectKeys.map((k) => k.split(SEP)[0] ?? ""),
    byId: Object.fromEntries(
      projectKeys.map((k) => {
        const [id = "", name = "", ...paths] = k.split(SEP);
        return [id, { id, name, worktrees: paths.map((path) => ({ path, isMain: false })) }];
      }),
    ),
  };
  const workspaces: ProjectsWorkspaces = {
    order: wsKeys.map((k) => k.split(SEP)[0] ?? ""),
    byId: Object.fromEntries(
      wsKeys.map((k) => {
        const [id = "", ...members] = k.split(SEP);
        return [id, { id, members: members.map((projectId) => ({ projectId, worktreePath: "" })) }];
      }),
    ),
  };
  return { projects, workspaces };
}

/**
 * What the filter matches, as strings like useStructure, and only while filtering: names,
 * slugs and branches then rebuild the page too (and git status still does not).
 */
function useSearchInputs(active: boolean): { projects: string[]; workspaces: string[] } {
  const projects = useProjectsStore(
    useShallow((s) => (active ? s.order.map((id) => {
      const r = s.byId[id];
      return [id, r?.name ?? "", r?.githubSlug ?? "", ...(r?.worktrees.flatMap((w) => [w.path, w.branch]) ?? [])].join(SEP);
    }) : [])),
  );
  const workspaces = useWorkspacesStore(useShallow((s) => (active ? s.order.map((id) => [id, s.byId[id]?.name ?? "", ...(s.byId[id]?.members.map((m) => m.projectId) ?? [])].join(SEP)) : [])));
  return { projects, workspaces };
}

function decodeSearch(projectKeys: readonly string[], wsKeys: readonly string[]): ProjectsSearch {
  return {
    projects: Object.fromEntries(
      projectKeys.map((k) => {
        const [id = "", name = "", githubSlug = "", ...rest] = k.split(SEP);
        const branches: Record<string, string> = {};
        for (let i = 0; i + 1 < rest.length; i += 2) branches[rest[i] ?? ""] = rest[i + 1] ?? "";
        return [id, { name, githubSlug, branches }];
      }),
    ),
    workspaces: Object.fromEntries(
      wsKeys.map((k) => {
        const [id = "", name = "", ...members] = k.split(SEP);
        return [id, { name, members }];
      }),
    ),
  };
}

const KIND_ICON: Record<ProjectKind, { Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  github: { Icon: GithubMark, className: "text-cf-info-text/90" },
  git: { Icon: FolderGit2, className: "text-cf-text-muted" },
  nogit: { Icon: Folder, className: "text-cf-text-muted" },
};

const UNKNOWN_PROJECT = { githubSlug: "", remotes: [] };

/**
 * One worktree of a project. `cleanupSlot`: some row of the project can be cleaned up,
 * so every row keeps a fifth action slot (the broom, or empty) and the columns stay
 * aligned; projects with nothing to clean up keep four.
 */
function WorktreeRow({ projectId, path, cleanupSlot }: { projectId: string; path: string; cleanupSlot: boolean }) {
  const isMain = useProjectsStore((s) => findWorktree(s, projectId, path)?.isMain ?? false);
  const cleanable = useCleanable(projectId, path);
  const show: OverflowItem = { label: "Show changes", icon: Diff, testId: "worktree-show-panel", onSelect: () => { openChangesTab("current", projectId, path); } };
  const items: OverflowItem[] = isMain
    ? [show]
    : [show, "separator", { label: "Remove worktree…", icon: Trash2, destructive: true, testId: "worktree-remove", onSelect: () => void removeWorktree(projectId, path) }];
  return (
    <NavRow navKey={projectWorktreeKey(projectId, path)} className="group/wt flex h-full items-center gap-2 rounded-md pr-2 pl-6 text-body" tip={path}>
      <span className="flex h-full min-w-0 flex-1 items-center" data-testid="project-worktree" data-path={path}>
        <WorktreeState projectId={projectId} path={path} />
      </span>
      {/* Always shown, muted at rest; a fixed width so every row's state column ends at the same x. */}
      <span
        className={cn("flex shrink-0 items-center justify-end opacity-55", cleanupSlot ? "w-30" : "w-24", " transition-opacity group-hover/wt:opacity-100 group-focus-within/wt:opacity-100 group-aria-selected/wt:opacity-100 has-[[aria-expanded=true]]:opacity-100")}
        data-testid="worktree-actions"
      >
        <RowAction label="New thread here" testId="worktree-new-thread" onClick={() => { composeIn(projectId, path); }}>
          <SquarePen />
        </RowAction>
        <RowAction label="New terminal here" testId="worktree-new-terminal" onClick={() => void newTerminalIn(projectId, path)}>
          <SquareTerminal />
        </RowAction>
        <ActionsMenu projectId={projectId} owner={{ kind: "worktree", projectId, path }} from="projects" testId="worktree-actions-menu" />
        {cleanable ? (
          <RowAction label="Clean up: remove this worktree" testId="worktree-cleanup" className="text-cf-success-text hover:text-cf-success-text" onClick={() => void cleanupWorktree(projectId, path)}>
            <Broom />
          </RowAction>
        ) : (
          cleanupSlot && <span className="size-6 shrink-0" aria-hidden />
        )}
        <OverflowMenu label="More actions" testId="worktree-more" items={items} />
      </span>
    </NavRow>
  );
}

/** The main worktree's last git status refresh ("updated 2m ago", amber when stale, red after an error). */
function ProjectFreshness({ projectId, main }: { projectId: string; main: string }) {
  const at = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.refreshedAtMs ?? null);
  const error = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.error ?? "");
  return (
    <span className="mr-1 shrink-0">
      <Freshness fetchedAtMs={at} lastError={error} staleAfterMs={PROJECT_STALE_MS} testId="project-freshness" />
    </span>
  );
}

/** Fetch (with a remote) and refresh the project's git status; the icon spins meanwhile. */
function RefreshAction({ projectId }: { projectId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <RowAction
      label={busy ? "Refreshing…" : "Fetch and refresh"}
      testId="project-refresh"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void refreshProject(projectId).finally(() => {
          setBusy(false);
        });
      }}
    >
      <RefreshCw className={cn(busy && "animate-spin")} data-busy={busy || undefined} />
    </RowAction>
  );
}

/**
 * A project header's overflow: New worktree… (git), New action… (the action editor),
 * Clean up merged worktrees (git with a remote: merged means in origin/<default>;
 * disabled at 0), its setup step, then Remove project.
 */
function projectMenu(projectId: string, kind: ProjectKind, step: ProjectNextStep, cleanup: number | null): OverflowItem[] {
  const items: OverflowItem[] = [];
  if (kind !== "nogit") items.push({ label: "New worktree…", icon: GitBranchPlus, testId: "project-new-worktree", onSelect: () => { newWorktreeIn(projectId); } });
  items.push({ label: "New action…", icon: Play, testId: "project-new-action", onSelect: () => { openActionEditor({ mode: "new", projectId, from: "projects" }); } });
  if (cleanup !== null) {
    items.push({ label: "Clean up merged worktrees", icon: Broom, testId: "project-cleanup", badge: cleanup, disabled: cleanup === 0, onSelect: () => void cleanupMergedWorktrees(projectId) });
  }
  if (step === "publish") items.push({ label: "Publish to GitHub…", icon: CloudUpload, testId: "project-menu-publish", onSelect: () => { publishProject(projectId); } });
  if (step === "init") items.push({ label: "Initialize git", icon: GitBranchPlus, testId: "project-menu-init-git", onSelect: () => void initGitIn(projectId) });
  if (items.length > 0) items.push("separator");
  items.push({ label: "Remove project", icon: Unlink, destructive: true, testId: "project-unregister", onSelect: () => void unregisterProject(projectId) });
  return items;
}

function ProjectBlock({ project, collapsed, filtering }: { project: ProjectModel; collapsed: boolean; filtering: boolean }) {
  const { projectId } = project;
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const main = useProjectsStore((s) => s.byId[projectId]?.worktrees.find((w) => w.isMain)?.path ?? s.byId[projectId]?.path ?? "");
  const kind = useProjectsStore(useShallow((s) => projectKind(s.byId[projectId] ?? UNKNOWN_PROJECT)));
  const step = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? projectNextStep(r) : null;
  });
  const hasRemote = useProjectsStore((s) => (s.byId[projectId]?.remotes.length ?? 0) > 0);
  const cleanable = useCleanableCount(projectId);
  const { Icon, className: iconClass } = KIND_ICON[kind.kind];
  return (
    <section className="group/card rounded-lg border" data-testid="project" data-project={projectId} data-git={kind.kind !== "nogit"} data-kind={kind.kind} data-collapsed={collapsed}>
      <NavRow navKey={projectKey(projectId)} className={cn("group/p flex h-9 items-center gap-2 rounded-lg px-2", !collapsed && "rounded-b-none border-b")}>
        <CollapseToggle
          collapsed={collapsed}
          disabled={filtering}
          label={name}
          testId="project-collapse"
          onToggle={() => {
            useUiStore.getState().setProjectCollapsed(projectId, !collapsed);
          }}
        />
        <Tip label={kind.title}>
          <span className="flex shrink-0" data-testid="project-kind-icon">
            <Icon className={cn("size-4", iconClass)} />
          </span>
        </Tip>
        <span className="truncate font-medium" data-testid="project-name">
          {name}
        </span>
        {kind.kind === "nogit" ? (
          <NoGitBadge />
        ) : (
          <span className="min-w-0 truncate text-caption" data-testid="project-meta">
            {kind.meta}
          </span>
        )}
        {collapsed && (
          <span className="shrink-0 text-caption tabular-nums" data-testid="project-collapsed-summary">
            {collapsedProjectSummary(project)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {kind.kind !== "nogit" && <ProjectFreshness projectId={projectId} main={main} />}
          <span
            className="flex items-center opacity-70 transition-opacity group-hover/card:opacity-100 group-focus-within/p:opacity-100 group-aria-selected/p:opacity-100 has-[[aria-expanded=true]]:opacity-100"
            data-testid="project-actions"
          >
            {kind.kind !== "nogit" && <RefreshAction projectId={projectId} />}
            {step === "publish" && (
              <RowAction label="Publish to GitHub" testId="project-publish" onClick={() => { publishProject(projectId); }}>
                <CloudUpload />
              </RowAction>
            )}
            {step === "init" && (
              <RowAction label="Initialize git" testId="project-init-git" onClick={() => void initGitIn(projectId)}>
                <GitBranchPlus />
              </RowAction>
            )}
            <RowAction label="New thread" testId="project-new-thread" onClick={() => { composeIn(projectId); }}>
              <SquarePen />
            </RowAction>
            <RowAction label="New terminal" testId="project-new-terminal" onClick={() => void newTerminalIn(projectId, main)}>
              <SquareTerminal />
            </RowAction>
            <OverflowMenu label="More project actions" testId="project-more" items={projectMenu(projectId, kind.kind, step, kind.kind !== "nogit" && hasRemote ? cleanable : null)} />
          </span>
        </span>
      </NavRow>
      {!collapsed && (
        <div className="p-0.5">
          <RowList rows={project.worktrees} rowKey={(p) => projectWorktreeKey(projectId, p)} rowHeight={ROW_H} render={(p) => <WorktreeRow projectId={projectId} path={p} cleanupSlot={cleanable > 0} />} />
        </div>
      )}
    </section>
  );
}

/**
 * The Projects page: what the sidebar's project tree used to show. Per project its
 * worktrees (every one: a thread's checkouts show under their projects) with git and pull
 * request state and actions (new thread, new terminal, remove worktree, unregister); per
 * workspace a card (WorkspaceCard: name, root, projects, where threads start, instructions,
 * skills). Projects and workspaces collapse (persisted in the UI store); the header's
 * filter narrows both. Keyboard: ↑/↓ move, →/← expand or collapse a header, Enter (like
 * double-click) shows a project, worktree or workspace member in the page's side panel, or
 * opens a workspace's composer; / goes to the filter, Escape there clears it and comes back.
 */
export function ProjectsPage() {
  const structure = useStructure();
  const [query, setQuery] = useState("");
  const filtering = query.trim() !== "";
  const search = useSearchInputs(filtering);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const collapsedWorkspaces = useUiStore((s) => s.collapsedWorkspaces);
  const { all, model, collapsed, items } = useMemo(() => {
    const { projects, workspaces } = decode(structure.projects, structure.workspaces);
    const m = projectsModel(projects, workspaces);
    // While filtering, every match shows expanded; the saved collapsed sets stay as they are.
    const shown = filtering ? filterProjects(m, query, decodeSearch(search.projects, search.workspaces)) : m;
    const c: Collapsed = filtering ? NONE_COLLAPSED : { projects: new Set(collapsedProjects), workspaces: new Set(collapsedWorkspaces) };
    return { all: m, model: shown, collapsed: c, items: pageItems(shown, workspaces, c, (id) => projects.byId[id]?.name || undefined) };
  }, [structure.projects, structure.workspaces, filtering, query, search.projects, search.workspaces, collapsedProjects, collapsedWorkspaces]);
  const navItems = useMemo<NavItem[]>(
    () =>
      items.map((it) => {
        switch (it.kind) {
          // Enter or double-click shows the worktree's (a project's main one's) Changes tab in the page's side panel.
          case "project":
            return {
              key: it.key,
              activate: () => { openChangesTab("current", it.projectId, mainWorktreePath(useProjectsStore.getState(), it.projectId)); },
              toggle: (open) => !filtering && useUiStore.getState().setProjectCollapsed(it.projectId, !open),
            };
          case "worktree":
            return { key: it.key, activate: () => { openChangesTab("current", it.projectId, it.path); } };
          // A workspace member: its project's main worktree's changes; an unregistered one (no worktree to show) opens nothing.
          case "member":
            return {
              key: it.key,
              activate: () => {
                const at = mainWorktreePath(useProjectsStore.getState(), it.projectId);
                if (at) openChangesTab("current", it.projectId, at);
              },
            };
          case "workspace":
            return {
              key: it.key,
              activate: () => { composeInWorkspace(it.workspaceId); },
              toggle: (open) => !filtering && useUiStore.getState().setWorkspaceCollapsed(it.workspaceId, !open),
            };
        }
      }),
    [items, filtering],
  );
  const nav = useNav(navItems);
  // A row asked for from elsewhere (a workspace just added): the cursor goes there once it shows.
  const reveal = useProjectsPageStore((s) => s.reveal);
  const setCursor = nav.ctx.setCursor;
  useEffect(() => {
    if (reveal === null || !items.some((it) => it.key === reveal)) return;
    setCursor(reveal);
    clearProjectsPageReveal(reveal);
  }, [reveal, items, setCursor]);
  const loaded = useProjectsStore((s) => s.loaded);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Projects" data-testid="projects-page">
      <PaneHeader className="gap-3 px-5">
        <FolderGit2 className="size-4 text-cf-text-muted" aria-hidden />
        <h1 className="text-heading">Projects</h1>
        <span className="text-caption whitespace-nowrap tabular-nums" data-testid="projects-counts">
          {all.projects.length} {all.projects.length === 1 ? "project" : "projects"} · {all.workspaces.length} {all.workspaces.length === 1 ? "workspace" : "workspaces"}
        </span>
        <div className="relative ml-1 flex w-[220px] min-w-0 shrink items-center [--wails-draggable:no-drag]">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-cf-text-muted" aria-hidden />
          <Input
            ref={filterRef}
            type="text"
            value={query}
            placeholder="Filter…"
            aria-label="Filter projects and workspaces"
            spellCheck={false}
            autoComplete="off"
            data-testid="projects-filter"
            // The pane header's compact size.
            className="h-7 pr-7 pl-7 text-body-sm"
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              setQuery("");
              rootRef.current?.focus({ preventScroll: true });
            }}
          />
          {!query && (
            <Kbd size="sm" className="absolute right-2" aria-hidden>
              /
            </Kbd>
          )}
        </div>
        <span className="ml-auto flex items-center gap-1 [--wails-draggable:no-drag]">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="projects-register"
            onClick={() => {
              addProject();
            }}
          >
            <FolderPlus />
            Add project
          </Button>
        </span>
        <span className="-mr-2 flex items-center">
          <BottomToggle />
          <PanelToggle />
        </span>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <NavProvider value={nav.ctx}>
          <div
            ref={rootRef}
            tabIndex={0}
            role="listbox"
            aria-label="Projects and workspaces"
            aria-activedescendant={nav.activeDescendant}
            className="mx-auto flex max-w-5xl flex-col gap-6 outline-none"
            data-testid="projects-list"
            data-focus-root
            onKeyDown={(e) => {
              if (e.key === "/" && e.target === e.currentTarget && !e.metaKey && !e.ctrlKey && !e.altKey) {
                e.preventDefault();
                filterRef.current?.focus();
                return;
              }
              nav.onKeyDown(e);
            }}
          >
            <div className="flex flex-col gap-3" data-testid="projects-section">
              <SectionTitle count={model.projects.length}>Projects</SectionTitle>
              {all.projects.length === 0 ? (
                <p className="px-2 text-body text-cf-text-muted">{loaded ? "No projects registered. Add a folder or a git repository to start threads in it." : "Loading…"}</p>
              ) : model.projects.length === 0 ? (
                <p className="px-2 text-body text-cf-text-muted" data-testid="projects-no-matches">
                  No matches.
                </p>
              ) : (
                model.projects.map((p) => <ProjectBlock key={p.projectId} project={p} collapsed={collapsed.projects.has(p.projectId)} filtering={filtering} />)
              )}
            </div>
            <div className="flex flex-col gap-3" data-testid="workspaces-section">
              <SectionTitle
                count={model.workspaces.length}
                extra={
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="text-cf-text-muted hover:text-cf-text"
                    data-testid="projects-new-workspace"
                    onClick={() => {
                      openNewWorkspaceDialog();
                    }}
                  >
                    <Layers />
                    New workspace
                  </Button>
                }
              >
                Workspaces
              </SectionTitle>
              {all.workspaces.length === 0 ? (
                <p className="px-2 text-body text-cf-text-muted" data-testid="workspaces-empty">
                  No workspaces. A workspace is a set of projects you start threads in together, with instructions and skills that span them: New workspace,
                  or <span className="font-mono">code-foundry workspace new</span>.
                </p>
              ) : model.workspaces.length === 0 ? (
                <p className="px-2 text-body text-cf-text-muted" data-testid="workspaces-no-matches">
                  No matches.
                </p>
              ) : (
                model.workspaces.map((id) => <WorkspaceCard key={id} id={id} collapsed={collapsed.workspaces.has(id)} filtering={filtering} />)
              )}
            </div>
          </div>
        </NavProvider>
      </div>
    </section>
  );
}

/** Sidebar entry under Pull Requests. */
export function ProjectsNav() {
  const active = useUiStore((s) => s.selection.kind === "view" && s.selection.name === "projects");
  return (
    <button
      type="button"
      className={cn(
        "mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-body-sm",
        active ? "bg-cf-sidebar-row-selected text-cf-sidebar-foreground" : "text-cf-sidebar-foreground hover:bg-cf-sidebar-row-hover",
      )}
      data-testid="nav-projects"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useUiStore.getState().select({ kind: "view", name: "projects" });
      }}
    >
      <FolderGit2 className="size-4 shrink-0 text-cf-icon-muted" aria-hidden />
      <span className="truncate">Projects</span>
    </button>
  );
}
