import { useEffect, useMemo, useRef, useState } from "react";
import { CloudUpload, Folder, GitBranchPlus } from "lucide-react";
import { useProjectKind } from "@/components/icons/projectKind";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider } from "@/lib/NavRow";
import { checkoutsHint, projectActivity, projectNextStep, projectWorktreeKey, PROJECT_TITLE_COMPACT_BELOW } from "@/lib/projects";
import { useWidth } from "@/lib/useWidth";
import { composeIn } from "@/stores/compose";
import { initGitIn, newTerminalIn, publishProject } from "@/stores/projectActions";
import { mainWorktreePath, useProjectsStore } from "@/stores/projects";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { endProjectRename, useProjectRenameStore } from "@/stores/projectRename";
import { useThreadsStore } from "@/stores/threads";
import { PROJECTS_INDEX, useUiStore } from "@/stores/ui";
import { KindIcon, SectionHeader } from "./bits";
import { CheckoutsTable } from "./CheckoutsTable";
import { LeftoverWorktrees } from "./LeftoverWorktrees";
import { useCheckoutOrder, useLeftoverPaths, usePageScroll } from "./pageHooks";
import { ProjectsCrumb, PagePicker } from "./PagePicker";
import { ProjectDetails } from "./ProjectDetails";
import { ProjectNameEditor } from "./ProjectNameEditor";
import { ProjectTitle } from "./ProjectTitle";
import { openCursorRowMenu } from "./rowMenu";
import { useServesFocusRequests } from "@/shell/paneContext";

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
 * A project's page (docs/notes/project-page-1-title-block.md): the pane header (crumb, picker
 * or the name editor, the panel toggles), then in the content column its title block
 * (ProjectTitle: name, meta line, ⋯), a note for a repository without a remote or a folder
 * without git, the Checkouts table (main and the worktrees a thread is on; a row's right-click menu holds
 * what it does, and its columns drop by the table's own width), Worktrees without threads
 * (LeftoverWorktrees, every other worktree, its rows after the checkouts' on the keyboard
 * list), and Details. Below PROJECT_TITLE_COMPACT_BELOW of content width the slug drops and
 * Open in Finder shows its icon only.
 */
export function ProjectPage({ projectId, pageKey }: { projectId: string; pageKey: string }) {
  const loaded = useProjectsStore((s) => s.loaded);
  const exists = useProjectsStore((s) => s.byId[projectId] !== undefined);
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  const kind = useProjectKind(projectId);
  const step = useProjectsStore((s) => {
    const r = s.byId[projectId];
    return r ? projectNextStep(r) : null;
  });
  const hasRemote = useProjectsStore((s) => (s.byId[projectId]?.remotes.length ?? 0) > 0);
  const main = useProjectsStore((s) => mainWorktreePath(s, projectId));
  const working = useThreadsStore((s) => projectActivity(s, projectId).working);
  const paths = useCheckoutOrder(projectId);
  const leftovers = useLeftoverPaths(projectId);
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

  // The pane's width: the scroll box's.
  const [widthRef, width] = useWidth(1200);
  const compact = width < PROJECT_TITLE_COMPACT_BELOW;
  // A checkout's or a leftover's row has no activation: its right-click menu (ContextMenu key, Shift+F10) holds what it does.
  const navItems = useMemo<NavItem[]>(() => (git ? [...paths, ...leftovers].map((p) => ({ key: projectWorktreeKey(projectId, p) })) : []), [git, paths, leftovers, projectId]);
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
  // On mount the page takes the keyboard, unless it opens in a shell pane without the focus.
  const takesFocus = useServesFocusRequests();
  useEffect(() => {
    if (takesFocus) rootRef.current?.focus({ preventScroll: true });
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label={name} data-testid="projects-page" data-page="project" data-project={projectId} data-kind={kind} data-compact={compact || undefined}>
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
        <span className="-mr-2 ml-auto flex shrink-0 items-center pl-2">
        </span>
      </PaneHeader>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="projects-scroll">
        <NavProvider value={nav.ctx}>
          <div
            ref={rootRef}
            tabIndex={0}
            role="listbox"
            aria-label={`${name} checkouts`}
            aria-activedescendant={nav.activeDescendant}
            className="mx-auto flex max-w-6xl flex-col gap-6 outline-none"
            data-testid="projects-list"
            data-focus-root
            onKeyDown={(e) => {
              if (!openCursorRowMenu(e)) nav.onKeyDown(e);
            }}
          >
            {exists && (
              <>
                <ProjectTitle projectId={projectId} compact={compact} />
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
                    <SectionHeader label="Checkouts" count={paths.length} detail={checkoutsHint(working)} testId="checkouts-title" />
                    <CheckoutsTable projectId={projectId} paths={paths} remote={hasRemote} github={kind === "github"} />
                  </div>
                ) : (
                  <ThreadsBlock projectId={projectId} main={main} />
                )}
                {git && <LeftoverWorktrees projectId={projectId} paths={leftovers} />}
                <ProjectDetails projectId={projectId} compact={compact} />
              </>
            )}
          </div>
        </NavProvider>
      </div>
    </section>
  );
}
