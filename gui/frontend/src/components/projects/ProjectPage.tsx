import { useEffect, useMemo, useRef, useState } from "react";
import { CloudUpload, Folder, GitBranchPlus, RefreshCw, SquarePen, SquareTerminal, TriangleAlert } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNow } from "@/lib/clock";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { tildify } from "@/lib/path";
import { checkoutsSummary, projectActivity, projectKind, projectNextStep, PROJECT_NARROW_BELOW, refreshedText } from "@/lib/projects";
import { useWidth } from "@/lib/useWidth";
import { cn } from "@/lib/utils";
import { openChangesTab } from "@/stores/changesPanel";
import { composeIn } from "@/stores/compose";
import { initGitIn, newTerminalIn, publishProject, refreshProject } from "@/stores/projectActions";
import { findWorktree, mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { useThreadsStore } from "@/stores/threads";
import { PROJECTS_INDEX, useUiStore } from "@/stores/ui";
import { endProjectRename, startProjectRename, useProjectRenameStore } from "@/stores/projectRename";
import { KindIcon, Pill, SectionHeader } from "./bits";
import { useCheckoutOrder, usePageScroll } from "./pageHooks";
import { useProjectKind } from "@/components/icons/projectKind";
import { CheckoutsTable } from "./CheckoutsTable";
import { LeftoverWorktrees } from "./LeftoverWorktrees";
import { projectMenu } from "./menus";
import { OverflowMenu } from "./OverflowMenu";
import { ProjectsCrumb, PagePicker } from "./PagePicker";
import { ProjectDetails } from "./ProjectDetails";
import { ProjectNameEditor } from "./ProjectNameEditor";
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
        className="size-7 text-cf-text-muted hover:text-cf-text"
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
        <RefreshCw className={cn("size-4", busy && "animate-spin")} data-busy={busy || undefined} />
      </Button>
    </Tip>
  );
}

/** "⚠ Refresh failed · <reason> · 14m ago" in the header while the main checkout's last status read failed. */
function RefreshFailed({ projectId, main }: { projectId: string; main: string }) {
  const error = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.error ?? "");
  const at = useProjectsStore((s) => findWorktree(s, projectId, main)?.status.refreshedAtMs ?? null);
  const now = useNow(30_000);
  if (!error) return null;
  const ago = refreshedText(at, now).replace(/^refreshed /, "");
  return (
    <Tip label={error} whenTruncated>
      <Pill tone="error" className="max-w-96 min-w-0 shrink-0" data-testid="project-refresh-failed">
        <TriangleAlert aria-hidden />
        <span className="min-w-0 truncate">Refresh failed · {error}</span>
        {at !== null && <span className="shrink-0">· {ago}</span>}
      </Pill>
    </Tip>
  );
}

/** A note card at the top of a project page (no remote, no git) with its setup button. */
function KindNote({ icon, children, action }: { icon: React.ReactNode; children: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-cf-surface px-4 py-3" data-testid="project-note">
      <span className="flex shrink-0 text-cf-text-muted [&_svg]:size-4">{icon}</span>
      <p className="min-w-0 flex-1 text-body-sm">{children}</p>
      {action}
    </div>
  );
}

/** A folder without git: no checkouts, so its threads in a sentence and the two ways to start one. */
function ThreadsBlock({ projectId, main }: { projectId: string; main: string }) {
  const working = useThreadsStore((s) => projectActivity(s, projectId).working);
  const counts = useThreadsStore((s) => {
    let open = 0;
    let archived = 0;
    for (const id of s.order) {
      const t = s.byId[id];
      if (!t || (t.projectId !== projectId && !t.projectIds.includes(projectId))) continue;
      if (t.archivedAtMs === null) open++;
      else archived++;
    }
    return `${open === 0 ? "none" : String(open)} open · ${String(archived)} archived`;
  });
  return (
    <div data-testid="project-threads">
      <SectionHeader label="Threads" detail={counts} />
      <div className="rounded-lg border bg-cf-surface px-4 py-3 text-body-sm text-cf-text-muted">
        {working === 0 ? "No thread is working here." : `${String(working)} ${working === 1 ? "thread is" : "threads are"} working here.`}{" "}
        <button type="button" className="text-link hover:underline" data-testid="project-threads-new" onClick={() => { composeIn(projectId); }}>
          New thread
        </button>{" "}
        or{" "}
        <button type="button" className="text-link hover:underline" data-testid="project-threads-terminal" onClick={() => void newTerminalIn(projectId, main)}>
          Terminal
        </button>
        .
      </div>
    </div>
  );
}

/**
 * A project's page: the header (crumb, picker, meta, Refresh, Terminal, New thread, more),
 * a note for a repository without a remote or a folder without git, the Checkouts table
 * (main and the worktrees a thread is on; click or Enter opens a checkout's Changes tab in
 * the page's side panel), Worktrees without threads (LeftoverWorktrees, every other
 * worktree), and Details. Below PROJECT_NARROW_BELOW of content
 * width the Sync column and the slug drop and Terminal and the leftover rows' Remove show
 * their icon only. docs/notes/projects-redesign-1-index.md.
 */
export function ProjectPage({ projectId, pageKey }: { projectId: string; pageKey: string }) {
  const loaded = useProjectsStore((s) => s.loaded);
  const exists = useProjectsStore((s) => s.byId[projectId] !== undefined);
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const kind = useProjectKind(projectId);
  const meta = useProjectsStore((s) => {
    const r = s.byId[projectId];
    if (!r) return "";
    return r.git ? projectKind(r).meta : tildify(r.path);
  });
  const step = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? projectNextStep(r) : null;
  });
  const hasRemote = useProjectsStore((s) => (s.byId[projectId]?.remotes.length ?? 0) > 0);
  const main = useProjectsStore((s) => mainWorktreePath(s, projectId));
  const working = useThreadsStore((s) => projectActivity(s, projectId).working);
  const cleanable = useCleanableCount(projectId);
  const paths = useCheckoutOrder(projectId);
  // The caption counts every worktree, the ones without threads (their own block) too.
  const worktreeCount = useProjectsStore((s) => s.byId[projectId]?.worktrees.length ?? 0);
  const git = kind !== "nogit";
  const renaming = useProjectRenameStore((s) => s.renamingProjectId === projectId);
  // Leaving the page closes its editor (the field's blur has renamed by then).
  useEffect(() => () => { endProjectRename(projectId); }, [projectId]);

  // A project removed while its page shows: back to the index. Only once it was there: a
  // page opened for one just added comes before its event (stores/projectsPage.ts).
  const [seen, setSeen] = useState(exists);
  if (exists && !seen) setSeen(true);
  useEffect(() => {
    if (loaded && seen && !exists) useUiStore.getState().select(PROJECTS_INDEX);
  }, [loaded, seen, exists]);

  // The content pane's width (the side panel takes from it): the scroll box's.
  const [widthRef, width] = useWidth(1200);
  const narrow = width < PROJECT_NARROW_BELOW;
  const navItems = useMemo<NavItem[]>(() => (git ? paths.map((p) => ({ key: `pw:${projectId}::${p}`, activate: () => { openChangesTab("current", projectId, p); } })) : []), [git, paths, projectId]);
  const nav = useNav(navItems);
  const reveal = useProjectsPageStore((s) => s.reveal);
  const setCursor = nav.ctx.setCursor;
  useEffect(() => {
    if (reveal === null || !navItems.some((it) => it.key === reveal)) return;
    setCursor(reveal);
    clearProjectsPageReveal(reveal);
  }, [reveal, navItems, setCursor]);
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = usePageScroll(pageKey, widthRef);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label={name} data-testid="projects-page" data-page="project" data-project={projectId} data-kind={kind} data-narrow={narrow || undefined}>
      <PaneHeader className="gap-2 px-5">
        <ProjectsCrumb />
        {renaming ? (
          <span className="flex min-w-0 shrink-0 items-center gap-2 px-1 [--wails-draggable:no-drag]">
            <KindIcon kind={kind} />
            <ProjectNameEditor
              projectId={projectId}
              name={name}
              onDone={() => {
                endProjectRename(projectId);
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
          <PagePicker icon={<KindIcon kind={kind} />} name={name} currentProject={projectId} />
        )}
        {!narrow && meta && (
          <span className="min-w-0 shrink truncate text-caption text-cf-text-muted" data-testid="project-meta">
            {meta}
          </span>
        )}
        {git && <RefreshFailed projectId={projectId} main={main} />}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 [--wails-draggable:no-drag]">
          {git && <RefreshButton projectId={projectId} />}
          <Tip label={narrow ? "New terminal" : null}>
            <Button type="button" variant="outline" size={narrow ? "icon-sm" : "sm"} className={cn("h-7", narrow && "w-7")} aria-label="New terminal" data-testid="project-terminal" onClick={() => void newTerminalIn(projectId, main)}>
              <SquareTerminal />
              {!narrow && "Terminal"}
            </Button>
          </Tip>
          <Button type="button" size="sm" className="h-7" data-testid="project-new-thread" onClick={() => { composeIn(projectId); }}>
            <SquarePen />
            New thread
          </Button>
          <OverflowMenu label="More project actions" testId="project-more" items={projectMenu(projectId, kind, step, git && hasRemote ? cleanable : null, () => { startProjectRename(projectId); })} />
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
            aria-label={`${name} checkouts`}
            aria-activedescendant={nav.activeDescendant}
            className="mx-auto flex max-w-5xl flex-col gap-6 outline-none"
            data-testid="projects-list"
            data-focus-root
            onKeyDown={nav.onKeyDown}
          >
            {exists && (
              <>
                {step === "publish" && (
                  <KindNote
                    icon={<CloudUpload />}
                    action={
                      <Button type="button" variant="outline" size="sm" className="h-7" data-testid="project-publish" onClick={() => { publishProject(projectId); }}>
                        <CloudUpload />
                        Publish to GitHub…
                      </Button>
                    }
                  >
                    This repository has no remote. Threads can commit, but nothing can be pushed and there are no pull requests.
                  </KindNote>
                )}
                {step === "init" && (
                  <KindNote
                    icon={<Folder />}
                    action={
                      <Button type="button" variant="outline" size="sm" className="h-7" data-testid="project-init-git" onClick={() => void initGitIn(projectId)}>
                        <GitBranchPlus />
                        Initialize git
                      </Button>
                    }
                  >
                    A plain folder, not a git repository. Threads run in it directly, so there are no worktrees, branches or pull requests.
                  </KindNote>
                )}
                {git ? (
                  <div data-testid="project-checkouts">
                    <SectionHeader label="Checkouts" detail={checkoutsSummary(worktreeCount, working)} testId="checkouts-title" />
                    <CheckoutsTable projectId={projectId} paths={paths} columns={{ sync: hasRemote && !narrow, pr: kind === "github", narrow }} />
                  </div>
                ) : (
                  <ThreadsBlock projectId={projectId} main={main} />
                )}
                {git && <LeftoverWorktrees projectId={projectId} narrow={narrow} />}
                <ProjectDetails projectId={projectId} />
              </>
            )}
          </div>
        </NavProvider>
      </div>
    </section>
  );
}
