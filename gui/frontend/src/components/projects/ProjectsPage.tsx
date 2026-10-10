import { useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import { FolderGit2, FolderOpen, FolderPlus, Layers, Sparkles, SquareTerminal, Trash2, Unlink } from "lucide-react";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { SectionTitle } from "@/components/prs/PrBits";
import { RowList } from "@/components/prs/RowList";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import { pageItems, projectKey, projectsModel, projectWorktreeKey, workspaceKey, type ProjectModel, type ProjectsWorkspaces } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { composeIn, composeInWorkspace } from "@/stores/compose";
import { newTerminalIn, openProject, openWorktree, registerProject, removeWorkspace, removeWorktree, unregisterProject } from "@/stores/projectActions";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
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

function WorktreeRow({ repoId, path }: { repoId: string; path: string }) {
  const isMain = useReposStore((s) => findWorktree(s, repoId, path)?.isMain ?? false);
  return (
    <NavRow navKey={projectWorktreeKey(repoId, path)} className="group/wt flex h-full items-center gap-2 pr-2 pl-6 text-sm" title={`${path}\nEnter or double-click: open the worktree`}>
      <span className="flex h-full min-w-0 flex-1 items-center" data-testid="project-worktree" data-path={path}>
        <WorktreeState repoId={repoId} path={path} />
      </span>
      <span className="flex shrink-0 items-center opacity-0 group-hover/wt:opacity-100 group-aria-selected/wt:opacity-100">
        <RowAction label="Open worktree" testId="worktree-open" onClick={() => { openWorktree(repoId, path); }}>
          <FolderOpen />
        </RowAction>
        <RowAction label="New thread here" testId="worktree-new-thread" onClick={() => { composeIn(repoId, path); }}>
          <Sparkles />
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

function ProjectBlock({ project }: { project: ProjectModel }) {
  const { repoId } = project;
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  const slug = useReposStore((s) => s.byId[repoId]?.githubSlug ?? "");
  const main = useReposStore((s) => s.byId[repoId]?.worktrees.find((w) => w.isMain)?.path ?? s.byId[repoId]?.path ?? "");
  return (
    <section className="rounded-md border" data-testid="project" data-repo={repoId}>
      <NavRow navKey={projectKey(repoId)} className="group/p flex h-9 items-center gap-2 rounded-b-none border-b px-2" title="Enter or double-click: open the project's overview">
        <FolderGit2 className="size-4 shrink-0 text-sky-400/90" aria-hidden />
        <span className="truncate font-medium" data-testid="project-name">
          {name}
        </span>
        {slug && <span className="min-w-0 truncate text-xs text-muted-foreground">{slug}</span>}
        <span className="ml-auto flex shrink-0 items-center">
          <RowAction label="New thread" testId="project-new-thread" onClick={() => { composeIn(repoId); }}>
            <Sparkles />
          </RowAction>
          <RowAction label="New terminal" testId="project-new-terminal" onClick={() => void newTerminalIn(repoId, main)}>
            <SquareTerminal />
          </RowAction>
          <RowAction label="Remove project (stop tracking it)" destructive testId="project-unregister" onClick={() => void unregisterProject(repoId)}>
            <Unlink />
          </RowAction>
        </span>
      </NavRow>
      <div className="p-0.5">
        <RowList rows={project.worktrees} rowKey={(p) => projectWorktreeKey(repoId, p)} rowHeight={ROW_H} render={(p) => <WorktreeRow repoId={repoId} path={p} />} />
        {project.inWorkspaces > 0 && (
          <p className="px-6 py-1 text-xs text-muted-foreground" data-testid="project-in-workspaces">
            {project.inWorkspaces} {project.inWorkspaces === 1 ? "worktree is" : "worktrees are"} in workspaces (below)
          </p>
        )}
      </div>
    </section>
  );
}

function WorkspaceBlock({ id }: { id: string }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const branch = useWorkspacesStore((s) => s.byId[id]?.branch ?? "");
  return (
    <section className="rounded-md border" data-testid="workspace" data-workspace={id}>
      <NavRow navKey={workspaceKey(id)} className="group/ws flex h-9 items-center gap-2 rounded-b-none border-b px-2" title="Enter or double-click: new thread in this workspace">
        <Layers className="size-4 shrink-0 text-violet-400/90" aria-hidden />
        <span className="truncate font-medium" data-testid="workspace-name">
          {name}
        </span>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" data-testid="workspace-branch">
          {branch}
        </span>
        <span className="ml-auto flex shrink-0 items-center">
          <RowAction label="New thread in this workspace" testId="workspace-new-thread" onClick={() => { composeInWorkspace(id); }}>
            <Sparkles />
          </RowAction>
          <RowAction label="Remove workspace" destructive testId="workspace-remove" onClick={() => void removeWorkspace(id)}>
            <Trash2 />
          </RowAction>
        </span>
      </NavRow>
      <div className="p-0.5 pb-1.5">
        <WorkspaceMembers workspaceId={id} />
      </div>
    </section>
  );
}

/**
 * The Projects page: what the sidebar's repository tree used to show. Per project its
 * own worktrees with git and pull request state and actions (new thread, new terminal,
 * remove worktree, unregister); per workspace its members (add, remove, remove the
 * workspace). Workspace member worktrees are listed under their workspace only.
 * Keyboard: ↑/↓ move, Enter opens (a worktree's overview, a workspace's composer).
 */
export function ProjectsPage() {
  const structure = useStructure();
  const { model, items } = useMemo(() => {
    const { repos, workspaces } = decode(structure.repos, structure.workspaces);
    const m = projectsModel(repos, workspaces);
    return { model: m, items: pageItems(m, workspaces) };
  }, [structure.repos, structure.workspaces]);
  const navItems = useMemo<NavItem[]>(
    () =>
      items.map((it) => {
        switch (it.kind) {
          case "project":
            return { key: it.key, activate: () => { openProject(it.repoId); } };
          case "worktree":
          case "member":
            return { key: it.key, activate: () => { openWorktree(it.repoId, it.path); } };
          case "workspace":
            return { key: it.key, activate: () => { composeInWorkspace(it.workspaceId); } };
        }
      }),
    [items],
  );
  const nav = useNav(navItems);
  const loaded = useReposStore((s) => s.loaded);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Projects" data-testid="projects-page">
      <PaneHeader className="gap-3 px-5">
        <FolderGit2 className="size-4 text-muted-foreground" aria-hidden />
        <h1 className="text-sm font-semibold">Projects</h1>
        <span className="text-xs text-muted-foreground tabular-nums" data-testid="projects-counts">
          {model.projects.length} {model.projects.length === 1 ? "project" : "projects"} · {model.workspaces.length} {model.workspaces.length === 1 ? "workspace" : "workspaces"}
        </span>
        <span className="ml-auto flex items-center gap-1 [--wails-draggable:no-drag]">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="projects-register"
            onClick={() => {
              registerProject();
            }}
          >
            <FolderPlus />
            Add project
          </Button>
        </span>
        <PanelToggle className="-mr-2" />
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
            onKeyDown={nav.onKeyDown}
          >
            <div className="flex flex-col gap-3" data-testid="projects-section">
              <SectionTitle count={model.projects.length}>Projects</SectionTitle>
              {model.projects.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">{loaded ? "No projects registered. Add a git repository to start threads in it." : "Loading…"}</p>
              ) : (
                model.projects.map((p) => <ProjectBlock key={p.repoId} project={p} />)
              )}
            </div>
            <div className="flex flex-col gap-3" data-testid="workspaces-section">
              <SectionTitle count={model.workspaces.length}>Workspaces</SectionTitle>
              {model.workspaces.length === 0 ? (
                <p className="px-2 text-sm text-muted-foreground">
                  No workspaces. A workspace is one branch across several projects: start one from the composer with “Also in…”, or with{" "}
                  <span className="font-mono">code-foundry workspace new</span>.
                </p>
              ) : (
                model.workspaces.map((id) => <WorkspaceBlock key={id} id={id} />)
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
        "mx-1.5 mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-[13px]",
        active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent/60",
      )}
      data-testid="nav-projects"
      aria-current={active ? "page" : undefined}
      title="Projects"
      onClick={() => {
        useUiStore.getState().select({ kind: "view", name: "projects" });
      }}
    >
      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">Projects</span>
    </button>
  );
}
