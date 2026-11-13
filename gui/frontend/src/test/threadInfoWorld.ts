/**
 * The mock's thread info card scenarios (POST /__mock/thread-info, World.addThreadInfo) as
 * view models, seeded into the stores on top of projectsWorld's seedWorld: one project
 * (s-ti-1), the same thread working, a child, a folder without git, two servers, and the
 * nine-project workspace "platform" (s-ti-ws). Pair with daemonFakes for the commands; the
 * card's other reads (pull request details, action picks, editor apps, placement checks)
 * are answered by src/test/cardFakes.ts, which this fills.
 */
import { act } from "@testing-library/react";
import type { ActionView } from "@/api/actions";
import type { AgentRunView } from "@/api/agents";
import type { PullRequestView } from "@/api/gh";
import type { McpServerView } from "@/api/mcp";
import type { BackgroundShellView, ThreadView, UsageBucketView } from "@/api/threads";
import { useActionsStore } from "@/stores/actions";
import { dashboardResource, pullRequestDetailResource } from "@/stores/gh";
import { shownTab, tabPlace } from "@/shell/host";
import { resetLayout } from "@/stores/layout";
import { placementResource } from "@/stores/placementChecks";
import { useProjectsStore } from "@/stores/projects";
import { actionPicksResource, editorAppsResource } from "@/stores/threadInfo";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { actionRun, actionTerminal, terminalUpdated } from "./actionsWorld";
import { card } from "./cardFakes";
import { daemon } from "./daemonFakes";
import { addThreads, addWorkspace, addWorktrees, CF, HOME, pullRequest, seedWorld, status, thread, WR, worktree } from "./projectsWorld";

export const TREE = `${CF}.worktrees/cf-sidebar-tree`;
const SLUG = "alexwaumann/code-foundry";
const ago = (min: number) => Date.now() - min * 60_000;

/** A usage bucket with its costs given (the daemon prices them). */
export function bucket(model: string, o: Partial<UsageBucketView>): UsageBucketView {
  return { model, tier: "", speed: "", day: "2026-11-01", requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0, unpriced: false, inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWrite5mCostUsd: 0, cacheWrite1hCostUsd: 0, cacheSavingsUsd: 0, ...o };
}

/** Two models, priced: Opus $224.00 and Fable $96.00, $320.00 in all, cache reads saving $1,134.00. */
function sampleUsage(): UsageBucketView[] {
  return [
    bucket("claude-opus-5-5", { requests: 290, input: 9800, output: 720_000, cacheRead: 252_000_000, cacheWrite5m: 1_100_000, cacheWrite1h: 7_400_000, inputCostUsd: 0.05, outputCostUsd: 18, cacheReadCostUsd: 126, cacheWrite5mCostUsd: 6.95, cacheWrite1hCostUsd: 73, costUsd: 224, cacheSavingsUsd: 1134 }),
    bucket("claude-fable-5-1", { requests: 122, input: 3100, output: 260_000, cacheRead: 97_000_000, cacheWrite5m: 400_000, cacheWrite1h: 3_300_000, inputCostUsd: 0.02, outputCostUsd: 6.5, cacheReadCostUsd: 48.5, cacheWrite5mCostUsd: 2.48, cacheWrite1hCostUsd: 38.5, costUsd: 96 }),
  ];
}

function action(id: string, projectId: string, name: string, position: number, icon: ActionView["icon"] = "play"): ActionView {
  return { id, projectId, name, command: name.toLowerCase(), icon, inTerminal: false, onWorktreeCreate: false, position };
}

function agentRun(id: string, o: Partial<AgentRunView>): AgentRunView {
  return { id, toolUseId: `tu-${id}`, parentId: "", description: id, agentType: "general-purpose", model: "", effort: "", background: true, spawnDepth: 1, status: "running", activity: "", totalTokens: 0, toolUses: 0, durationMs: 0, summary: "", error: "", startedAtMs: ago(3), resumedAtMs: null, endedAtMs: null, noteItemId: "", ...o };
}

function shell(taskId: string, command: string, o: Partial<BackgroundShellView> = {}): BackgroundShellView {
  return { taskId, description: "", command, startedAtMs: Date.now() - 75_000, ports: [], ...o };
}

export const mcpServer = (name: string, s: McpServerView["status"]): McpServerView => ({ name, status: s, serverName: name, version: "", error: "", scope: "", source: "", transport: "stdio", tools: [] });

/** Sets a thread's log fields (agents, MCP servers) the way its Watch would. */
export function setLog(threadId: string, o: { agents?: AgentRunView[]; mcp?: McpServerView[] }): void {
  act(() => {
    useThreadStore.setState((s) => {
      const prev = s.logs[threadId] ?? { seq: 0, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: [] };
      return {
        logs: {
          ...s.logs,
          [threadId]: {
            ...prev,
            ...(o.agents ? { agents: o.agents } : {}),
            ...(o.mcp ? { mcp: { checkedAtMs: Date.now(), trigger: "turn", server: "", servers: o.mcp } } : {}),
          },
        },
      };
    });
  });
}

/** Updates one thread in place (a thread event). */
export function updateThread(id: string, o: Partial<ThreadView>): void {
  act(() => {
    useThreadsStore.setState((s) => {
      const t = s.byId[id];
      return t ? { byId: { ...s.byId, [id]: { ...t, ...o } } } : {};
    });
  });
}

/** Selects a thread as the window's (the pane the card belongs to). */
export function selectThread(id: string): void {
  act(() => {
    useUiStore.getState().select({ kind: "thread", id });
  });
}

/** The fields projectsWorld's thread() leaves out, as a thread with none of them reads. */
const base = {
  model: "claude-opus-4-8[1m]",
  effort: "high",
  state: "connected",
  status: "idle",
  createdAtMs: ago(45),
  lastActivityAtMs: ago(19),
  effortPending: false,
  linkedPullRequests: [],
  usage: [],
  costUsd: 0,
  unpriced: false,
  agentRuns: [],
  contextTokens: 0,
  contextWindow: 0,
  cacheExpiresAtMs: null,
  contextRereadUsd: 0,
  agentsRunning: 0,
  backgroundAgentsRunning: 0,
  backgroundShellsRunning: 0,
  busyTool: "",
  backgroundShells: [],
  backgroundWakePending: false,
  retry: null,
  createdBy: "",
  createdByName: "",
  brief: "",
  labels: [],
  report: null,
  budgetUsd: 0,
  flags: [],
} satisfies Partial<ThreadView>;

/** The world reset: projectsWorld's, no card reads, no panels, no logs. */
export function resetCard(): void {
  seedWorld();
  card.prDetails.clear();
  card.picks.clear();
  card.editors = [];
  card.refusals.clear();
  pullRequestDetailResource.store.setState({ entries: {} });
  dashboardResource.store.setState({ entries: {} });
  actionPicksResource.store.setState({ entries: {} });
  editorAppsResource.store.setState({ entries: {} });
  placementResource.store.setState({ entries: {} });
  useActionsStore.setState({ byId: {}, byProject: {}, runs: {} });
  useThreadStore.setState({ logs: {} });
  resetLayout();
}

function putActions(actions: ActionView[]): void {
  const byId = Object.fromEntries(actions.map((a) => [a.id, a]));
  const byProject: Record<string, string[]> = {};
  for (const a of [...actions].sort((x, y) => x.position - y.position)) (byProject[a.projectId] ??= []).push(a.id);
  useActionsStore.setState({ byId, byProject, runs: {} });
}

/**
 * single: s-ti-1 "Fix the stale PR badge" in a fresh copy on cf/sidebar-tree 3 ahead, #78
 * (open, review requested) and #63 (merged), 4 changed files, one background shell, two
 * subagent runs (one running), three children (working, asking, finished), two MCP servers
 * connected, 221K of a 1M window cached for 41 more minutes, six actions (Dev last run).
 */
export function seedSingle(): string {
  addWorktrees("repo-cf", worktree("repo-cf", TREE, "cf/sidebar-tree", { status: status({ upstream: "origin/cf/sidebar-tree", ahead: 3, baseAhead: 3 }) }));
  const s = thread("s-ti-1", {
    ...base,
    worktreePath: TREE,
    name: "Fix the stale PR badge",
    createdWorktree: true,
    branch: "cf/sidebar-tree",
    contextTokens: 221_000,
    contextWindow: 1_000_000,
    cacheExpiresAtMs: Date.now() + 41 * 60_000 - 30_000,
    contextRereadUsd: 2.21,
    usage: sampleUsage(),
    linkedPullRequests: [63, 78].map((n) => ({ slug: SLUG, number: n, url: `https://github.com/${SLUG}/pull/${String(n)}`, linkedAt: ago(30) })),
    backgroundShells: [shell("b-watch", "pnpm vitest --watch", { description: "unit tests" })],
    backgroundShellsRunning: 1,
    backgroundAgentsRunning: 1,
    agentRuns: [],
    flags: [],
    createdBy: "",
  });
  const kid = (id: string, name: string, st: ThreadView["status"], reason: string, min: number) =>
    thread(id, { ...base, name, model: "claude-sonnet-5[1m]", effort: "medium", status: st, statusReason: reason, createdAtMs: ago(min), statusChangedAtMs: ago(min - 22), createdBy: s.id, createdByName: s.name, branch: `cf/${id}`, flags: [] });
  addThreads(s, kid("s-ti-k1", "Mobile token storage", "busy", "working: Mobile token storage", 14), kid("s-ti-k2", "Billing webhook retry", "attention", "question: Retry on 409?", 62), kid("s-ti-k3", "Docs for refresh tokens", "idle", "finished", 40));
  card.prDetails.set(`${SLUG}#78`, pullRequest({ repoSlug: SLUG, number: 78, title: "Include the head SHA in the fingerprint", headRef: "cf/sidebar-tree", checks: { state: "success", total: 4, passed: 4, failed: 0, pending: 0, skipped: 0 }, reviewRequests: [{ login: "teammate-kim" }] as never }));
  card.prDetails.set(`${SLUG}#63`, pullRequest({ repoSlug: SLUG, number: 63, title: "Sidebar tree rows", headRef: "cf/sidebar-tree-1", state: "merged" }));
  daemon.worktreeDetail.set(`repo-cf\u0000${TREE}`, {
    files: [
      { path: "gui/frontend/src/lib/tree.ts", added: 30, deleted: 6 },
      { path: "gui/frontend/src/components/sidebar/Sidebar.tsx", added: 8, deleted: 3 },
      { path: "gui/frontend/src/lib/tree.test.ts", added: 3, deleted: 0 },
      { path: "docs/notes/sidebar-tree.md", added: 1, deleted: 0, uncommitted: true },
    ],
  } as never);
  putActions(["Dev", "Test", "Check", "Build", "Lint", "Format"].map((n, i) => action(`a-cf-${n.toLowerCase()}`, "repo-cf", n, i)));
  card.picks.set("repo-cf", useActionsStore.getState().byId["a-cf-dev"] as ActionView);
  setLog(s.id, {
    agents: [agentRun("ag-explore", { description: "Explore the gh poller", agentType: "Explore" }), agentRun("ag-plan", { description: "Plan the badge fix", agentType: "Plan", status: "done", startedAtMs: ago(30), endedAtMs: ago(28), durationMs: 120_000 })],
    mcp: [mcpServer("github", "connected"), mcpServer("context7", "connected")],
  });
  selectThread(s.id);
  return s.id;
}

/** child: single, then s-ti-child "Port the rotation to web" made by s-ti-1, working. */
export function seedChild(): string {
  seedSingle();
  addThreads(thread("s-ti-child", { ...base, name: "Port the rotation to web", status: "busy", statusReason: "working: Port the rotation to web", createdBy: "s-ti-1", createdByName: "Fix the stale PR badge", flags: [] }));
  selectThread("s-ti-child");
  return "s-ti-child";
}

/** nogit: s-ti-nogit "Outline the essay" in writing (no git). */
export function seedNoGit(): string {
  addThreads(thread("s-ti-nogit", { ...base, projectId: "repo-wr", worktreePath: WR, name: "Outline the essay", flags: [] }));
  selectThread("s-ti-nogit");
  return "s-ti-nogit";
}

/** servers: s-ti-srv with pnpm on 5173 and 24678, python3 on 9399, and two shells listening on nothing (mock/shells.ts). */
export function seedServers(): string {
  addThreads(
    thread("s-ti-srv", {
      ...base,
      name: "Serve the docs preview",
      flags: [],
      backgroundShells: [
        shell("bk4v8n2p7", "pnpm --dir web dev", { description: "web dev server", ports: [5173, 24678] }),
        shell("bd9r3t6w1", "python3 -m http.server 9399 --directory docs/_build", { description: "docs preview", ports: [9399] }),
        shell("bw1", "pnpm tsc --watch"),
        shell("bw2", "tail -f /tmp/build.log"),
      ],
    }),
  );
  selectThread("s-ti-srv");
  return "s-ti-srv";
}

/** The action of a server run: what the mock's Dev and Debug daemon are to the card. */
const serverAction = (id: string, name: string, command: string): ActionView => ({ ...action(id, "repo-cf", name, 0), command });

/**
 * child-server (mock/world.ts): s-ti-1 runs Debug daemon in the background on 7788; its child
 * s-ti-kid-srv "Serve the web preview" runs Dev in a terminal on 5173 and 24678, and has the
 * servers state's shells (pnpm reports the same two ports, python3 9399).
 */
export function seedChildServer(): { parent: string; child: string; devRun: string; devTerminal: string; debugRun: string } {
  seedSingle();
  const child = "s-ti-kid-srv";
  addThreads(
    thread(child, {
      ...base,
      name: "Serve the web preview",
      createdBy: "s-ti-1",
      createdByName: "Fix the stale PR badge",
      flags: [],
      backgroundShells: [
        shell("bk4v8n2p7", "pnpm --dir web dev", { description: "web dev server", ports: [5173, 24678] }),
        shell("bd9r3t6w1", "python3 -m http.server 9399", { description: "docs preview", ports: [9399] }),
        shell("bw1", "pnpm tsc --watch"),
      ],
    }),
  );
  const owner = { threadId: child, projectId: "repo-cf", worktree: CF };
  const dev = serverAction("a-dev000000000", "Dev", "pnpm dev");
  const debug = serverAction("a-debug0000000", "Debug daemon", "make dev");
  terminalUpdated(actionTerminal("t-dev", dev, "r-dev", owner));
  act(() => {
    useActionsStore.setState((s) => ({
      runs: {
        ...s.runs,
        "r-dev": actionRun("r-dev", dev, owner, "t-dev", { ports: [5173, 24678], startedAtMs: Date.now() - 107_000 }),
        "r-debug": actionRun("r-debug", debug, { threadId: "s-ti-1", projectId: "repo-cf", worktree: TREE }, "", { mode: "background", ports: [7788], startedAtMs: Date.now() - 60_000 }),
      },
    }));
  });
  return { parent: "s-ti-1", child, devRun: "r-dev", devTerminal: "t-dev", debugRun: "r-debug" };
}

const WS9 = ["api", "web", "auth-lib", "docs", "mobile", "infra", "billing", "notify", "cli"] as const;
const wsPath = (n: string) => `${HOME}/src/${n}.worktrees/cf-auth-tokens`;

/**
 * ws9: s-ti-ws "Roll out refresh tokens" in workspace "platform" over nine projects, cwd
 * api diverged 3/1, auth-lib moved to cf/auth-tokens-2, mobile mid-rebase, seven pull
 * requests over four projects (#58 stacked on #57), Typecheck last run in web.
 */
export function seedWs9(): string {
  const branch = "cf/auth-tokens";
  act(() => {
    useProjectsStore.setState((s) => {
      const byId = { ...s.byId };
      for (const n of WS9) {
        const id = `repo-${n}`;
        const main = `${HOME}/src/${n}`;
        const st = n === "api" ? status({ upstream: `origin/${branch}`, ahead: 3, behind: 1, baseAhead: 4 }) : n === "web" ? status({ upstream: `origin/${branch}`, ahead: 1, baseAhead: 1 }) : n === "mobile" ? status({ operation: "rebase", operationStep: 3, operationTotal: 7 }) : status();
        byId[id] = { id, path: main, name: n, defaultBranch: "main", githubSlug: `acme/${n}`, remotes: ["origin"], git: true, worktrees: [worktree(id, main, "main", { isMain: true }), worktree(id, wsPath(n), n === "auth-lib" ? "cf/auth-tokens-2" : branch, { status: st })] };
      }
      return { byId, order: Object.keys(byId).sort((a, b) => (byId[a]?.name ?? "").localeCompare(byId[b]?.name ?? "")) };
    });
  });
  const ws = addWorkspace("platform", WS9.map((n) => `repo-${n}`), { id: "w-platform" });
  const ids = WS9.map((n) => `repo-${n}`).sort();
  const links: [string, number, Partial<PullRequestView>][] = [
    ["acme/api", 412, { title: "Token refresh endpoint", headRef: branch, review: "approved" }],
    ["acme/api", 398, { title: "Token table", headRef: "cf/token-table", state: "merged" }],
    ["acme/web", 1088, { title: "Use refresh tokens", headRef: branch, checks: { state: "pending", total: 3, passed: 1, failed: 0, pending: 2, skipped: 0 } }],
    ["acme/auth-lib", 58, { title: "Rotate on refresh", headRef: "cf/auth-tokens-2", baseRef: branch, checks: { state: "pending", total: 3, passed: 1, failed: 0, pending: 2, skipped: 0 } }],
    ["acme/auth-lib", 57, { title: "Rotate refresh tokens", headRef: branch, checks: { state: "failure", total: 3, passed: 2, failed: 1, pending: 0, skipped: 0 } }],
    ["acme/auth-lib", 51, { title: "Token helpers", headRef: "cf/token-helpers", state: "merged" }],
    ["acme/docs", 19, { title: "Refresh token docs", headRef: branch, draft: true }],
  ];
  for (const [slug, number, o] of links) card.prDetails.set(`${slug}#${String(number)}`, pullRequest({ repoSlug: slug, number, ...o }));
  addThreads(
    thread("s-ti-ws", {
      ...base,
      projectId: "repo-api",
      worktreePath: wsPath("api"),
      name: "Roll out refresh tokens",
      createdWorktree: true,
      branch,
      projectIds: ids,
      checkoutPaths: ids.map((id) => ({ projectId: id, path: wsPath(id.slice("repo-".length)) })),
      workspaceId: ws.id,
      contextTokens: 410_000,
      contextWindow: 1_000_000,
      usage: sampleUsage(),
      linkedPullRequests: links.map(([slug, number]) => ({ slug, number, url: `https://github.com/${slug}/pull/${String(number)}`, linkedAt: ago(20) })),
      flags: [],
    }),
  );
  const detail = (n: string, files: { path: string; added: number; deleted: number }[]) => daemon.worktreeDetail.set(`repo-${n}\u0000${wsPath(n)}`, { files } as never);
  for (const n of WS9) detail(n, []);
  detail("api", [
    { path: "auth/refresh.go", added: 30, deleted: 6 },
    { path: "auth/refresh_test.go", added: 8, deleted: 0 },
    { path: "auth/store.go", added: 3, deleted: 3 },
    { path: "README.md", added: 1, deleted: 0 },
  ]);
  detail("web", [
    { path: "src/auth.ts", added: 12, deleted: 3 },
    { path: "src/auth.test.ts", added: 6, deleted: 0 },
  ]);
  detail("auth-lib", Array.from({ length: 7 }, (_, i) => ({ path: `rotate/${String(i)}.go`, added: [40, 30, 20, 10, 10, 5, 5][i] ?? 0, deleted: [20, 15, 10, 6, 5, 3, 2][i] ?? 0 })));
  detail("docs", [{ path: "refresh-tokens.md", added: 6, deleted: 0 }]);
  putActions([action("a-web-tc", "repo-web", "Typecheck", 0, "lint"), action("a-web-e2e", "repo-web", "e2e", 1, "test"), action("a-api-test", "repo-api", "Test", 0, "test"), action("a-api-migrate", "repo-api", "Migrate", 1, "configure")]);
  card.picks.set("repo-web", useActionsStore.getState().byId["a-web-tc"] as ActionView);
  selectThread("s-ti-ws");
  return "s-ti-ws";
}

/**
 * The window's selection's tabs' active one (kind, title and params), or null: the last one when
 * the focused pane holds none of them. Needs the fake layout daemon (src/test/fakeLayout.ts).
 */
export function activePanelTab(): { kind: string; title: string; params: Readonly<Record<string, string>> } | null {
  const p = tabPlace("current");
  const tab = shownTab(p) ?? p.tabs[p.tabs.length - 1] ?? null;
  return tab ? { kind: tab.kind, title: tab.title, params: tab.params } : null;
}
