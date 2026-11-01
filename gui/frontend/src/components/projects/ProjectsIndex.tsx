import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Broom, FolderOpen, FolderPlus, Folders, GitPullRequest, Layers, Search } from "lucide-react";
import { BottomToggle } from "@/components/bottom/BottomToggle";
import { GithubMark } from "@/components/icons/GithubMark";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { shortAge } from "@/components/prs/format";
import { ChecksBadge } from "@/components/prs/PrBits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useNow } from "@/lib/clock";
import { useWidth } from "@/lib/useWidth";
import { useNav, type NavItem } from "@/lib/nav";
import { NavProvider, NavRow } from "@/lib/NavRow";
import {
  defaultBranchCell,
  filterProjects,
  indexColumns,
  prCountLabel,
  projectActivity,
  projectKey,
  projectNextStep,
  projectStatusSentence,
  tidyLabel,
  workspaceActivity,
  workspaceContents,
  workspaceKey,
  workspaceStatusSentence,
  workspaceWorkingBranches,
  type IndexColumns,
  type ProjectsSearch,
} from "@/lib/projects";
import { cn } from "@/lib/utils";
import { startCommandNamed } from "@/keys/bindings";
import { openAddProject, type AddProjectTab } from "@/stores/addProject";
import { branchKey, branchPullRequestsResource, openUrl, repoActivityResource } from "@/stores/gh";
import { addProject, initGitIn, publishProject } from "@/stores/projectActions";
import { useProjectsStore } from "@/stores/projects";
import { useResource } from "@/stores/resource";
import { clearProjectsPageReveal, useProjectsPageStore } from "@/stores/projectsPage";
import { useThreadsStore } from "@/stores/threads";
import { projectPage, useUiStore, workspacePage } from "@/stores/ui";
import { openNewWorkspaceDialog } from "@/stores/workspaceActions";
import { useWorkspacesStore } from "@/stores/workspaces";
import { KindIcon, Pill, StatusDot, WorkspaceIcon } from "./bits";
import { usePageScroll } from "./pageHooks";
import { useProjectKind } from "@/components/icons/projectKind";
import { useCleanableCount } from "./useCleanable";
import { useProjectLastMs, useProjectOrder, useWorkspaceLastMs, useWorkspaceOrder } from "./useOrder";

const SEP = "\u0001";

/**
 * How many of the project's branches have an open pull request (draft included), from the
 * branch pull requests the daemon polls while watched (stores/gh.ts). GitHub projects only;
 * the default branch has none.
 */
function useOpenPullRequests(projectId: string): number {
  const keys = useProjectsStore(
    useShallow((s) => {
      const r = s.byId[projectId];
      const slug = r?.githubSlug.toLowerCase() ?? "";
      if (!r || !slug) return [];
      return r.worktrees.filter((w) => w.branch && w.branch !== r.defaultBranch).map((w) => branchKey(slug, w.branch));
    }),
  );
  const joined = keys.join(SEP);
  useEffect(() => {
    if (!joined) return;
    const releases = joined.split(SEP).map((k) => branchPullRequestsResource.watch(k));
    return () => {
      for (const r of releases) r();
    };
  }, [joined]);
  return branchPullRequestsResource.store((s) => keys.filter((k) => s.entries[k]?.data?.pullRequests.some((p) => p.state === "open") === true).length);
}

function AgeCell({ ms }: { ms: number | null }) {
  const now = useNow(30_000);
  return (
    <span className="truncate text-right text-caption text-cf-text-muted tabular-nums" data-testid="index-age">
      {ms === null ? "" : shortAge(ms, now)}
    </span>
  );
}

/** A table column: its header and grid track. */
interface Column {
  label: string;
  track: string;
  right?: boolean;
}

// Flexible tracks with a floor, like the Pull Requests page's tables; the two tables share
// them so their columns line up while all show.
const TRACK = { name: "minmax(7rem,1.2fr)", activity: "minmax(8rem,1.4fr)", third: "minmax(9rem,1fr)", fourth: "minmax(9rem,1.2fr)", updated: "3rem" };

function projectColumns(c: IndexColumns): Column[] {
  return [
    { label: "Project", track: TRACK.name },
    c.activity && { label: "Activity", track: TRACK.activity },
    c.branch && { label: "Default branch", track: TRACK.third },
    { label: "Needs a look", track: TRACK.fourth },
    c.updated && { label: "Updated", track: TRACK.updated, right: true },
  ].filter((x): x is Column => x !== false);
}

function workspaceColumns(c: IndexColumns): Column[] {
  return [
    { label: "Workspace", track: TRACK.name },
    c.activity && { label: "Activity", track: TRACK.activity },
    { label: "Projects", track: TRACK.third },
    c.branch && { label: "Contents", track: TRACK.fourth },
    c.updated && { label: "Updated", track: TRACK.updated, right: true },
  ].filter((x): x is Column => x !== false);
}

const template = (cols: readonly Column[]): string => cols.map((c) => c.track).join(" ");

/** A bordered table: the overline header row, then the rows. */
function IndexTable({ columns, testId, children }: { columns: readonly Column[]; testId: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border" data-testid={testId}>
      <div className="grid gap-3 border-b px-2 py-1 text-overline" style={{ gridTemplateColumns: template(columns) }} data-testid="index-columns">
        {columns.map((c) => (
          <span key={c.label} className={cn("truncate", c.right && "text-right")}>
            {c.label}
          </span>
        ))}
      </div>
      <div className="p-0.5">{children}</div>
    </div>
  );
}

/** A section's title, its row count, a muted hint and its Add button at the right. */
function SectionTitle({ heading, count, hint, action }: { heading: string; count: number; hint?: string; action: React.ReactNode }) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2">
      <h2 className="shrink-0 text-title">{heading}</h2>
      <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="index-section-count">
        ({count})
      </span>
      {hint && <span className="min-w-0 truncate text-caption text-cf-text-muted">· {hint}</span>}
      <span className="ml-auto flex shrink-0 items-center [--wails-draggable:no-drag]">{action}</span>
    </div>
  );
}

/** The NavRow (cursor, hover); its inner span is the row's grid. */
const ROW = "h-9 rounded-md";
const ROW_INNER = "grid h-full items-center gap-3 px-2 text-body";

/**
 * The project's default branch and its checks (the daemon polls every tracked GitHub
 * repository's), watched while the row shows. A click on failing checks opens the first
 * failed one; "—" off GitHub and until the status arrives.
 */
function DefaultBranch({ projectId }: { projectId: string }) {
  const slug = useProjectsStore((s) => s.byId[projectId]?.githubSlug.toLowerCase() ?? "");
  const entry = useResource(repoActivityResource, slug === "" ? null : slug);
  const cell = defaultBranchCell(slug, entry?.data?.defaultBranch);
  if (!cell) {
    return (
      <span className="text-body-sm text-cf-text-muted" data-testid="index-default-branch">
        —
      </span>
    );
  }
  const url = cell.failingUrl;
  return (
    <span className="flex min-w-0 items-center gap-2" data-testid="index-default-branch">
      <span className="min-w-0 shrink truncate font-mono text-caption text-cf-text-muted" data-testid="index-default-branch-name">
        {cell.branch}
      </span>
      {url ? (
        <button
          type="button"
          tabIndex={-1}
          className="flex min-w-0 shrink-0 hover:underline"
          data-testid="index-checks"
          onClick={(e) => {
            e.stopPropagation();
            void openUrl(url);
          }}
        >
          <ChecksBadge checks={cell.rollup} />
        </button>
      ) : (
        <span className="flex min-w-0 shrink-0" data-testid="index-checks">
          <ChecksBadge checks={cell.rollup} />
        </span>
      )}
    </span>
  );
}

function ProjectRow({ id, columns, cols }: { id: string; columns: IndexColumns; cols: string }) {
  const name = useProjectsStore((s) => s.byId[id]?.name ?? id);
  const kind = useProjectKind(id);
  const checkouts = useProjectsStore((s) => s.byId[id]?.worktrees.length ?? 0);
  const step = useProjectsStore((s) => {
    const r = s.byId[id];
    return r ? projectNextStep(r) : null;
  });
  const working = useThreadsStore((s) => projectActivity(s, id).working);
  const last = useProjectLastMs(id);
  const prs = useOpenPullRequests(id);
  const tidy = useCleanableCount(id);
  const sentence = projectStatusSentence({ working, checkouts, git: kind !== "nogit" });
  return (
    <NavRow navKey={projectKey(id)} activateOnClick className={ROW}>
      <span className={ROW_INNER} style={{ gridTemplateColumns: cols }} data-testid="index-project" data-project={id} data-kind={kind}>
        <span className="flex min-w-0 items-center gap-3">
          <KindIcon kind={kind} />
          <span className="truncate font-medium" data-testid="project-name">
            {name}
          </span>
        </span>
        {columns.activity && (
          <span className="flex min-w-0 items-center gap-2 text-body-sm text-cf-text-secondary" data-testid="project-status">
            <StatusDot live={working > 0} />
            <span className="truncate">{sentence}</span>
          </span>
        )}
        {columns.branch && <DefaultBranch projectId={id} />}
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden" data-testid="index-look">
          {prs > 0 && (
            <Pill tone="success" data-testid="index-prs">
              <GitPullRequest aria-hidden />
              {prCountLabel(prs)}
            </Pill>
          )}
          {tidy > 0 && (
            <Pill tone="warning" data-testid="index-tidy">
              <Broom aria-hidden />
              {tidyLabel(tidy)}
            </Pill>
          )}
          {step === "publish" && (
            <button
              type="button"
              tabIndex={-1}
              className="shrink-0 truncate text-caption text-cf-link hover:underline"
              data-testid="index-publish"
              onClick={(e) => {
                e.stopPropagation();
                publishProject(id);
              }}
            >
              Publish to GitHub
            </button>
          )}
          {step === "init" && (
            <button
              type="button"
              tabIndex={-1}
              className="shrink-0 truncate text-caption text-cf-link hover:underline"
              data-testid="index-init-git"
              onClick={(e) => {
                e.stopPropagation();
                void initGitIn(id);
              }}
            >
              Initialize git
            </button>
          )}
        </span>
        {columns.updated && <AgeCell ms={last} />}
      </span>
    </NavRow>
  );
}

function WorkspaceRow({ id, columns, cols }: { id: string; columns: IndexColumns; cols: string }) {
  const name = useWorkspacesStore((s) => s.byId[id]?.name ?? id);
  const memberIds = useWorkspacesStore(useShallow((s) => (s.byId[id]?.members ?? []).map((m) => m.projectId)));
  const members = useProjectsStore(useShallow((s) => memberIds.map((p) => s.byId[p]?.name ?? p)));
  const contents = useWorkspacesStore((s) => {
    const w = s.byId[id];
    return w ? workspaceContents(w) : "";
  });
  const working = useThreadsStore((s) => workspaceActivity(s, id).working);
  const branches = useThreadsStore(useShallow((s) => workspaceWorkingBranches(s, id)));
  const last = useWorkspaceLastMs(id);
  return (
    <NavRow navKey={workspaceKey(id)} activateOnClick className={ROW}>
      <span className={ROW_INNER} style={{ gridTemplateColumns: cols }} data-testid="index-workspace" data-workspace={id}>
        <span className="flex min-w-0 items-center gap-3">
          <WorkspaceIcon />
          <span className="truncate font-medium" data-testid="workspace-name">
            {name}
          </span>
        </span>
        {columns.activity && (
          <span className="flex min-w-0 items-center gap-2 text-body-sm text-cf-text-secondary" data-testid="workspace-status">
            <StatusDot live={working > 0} />
            <span className="truncate">{workspaceStatusSentence(working, branches)}</span>
          </span>
        )}
        <span className="truncate text-body-sm text-cf-text-secondary" data-testid="workspace-projects">
          {[...members].sort((a, b) => a.localeCompare(b)).join(" + ")}
        </span>
        {columns.branch && (
          <span className="truncate text-caption text-cf-text-muted" data-testid="workspace-contents">
            {contents}
          </span>
        )}
        {columns.updated && <AgeCell ms={last} />}
      </span>
    </NavRow>
  );
}

/**
 * What the filter matches (names, GitHub slugs, branches and paths; a workspace by its
 * name or a member's), as strings, and only while filtering.
 */
function useSearch(active: boolean): ProjectsSearch {
  const projects = useProjectsStore(
    useShallow((s) =>
      active
        ? s.order.map((id) => {
            const r = s.byId[id];
            return [id, r?.name ?? "", r?.githubSlug ?? "", ...(r?.worktrees.flatMap((w) => [w.path, w.branch]) ?? [])].join(SEP);
          })
        : [],
    ),
  );
  const workspaces = useWorkspacesStore(useShallow((s) => (active ? s.order.map((id) => [id, s.byId[id]?.name ?? "", ...(s.byId[id]?.members.map((m) => m.projectId) ?? [])].join(SEP)) : [])));
  return useMemo(
    () => ({
      projects: Object.fromEntries(
        projects.map((k) => {
          const [id = "", name = "", githubSlug = "", ...rest] = k.split(SEP);
          const branches: Record<string, string> = {};
          for (let i = 0; i + 1 < rest.length; i += 2) branches[rest[i] ?? ""] = rest[i + 1] ?? "";
          return [id, { name, githubSlug, branches }];
        }),
      ),
      workspaces: Object.fromEntries(
        workspaces.map((k) => {
          const [id = "", name = "", ...members] = k.split(SEP);
          return [id, { name, members }];
        }),
      ),
    }),
    [projects, workspaces],
  );
}

/** Opens the Add Project dialog on a tab, through its command when the daemon lists it. */
function addFrom(tab: AddProjectTab): void {
  const cmd = tab === "github" ? "project.clone" : tab === "new" ? "project.create" : "project.add";
  if (!startCommandNamed(cmd)) openAddProject(tab);
}

function EmptyIndex() {
  return (
    <div className="flex flex-col items-center px-6 pt-24 text-center" data-testid="projects-empty">
      <Folders className="size-6 text-cf-text-muted" aria-hidden />
      <p className="mt-3 text-body font-medium">No projects yet</p>
      <p className="mt-1 max-w-md text-body-sm text-cf-text-muted">A project is a folder or git repository threads work in. Add one to start.</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" size="sm" data-testid="projects-empty-local" onClick={() => { addFrom("local"); }}>
          <FolderOpen />
          Local folder…
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="projects-empty-github" onClick={() => { addFrom("github"); }}>
          <GithubMark />
          From GitHub…
        </Button>
        <Button type="button" variant="outline" size="sm" data-testid="projects-empty-new" onClick={() => { addFrom("new"); }}>
          <FolderPlus />
          New…
        </Button>
      </div>
      <p className="mt-5 text-caption text-cf-text-muted">
        or <span className="font-mono">code-foundry project add ~/src/app</span>
      </p>
    </div>
  );
}

/**
 * The Projects index: a table of projects by last activity (lib/projects.ts
 * sortByActivity) with their status sentence, default branch checks, what needs a look
 * (open pull requests, worktrees to tidy, the setup step) and age; then the workspaces the
 * same way. Columns drop as the content narrows (lib/projects.ts indexColumns). Click or
 * Enter opens a row's page; ↑/↓ move; / goes to the filter, Escape there clears it and
 * comes back. docs/notes/projects-redesign-1-index.md, docs/notes/projects-table-1-index.md.
 */
export function ProjectsIndex({ pageKey }: { pageKey: string }) {
  const order = useProjectOrder();
  const wsOrder = useWorkspaceOrder();
  const [query, setQuery] = useState("");
  const filtering = query.trim() !== "";
  const search = useSearch(filtering);
  const { projects, workspaces } = useMemo(() => {
    if (!filtering) return { projects: order, workspaces: wsOrder };
    const model = { projects: order.map((projectId) => ({ projectId, worktrees: Object.keys(search.projects[projectId]?.branches ?? {}) })), workspaces: wsOrder };
    const shown = filterProjects(model, query, search);
    return { projects: shown.projects.map((p) => p.projectId), workspaces: shown.workspaces };
  }, [order, wsOrder, filtering, query, search]);
  const navItems = useMemo<NavItem[]>(
    () => [
      ...projects.map((id) => ({ key: projectKey(id), activate: () => { useUiStore.getState().select(projectPage(id)); } })),
      ...workspaces.map((id) => ({ key: workspaceKey(id), activate: () => { useUiStore.getState().select(workspacePage(id)); } })),
    ],
    [projects, workspaces],
  );
  const nav = useNav(navItems);
  const reveal = useProjectsPageStore((s) => s.reveal);
  const setCursor = nav.ctx.setCursor;
  useEffect(() => {
    if (reveal === null || !navItems.some((it) => it.key === reveal)) return;
    setCursor(reveal);
    clearProjectsPageReveal(reveal);
  }, [reveal, navItems, setCursor]);
  const loaded = useProjectsStore((s) => s.loaded);
  const rootRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  // The content pane's width (the side panel takes from it): the scroll box's.
  const [widthRef, width] = useWidth(1200);
  const scrollRef = usePageScroll(pageKey, widthRef);
  const { activity, updated, branch } = indexColumns(width);
  const columns = useMemo<IndexColumns>(() => ({ activity, updated, branch }), [activity, updated, branch]);
  const projectCols = useMemo(() => projectColumns(columns), [columns]);
  const workspaceCols = useMemo(() => workspaceColumns(columns), [columns]);
  const projectTemplate = template(projectCols);
  const workspaceTemplate = template(workspaceCols);
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);
  const empty = loaded && order.length === 0;
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-region="content" aria-label="Projects" data-testid="projects-page" data-page="index">
      <PaneHeader className="gap-3 px-5">
        <Folders className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
        <h1 className="text-heading">Projects</h1>
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
        <span className="-mr-2 ml-auto flex shrink-0 items-center">
          <BottomToggle />
          <PanelToggle />
        </span>
      </PaneHeader>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-4" data-testid="projects-scroll">
        <NavProvider value={nav.ctx}>
          <div
            ref={rootRef}
            tabIndex={0}
            role="listbox"
            aria-label="Projects and workspaces"
            aria-activedescendant={nav.activeDescendant}
            className="mx-auto flex max-w-6xl flex-col gap-6 outline-none"
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
            {!loaded ? (
              <p className="px-2 text-body text-cf-text-muted">Loading…</p>
            ) : empty ? (
              <EmptyIndex />
            ) : projects.length === 0 && workspaces.length === 0 ? (
              <div className="rounded-lg border bg-cf-surface px-4 py-7 text-center text-body text-cf-text-muted" data-testid="projects-no-matches">
                Nothing matches “{query.trim()}”. The filter looks at names, GitHub slugs, branches and paths.
              </div>
            ) : (
              <>
                {projects.length > 0 && (
                  <section data-testid="projects-section">
                    <SectionTitle
                      heading="Projects"
                      count={projects.length}
                      action={
                        <Button type="button" variant="outline" size="sm" className="h-7" data-testid="projects-register" onClick={() => { addProject(); }}>
                          <FolderPlus />
                          Add project
                        </Button>
                      }
                    />
                    <IndexTable columns={projectCols} testId="projects-table">
                      {projects.map((id) => (
                        <ProjectRow key={id} id={id} columns={columns} cols={projectTemplate} />
                      ))}
                    </IndexTable>
                  </section>
                )}
                {(workspaces.length > 0 || (!filtering && wsOrder.length === 0)) && (
                  <section data-testid="workspaces-section">
                    <SectionTitle
                      heading="Workspaces"
                      count={workspaces.length}
                      hint="sets of projects threads start in together"
                      action={
                        <Button type="button" variant="outline" size="sm" className="h-7" data-testid="projects-new-workspace" onClick={() => { openNewWorkspaceDialog(); }}>
                          <Layers />
                          Add workspace
                        </Button>
                      }
                    />
                    {workspaces.length > 0 ? (
                      <IndexTable columns={workspaceCols} testId="workspaces-table">
                        {workspaces.map((id) => (
                          <WorkspaceRow key={id} id={id} columns={columns} cols={workspaceTemplate} />
                        ))}
                      </IndexTable>
                    ) : (
                      <p className="text-body-sm text-cf-text-muted" data-testid="workspaces-empty">
                        None yet: Add workspace, or <span className="font-mono">code-foundry workspace new</span>.
                      </p>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </NavProvider>
      </div>
    </section>
  );
}
