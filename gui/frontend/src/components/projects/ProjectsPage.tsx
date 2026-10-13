import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronRight, Folder, FolderGit2, FolderPlus, Layers, PanelRight, Search, SquarePen, SquareTerminal, Trash2, Unlink } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { GithubMark } from "@/components/icons/GithubMark";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { SectionTitle } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import {
  collapsedProjectSummary,
  collapsedWorkspaceSummary,
  filterProjects,
  NONE_COLLAPSED,
  pageItems,
  projectKey,
  projectKind,
  projectsModel,
  projectWorktreeKey,
  workspaceKey,
  type Collapsed,
  type ProjectKind,
  type ProjectModel,
  type ProjectsSearch,
  type ProjectsWorkspaces,
} from "@/lib/projects";
import { cn } from "@/lib/utils";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import { addProject, newTerminalIn, removeWorkspace, removeWorktree, unregisterProject } from "@/stores/projectActions";
import { findWorktree, mainWorktreePath, useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { showWorkspaceInThread } from "@/stores/workspacePanel";
import { showWorktreeInPanel } from "@/stores/worktreePanel";
import { useWorkspacesStore } from "@/stores/workspaces";
import { liveWorkspaceThread } from "@/surfaces/workspaceTarget";
import { NoGitBadge } from "./NoGitBadge";
import { WorkspaceMembers } from "./WorkspaceMembers";
import { RowAction, WorktreeState } from "./WorktreeState";

const ROW_H = 32;
const SEP = "\u0001";

/** The page's structure inputs as strings, so it rebuilds on membership changes only (not git status). */
function useStructure(): { repos: string[]; workspaces: string[] } {
  const repos = useReposStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
  const workspaces = useWorkspacesStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.members.flatMap((m) => [m.repoId, m.worktreePath]) ?? [])].join(SEP))));
  return { repos, workspaces };
}

function decode(repoKeys: readonly string[], wsKeys: readonly string[]) {
  const repos = {
    order: repoKeys.map((k) => k.split(SEP)[0] ?? ""),
    byId: Object.fromEntries(
      repoKeys.map((k) => {
        const [id = "", ...paths] = k.split(SEP);
        return [id, { id, name: id, worktrees: paths.map((path) => ({ path, isMain: false })) }];
      }),
    ),
  };
  const workspaces: ProjectsWorkspaces = {
    order: wsKeys.map((k) => k.split(SEP)[0] ?? ""),
    byId: Object.fromEntries(
      wsKeys.map((k) => {
        const [id = "", ...rest] = k.split(SEP);
        const members = [];
        for (let i = 0; i + 1 < rest.length; i += 2) members.push({ repoId: rest[i] ?? "", worktreePath: rest[i + 1] ?? "" });
        return [id, { id, members }];
      }),
    ),
  };
  return { repos, workspaces };
}

/**
 * What the filter matches, as strings like useStructure, and only while filtering: names,
 * slugs and branches then rebuild the page too (and git status still does not).
 */
function useSearchInputs(active: boolean): { repos: string[]; workspaces: string[] } {
  const repos = useReposStore(
    useShallow((s) => (active ? s.order.map((id) => {
      const r = s.byId[id];
      return [id, r?.name ?? "", r?.githubSlug ?? "", ...(r?.worktrees.flatMap((w) => [w.path, w.branch]) ?? [])].join(SEP);
    }) : [])),
  );
  const workspaces = useWorkspacesStore(useShallow((s) => (active ? s.order.map((id) => [id, s.byId[id]?.name ?? "", s.byId[id]?.branch ?? ""].join(SEP)) : [])));
  return { repos, workspaces };
}

function decodeSearch(repoKeys: readonly string[], wsKeys: readonly string[]): ProjectsSearch {
  return {
    repos: Object.fromEntries(
      repoKeys.map((k) => {
        const [id = "", name = "", githubSlug = "", ...rest] = k.split(SEP);
        const branches: Record<string, string> = {};
        for (let i = 0; i + 1 < rest.length; i += 2) branches[rest[i] ?? ""] = rest[i + 1] ?? "";
        return [id, { name, githubSlug, branches }];
      }),
    ),
    workspaces: Object.fromEntries(
      wsKeys.map((k) => {
        const [id = "", name = "", branch = ""] = k.split(SEP);
        return [id, { name, branch }];
      }),
    ),
  };
}

/**
 * The chevron at the left of a project or workspace header. Mouse-down keeps the focus
 * where it is (the list, so the arrow keys keep working); disabled while the filter shows
 * everything that matches expanded.
 */
function CollapseToggle({ collapsed, disabled, onToggle, testId, label }: { collapsed: boolean; disabled: boolean; onToggle: () => void; testId: string; label: string }) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-expanded={!collapsed}
      aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
      disabled={disabled}
      data-testid={testId}
      className="-ml-1 flex size-[18px] shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent [&_svg]:size-3.5"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
      onDoubleClick={(e) => {
        // Quick toggles must not open the row's panel tab.
        e.stopPropagation();
      }}
      onClick={onToggle}
    >
      <Chevron aria-hidden />
    </button>
  );
}

const KIND_ICON: Record<ProjectKind, { Icon: React.ComponentType<{ className?: string }>; className: string }> = {
  github: { Icon: GithubMark, className: "text-sky-400/90" },
  git: { Icon: FolderGit2, className: "text-muted-foreground" },
  nogit: { Icon: Folder, className: "text-muted-foreground" },
};

const UNKNOWN_REPO = { githubSlug: "", remotes: [] };

function WorktreeRow({ repoId, path }: { repoId: string; path: string }) {
  const isMain = useReposStore((s) => findWorktree(s, repoId, path)?.isMain ?? false);
  return (
    <NavRow navKey={projectWorktreeKey(repoId, path)} className="group/wt flex h-full items-center gap-2 pr-2 pl-6 text-sm" title={path}>
      <span className="flex h-full min-w-0 flex-1 items-center" data-testid="project-worktree" data-path={path}>
        <WorktreeState repoId={repoId} path={path} />
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-hover/wt:opacity-100 group-aria-selected/wt:opacity-100">
        <RowAction label="New thread here" testId="worktree-new-thread" onClick={() => { composeIn(repoId, path); }}>
          <SquarePen />
        </RowAction>
        <RowAction label="New terminal here" testId="worktree-new-terminal" onClick={() => void newTerminalIn(repoId, path)}>
          <SquareTerminal />
        </RowAction>
        {!isMain && (
          <RowAction label="Remove worktree" destructive testId="worktree-remove" onClick={() => void removeWorktree(repoId, path)}>
            <Trash2 />
          </RowAction>
        )}
      </span>
    </NavRow>
  );
}

function ProjectBlock({ project, collapsed, filtering }: { project: ProjectModel; collapsed: boolean; filtering: boolean }) {
  const { repoId } = project;
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  const main = useReposStore((s) => s.byId[repoId]?.worktrees.find((w) => w.isMain)?.path ?? s.byId[repoId]?.path ?? "");
  const kind = useReposStore(useShallow((s) => projectKind(s.byId[repoId] ?? UNKNOWN_REPO)));
  const { Icon, className: iconClass } = KIND_ICON[kind.kind];
  return (
    <section className="rounded-md border" data-testid="project" data-repo={repoId} data-git={kind.kind !== "nogit"} data-kind={kind.kind} data-collapsed={collapsed}>
      <NavRow navKey={projectKey(repoId)} className={cn("group/p flex h-9 items-center gap-2 px-2", !collapsed && "rounded-b-none border-b")}>
        <CollapseToggle
          collapsed={collapsed}
          disabled={filtering}
          label={name}
          testId="project-collapse"
          onToggle={() => {
            useUiStore.getState().setProjectCollapsed(repoId, !collapsed);
          }}
        />
        <span className="flex shrink-0" title={kind.title} data-testid="project-kind-icon">
          <Icon className={cn("size-4", iconClass)} />
        </span>
        <span className="truncate font-medium" data-testid="project-name">
          {name}
        </span>
        {kind.kind === "nogit" ? (
          <NoGitBadge />
        ) : (
          <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="project-meta">
            {kind.meta}
          </span>
        )}
        {collapsed && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="project-collapsed-summary">
            {collapsedProjectSummary(project)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          <RowAction label="New thread" testId="project-new-thread" onClick={() => { composeIn(repoId); }}>
            <SquarePen />
          </RowAction>
          <RowAction label="New terminal" testId="project-new-terminal" onClick={() => void newTerminalIn(repoId, main)}>
            <SquareTerminal />
          </RowAction>
          <RowAction label="Remove project (stop tracking it)" destructive testId="project-unregister" onClick={() => void unregisterProject(repoId)}>
            <Unlink />
          </RowAction>
        </span>
      </NavRow>
      {!collapsed && (
        <div className="p-0.5">
          <RowList rows={project.worktrees} rowKey={(p) => projectWorktreeKey(repoId, p)} rowHeight={ROW_H} render={(p) => <WorktreeRow repoId={repoId} path={p} />} />
          {project.inWorkspaces > 0 && (
            <p className="px-6 py-1 text-xs text-muted-foreground" data-testid="project-in-workspaces">
              {project.inWorkspaces} {project.inWorkspaces === 1 ? "worktree is" : "worktrees are"} in workspaces (below)
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function WorkspaceBlock({ id, collapsed, filtering }: { id: string; collapsed: boolean; filtering: boolean }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const branch = useWorkspacesStore((s) => s.byId[id]?.branch ?? "");
  const members = useWorkspacesStore((s) => s.byId[id]?.members.length ?? 0);
  // A live thread of the workspace: the row can show the workspace surface in its panel.
  const thread = useSessionsStore((s) => liveWorkspaceThread(s, id));
  const threadName = useSessionsStore((s) => (thread ? s.byId[thread]?.name || thread : ""));
  return (
    <section className="rounded-md border" data-testid="workspace" data-workspace={id} data-collapsed={collapsed}>
      <NavRow navKey={workspaceKey(id)} className={cn("group/ws flex h-9 items-center gap-2 px-2", !collapsed && "rounded-b-none border-b")}>
        <CollapseToggle
          collapsed={collapsed}
          disabled={filtering}
          label={name}
          testId="workspace-collapse"
          onToggle={() => {
            useUiStore.getState().setWorkspaceCollapsed(id, !collapsed);
          }}
        />
        <Layers className="size-4 shrink-0 text-violet-400/90" aria-hidden />
        <span className="truncate font-medium" data-testid="workspace-name">
          {name}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="workspace-branch">
          {branch}
        </span>
        {collapsed && (
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="workspace-collapsed-summary">
            {collapsedWorkspaceSummary(members)}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center">
          {thread && (
            <RowAction label={`Show in ${threadName}'s side panel`} testId="workspace-show-panel" onClick={() => { showWorkspaceInThread(thread); }}>
              <PanelRight />
            </RowAction>
          )}
          <RowAction label="New thread in this workspace" testId="workspace-new-thread" onClick={() => { composeInWorkspace(id); }}>
            <SquarePen />
          </RowAction>
          <RowAction label="Remove workspace" destructive testId="workspace-remove" onClick={() => void removeWorkspace(id)}>
            <Trash2 />
          </RowAction>
        </span>
      </NavRow>
      {!collapsed && (
        <div className="p-0.5 pb-1.5">
          <WorkspaceMembers workspaceId={id} />
        </div>
      )}
    </section>
  );
}

/**
 * The Projects page: what the sidebar's repository tree used to show. Per project its
 * own worktrees with git and pull request state and actions (new thread, new terminal,
 * remove worktree, unregister); per workspace its members (add, remove, remove the
 * workspace). Workspace member worktrees are listed under their workspace only. Projects
 * and workspaces collapse (persisted in the UI store); the header's filter narrows both.
 * Keyboard: ↑/↓ move, →/← expand or collapse a header, Enter (like double-click) shows a
 * project or worktree in the page's side panel, or opens a workspace's composer; / goes
 * to the filter, Escape there clears it and comes back.
 */
export function ProjectsPage() {
  const structure = useStructure();
  const [query, setQuery] = useState("");
  const filtering = query.trim() !== "";
  const search = useSearchInputs(filtering);
  const collapsedProjects = useUiStore((s) => s.collapsedProjects);
  const collapsedWorkspaces = useUiStore((s) => s.collapsedWorkspaces);
  const { all, model, collapsed, items } = useMemo(() => {
    const { repos, workspaces } = decode(structure.repos, structure.workspaces);
    const m = projectsModel(repos, workspaces);
    // While filtering, every match shows expanded; the saved collapsed sets stay as they are.
    const shown = filtering ? filterProjects(m, query, decodeSearch(search.repos, search.workspaces)) : m;
    const c: Collapsed = filtering ? NONE_COLLAPSED : { projects: new Set(collapsedProjects), workspaces: new Set(collapsedWorkspaces) };
    return { all: m, model: shown, collapsed: c, items: pageItems(shown, workspaces, c) };
  }, [structure.repos, structure.workspaces, filtering, query, search.repos, search.workspaces, collapsedProjects, collapsedWorkspaces]);
  const navItems = useMemo<NavItem[]>(
    () =>
      items.map((it) => {
        switch (it.kind) {
          // Enter or double-click shows the worktree (a project's main one) in the page's side panel.
          case "project":
            return {
              key: it.key,
              activate: () => { showWorktreeInPanel(it.repoId, mainWorktreePath(useReposStore.getState(), it.repoId)); },
              toggle: (open) => !filtering && useUiStore.getState().setProjectCollapsed(it.repoId, !open),
            };
          case "worktree":
          case "member":
            return { key: it.key, activate: () => { showWorktreeInPanel(it.repoId, it.path); } };
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
  const loaded = useReposStore((s) => s.loaded);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Projects" data-testid="projects-page">
      <PaneHeader className="gap-3 px-5">
        <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-semibold">Projects</h1>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="projects-counts">
          {all.projects.length} {all.projects.length === 1 ? "project" : "projects"} · {all.workspaces.length} {all.workspaces.length === 1 ? "workspace" : "workspaces"}
        </span>
        <label className="relative ml-1 flex w-[220px] min-w-0 shrink items-center [--wails-draggable:no-drag]">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" aria-hidden />
          <input
            ref={filterRef}
            type="text"
            value={query}
            placeholder="Filter…"
            aria-label="Filter projects and workspaces"
            spellCheck={false}
            autoComplete="off"
            data-testid="projects-filter"
            className="h-7 w-full rounded-md border border-input bg-background pr-7 pl-7 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
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
            <kbd className="pointer-events-none absolute right-2 rounded-[3px] border px-1 font-sans text-[10px] leading-[14px] text-muted-foreground" aria-hidden>
              /
            </kbd>
          )}
        </label>
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
                <p className="px-2 text-sm text-muted-foreground">{loaded ? "No projects registered. Add a folder or a git repository to start threads in it." : "Loading…"}</p>
              ) : model.projects.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground" data-testid="projects-no-matches">
                  No matches.
                </p>
              ) : (
                model.projects.map((p) => <ProjectBlock key={p.repoId} project={p} collapsed={collapsed.projects.has(p.repoId)} filtering={filtering} />)
              )}
            </div>
            <div className="flex flex-col gap-3" data-testid="workspaces-section">
              <SectionTitle count={model.workspaces.length}>Workspaces</SectionTitle>
              {all.workspaces.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">
                  No workspaces. A workspace is one branch across several projects: start one from the composer with “Also in…”, or with{" "}
                  <span className="font-mono">code-foundry workspace new</span>.
                </p>
              ) : model.workspaces.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground" data-testid="workspaces-no-matches">
                  No matches.
                </p>
              ) : (
                model.workspaces.map((id) => <WorkspaceBlock key={id} id={id} collapsed={collapsed.workspaces.has(id)} filtering={filtering} />)
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
        "mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px]",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
      data-testid="nav-projects"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useUiStore.getState().select({ kind: "view", name: "projects" });
      }}
    >
      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">Projects</span>
    </button>
  );
}
