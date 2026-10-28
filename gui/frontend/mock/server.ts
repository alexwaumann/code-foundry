/**
 * Mock code-foundry daemon for frontend development and e2e tests.
 *
 *   pnpm run mock            # http://127.0.0.1:7788, token "dev-mock-token"
 *   MOCK_PORT=7799 MOCK_TOKEN=secret pnpm run mock
 *
 * Serves Health, Terminal, Project, Filesystem, Thread, Command, Ui, Action and Event over Connect (HTTP/1.1,
 * like the real daemon's loopback listener for browsers), with bearer auth and
 * permissive CORS. Non-RPC control endpoints for tests live under /__mock/:
 *
 *   GET  /__mock/invocations | writes | resizes | threads | streams
 *   GET  /__mock/waits                            (every thread.wait invoked, held until its caller aborts it: mock/bridge.ts)
 *   POST /__mock/reset
 *   ProjectService.SearchGitHub / LookupGitHub / Clone: mock/clone.ts (a project named "fail" fails
 *        to clone; octo-org/already-here's destination exists)
 *   GET  /__mock/github/calls                     ("search <q>", "lookup <o/n>", "clone <o/n>")
 *   ProjectService.Create / ListPublishOwners / Publish, project.create, project.github.publish:
 *        mock/create.ts (publishing private to octo-org, or a repository named "taken", fails like gh)
 *   GET  /__mock/projects/calls                   ("create <name>", "publish <id> <o/n> <visibility>", "delete <id>")
 *   POST /__mock/thread/attention?id=s-1
 *   POST /__mock/thread/status?id=s-1&status=busy|idle|attention[&reason=question: Which color?]
 *   POST /__mock/thread/stop?id=s-1&reason=crashed&code=139[&status=busy|idle|attention]   (the process ends: a crash, or reason=idle for the idle stop)
 *        (status: what it was doing at that moment; busy ends as ERROR "interrupted", other
 *        statuses persist, like the daemon)
 *   POST /__mock/status-kinds                     (one thread per status kind: approval, question,
 *        plan, finished, Claude error, busy, idle, interrupted, and a stopped one still asking
 *        a question; MOCK_SCENARIO=status-kinds seeds them at startup and on reset)
 *   POST /__mock/resident                         (the resident thread s-resident-ember, "Ember": kind
 *        RESIDENT, epoch 2, stopped; hidden from the sidebar and counts; World.addResident)
 *   POST /__mock/lineage                          (thread lineage: a creator, the child s-l-child with
 *        six siblings, one archived, one shown by its override (s-l-logs), and a child of
 *        its own; the others hidden while threads.show_created_threads is off; World.addLineage)
 *   POST /__mock/thread/focus?id=s-3     (FocusThread intent)
 *   POST /__mock/thread/envstale?id=s-1&change=Hello%20removed%20CF_HELLO   (a plugin's environment changed
 *     since the running process started: Thread.plugin_env_stale; an empty change clears it)
 *   POST /__mock/thread/transcript?id=s-3[&missing=false]   (Claude Code deleted the thread's transcript:
 *     Thread.transcript_missing; stopped and held; thread.send and thread.fork refuse it)
 *   POST /__mock/transcript-deleted              (the thread s-transcript-deleted, "Fix sidebar flake":
 *     one exchange, its transcript deleted; MOCK_SCENARIO=transcript-deleted seeds it; World.addTranscriptDeleted)
 *   POST /__mock/thread/archive?id=s-1[&archived=false]   (thread.archive as the CLI's --yes does it:
 *                                                 closes, removes its shells, unpins, stamps; false unarchives;
 *                                                 hidden children go along: World.archiveCascade)
 *   POST /__mock/thread/sidebar?id=s-l-child[&shown=false]   (thread.sidebar as the CLI does it: the
 *                                                 override on a thread another thread created)
 *   POST /__mock/thread/snooze?id=s-1&until=2m|<RFC 3339>[&clear=true]   (thread.snooze as the CLI's
 *                                                 --yes does it: closes, removes its shells, unpins, unarchives)
 *   POST /__mock/thread/wake?id=s-8              (the daemon's wake: unsnoozed, attention "snooze ended")
 *   POST /__mock/thread/cache?id=s-r1&ago=<seconds>[&tokens=N&model=M]   (a thread's last result that long ago; mock/context.ts)
 *   POST /__mock/thread?state=permission|question|streaming|idle   (the scripted thread s-r1:
 *        mock/thread.ts, also parallel|multi); POST /__mock/thread/delta?text=… | /__mock/thread/stream?text=… |
 *        /__mock/thread/finish[?total=1.5&turnCost=1.5&model=claude-sonnet-5] (the turn_end's figures) |
 *        /__mock/thread/fail-respond[?withdrawn=1] (the next answer fails; withdrawn: Claude withdrew
 *        the request first, NotFound); GET /__mock/thread/calls;
 *        /__mock/thread/commands?set=none|more|default (the slash commands: mock/slashCommands.ts) |
 *        /__mock/thread/agent-end?run=a1[&status=failed] (a subagent run of state=agents ends: mock/agents.ts) |
 *        /__mock/thread/shell-end[?status=failed] (the oldest background shell of state=agents|shells ends: mock/shells.ts) |
 *        /__mock/thread/mcp-age?id=s-r1&ago=720 (the last MCP check that many seconds ago: mock/mcp.ts)
 *   POST /__mock/terminal/exit?id=t-s1-shell&code=1[&keep=1]   (the process exits; keep=1: a
 *                                                 shell stays, exited, as if the reaper were late)
 *   POST /__mock/terminal/new?delay=700&fail=reason   (terminal.new takes that long; its next run
 *                                                 fails with that reason; reset: at once, no failure)
 *   POST /__mock/daemon/restart                   (every shell goes without a removed event and the
 *                                                 event streams end: the GUI reconnects and Lists)
 *   POST /__mock/thread/hold?id=s-1&id=s-5   (the clock stops changing them: s-1 stops flipping
 *        busy/idle, a starting or closing one does not settle; the sidebar order then holds still.
 *        e2e's resetMock holds s-1 and s-5.) POST /__mock/thread/release?id=s-5 undoes it.
 *   POST /__mock/link-pr?thread=s-1&slug=owner/name&number=12[&ago=<ms>]   (Claude linked a pull
 *                                                 request ago ms ago; deduplicated by URL like the daemon)
 *   POST /__mock/usage?thread=s-2&model=claude-opus-5&requests=3&cacheRead=1000[&input=…&output=…
 *        &cacheWrite5m=…&cacheWrite1h=…&day=YYYY-MM-DD]   (Claude made requests: added to the
 *                                                 thread's (model, day) bucket; s-1 is seeded)
 *   POST /__mock/threads-service?enabled=false   (simulate a daemon without ThreadService)
 *   POST /__mock/missing-rpc?rpc=ProjectService/ListRefs&rpc=ThreadService/StageAttachment
 *                                                 (simulate a daemon older than those RPCs: 404)
 *   POST /__mock/thread-new?delay=700            (how long thread.new takes to make a worktree)
 *   POST /__mock/worktree/checkout?path=…&branch=…   (the worktree switches branch; no branch detaches HEAD)
 *   POST /__mock/worktree/dirty?path=…&modified=2   (the worktree has modified files; 0: clean)
 *   POST /__mock/worktree/operation?path=…&op=rebase&step=3&total=6&conflicted=2[&file=a.go]
 *                                                 (a git operation stops in that worktree: status
 *                                                 operation fields, U files lead its detail; no op ends it)
 *   POST /__mock/worktree/merged?project=repo-cf&branch=cf/usage-polish[&path=…]   (a clean worktree whose
 *                                                 work is in origin/main: merged_clean, so project.worktree.cleanup removes
 *                                                 it; a path outside ~/.code-foundry/worktrees is never merged_clean)
 *   POST /__mock/workspace?name=login&projects=repo-cf,repo-gp[&root=…&primary=…&instructions=CLAUDE.md&skills=a,b]
 *                                                 (a workspace: a saved project set; nothing on disk changes)
 *   POST /__mock/workspace-files?workspace=login[&instructions=AGENTS.md&skills=a,b&rootMissing=1]
 *                                                 (what a thread wrote in the workspace's folder; "" clears)
 *   POST /__mock/set-thread?projects=repo-sk,repo-wr[&project=…|workspace][&workspace=…][&branch=feat/x][&name=…]
 *                                                 (a thread over a project set; a branch: worktree mode, none: in place)
 *   thread.new --like and thread.new-like copy a thread's set, branch, workspace and mode; thread.new's
 *   sets and thread.new-like return the collision hints as warnings (mock/projectSets.ts);
 *   thread.workspace sets a thread's workspace reference.
 *   POST /__mock/multi-thread?projects=repo-cf,repo-gp[&project=repo-gp&branch=feat/x&name=multi&workspace=login]
 *                                                 (a worktree-mode thread over several projects, its worktrees made)
 *   GET  /__mock/workspaces                       (id, name, members, root, default primary, files)
 *   POST /__mock/thread/project-ids?id=…&projects=repo-cf,repo-gp   (a thread's project set)
 *   POST /__mock/empty                            (a fresh install: no projects, threads or terminals)
 *   POST /__mock/threads?project=repo-cf&count=3&status=busy|idle|attention[&prefix=Job]
 *   POST /__mock/workspace-thread?workspace=login[&project=repo-gp&name=driver&status=busy]
 *                                                 (a connected thread that references the workspace, its
 *                                                 members as its set, in project's main worktree)
 *   thread.run-in queues a move (pendingWorktreePath) that lands ~2s after the thread is not busy.
 *   thread.new takes workspace and/or projects (the set; new-worktree makes worktrees on a new
 *   branch), or no-project (a thread in the home directory with no project or workspace).
 *   ThreadService.Checkouts derives a thread's checkouts (world.checkoutsOf).
 *   GET  /__mock/attachments                      (StageAttachment uploads: path, name, type, size, pages)
 *   FilesystemService.ListSkills / SearchFiles: mock/filesystem.ts (project skills review and
 *        deploy in every project, user skill commit; DEFAULT_FILES in every project)
 *   POST /__mock/files?project=repo-cf&path=a.ts&path=src/b.ts   (that project's files; no path:
 *                                                 none; reset restores DEFAULT_FILES)
 *   GET  /__mock/files/calls                      ("skills <project,…|-> <includeUser>", "search <project> <query>")
 *   POST /__mock/files/search?delay=700&fail=1    (SearchFiles answers after 700ms; fail=1: Internal; reset: at once)
 *   FilesystemService.ReadFile, PreviewFile (+ GET /preview/<grant>/<path>), ProjectService.GetWorktreeFileDiff: mock/files.ts (code-foundry's README.md,
 *        src/app.ts, docs/preview.html, docs/logo.png, bin/tool, docs/, big.log; every detail's changed files)
 *   POST /__mock/fs/write?path=…&text=…           (a file's contents on disk; reset restores the fixtures)
 *   GET  /__mock/fs/calls                         ("read <path>", "diff <worktree> <file> <working|branch>")
 *   thread.new with a prompt containing FAIL fails (after the worktree delay, if any).
 *   POST /__mock/gitops?fail=git.push&delay=800   (next git.push fails; ops take 800ms)
 *   GET  /__mock/gitops
 *   GET  /__mock/settings                          ({ raw, values } of the settings "file")
 *   POST /__mock/settings/external?appearance.font_size=18   (a hand edit; "" deletes a key)
 *   POST /__mock/settings/external?loadError=…               (the file stops parsing)
 *   POST /__mock/backdrops/import?path=/Users/me/Pictures/a.png   (an import, as Add image… does; mock/backdrops.ts)
 *   GET  /__mock/backdrops                         ({ images: names, calls })
 *   GET  /__mock/update
 *   POST /__mock/update/state?state=idle|available|downloading|downloaded|installed|restartRequired|failed&version=v0.2.0[&reason=…]
 *   POST /__mock/update/latest?version=v0.2.0     (what the next check finds)
 *   POST /__mock/update/fail?reason=…             (the next download fails)
 *   POST /__mock/update/disabled?reason=dev%20build
 *        app.restart (Restart Now) and daemon.restart come back as the installed version;
 *        GET /__mock/update counts app.restart runs (restarts)
 *   POST /__mock/gh/update | poll | stale | inbox-zero | auth?ok=false | touch?path=…   (GitHub + detail;
 *        inbox-zero empties the review queue, leaving the reviews that wait on their authors)
 *   POST /__mock/gh/branch-pr?slug=o/r&head=b&number=N&title=…&state=open|draft|merged|closed[&ago=ms][&append=1]
 *                                                 (that branch's pull request, alone or beside the others)
 *   GET  /__mock/gh/calls                         (GhService/GetWorktreeDetail call counts;
 *        "ListReviewerCandidates query" counts the searches)
 *   POST /__mock/gh/pr-fail?command=pr.refresh             (that command's next run fails;
 *        also pr.ask, pr.explain, pr.fix.findings, pr.merge as a moved head, and
 *        pr.review as unconfirmed)
 *   POST /__mock/gh/pr-delay?ms=800          (pr.ask, pr.explain, pr.fix.findings, pr.merge, pr.review take 800ms)
 *   POST /__mock/gh/pr-comment?repo=o/r&number=145&body=…   (a new comment on a PR detail;
 *        pull_request_detail_updated). PR detail fixtures: mock/prDetail.ts (#145 open,
 *        #138 merged, #131 closed, #140 read-only, #142 mergeable, #146 from a fork, #147 open
 *        with failing checks on no dashboard, #139 awaiting the viewer's review); its commands
 *        are pr.merge, pr.revert, pr.review.request, pr.review, pr.comment and pr.refresh
 *        ("SubmitPullRequestReview" and "AddPullRequestComment" count in /__mock/gh/calls)
 *   POST /__mock/gh/pr-push?repo=o/r&number=145&sha=<40 hex>   (the detail's head moves;
 *        pull_request_detail_updated). The Code tab's diff and files: mock/prDiff.ts (one
 *        three-file diff for every pull request, #140's refused as too large; counts
 *        "GetPullRequestDiff", "GetPullRequestDiff refresh", "GetPullRequestFile <path>")
 *   ActionService, the action event source and action.*: mock/actions.ts (repo-cf's six seeded
 *        actions, a-dev000000000 … a-debug0000000; every other project has none). A terminal run
 *        is a kind=action terminal that plays its script and stays EXITED; reset restores the seeds.
 *   GET  /__mock/actions                          (actions and runs as JSON, runs with their output)
 *   POST /__mock/action/finish?run=r-…&code=N     (or terminal=t-…: that running run's process exits
 *                                                 now with code N, default 0)
 *   POST /__mock/action/setup?thread=s-1&code=1[&action=Install deps]   (a worktree-create
 *                                                 background run for that thread: some output, then
 *                                                 code after ~600 ms; default action: the project's
 *                                                 first on-worktree-create one)
 *   POST /__mock/action/run?thread=s-1&action=Test[&mode=terminal|background]   (or worktree=…
 *                                                 instead of thread: a run as the CLI or an agent
 *                                                 would start it, not through the GUI)
 *   POST /__mock/skills?fail=skill.install&error=…   (that skill.* command fails with the message until
 *        cleared with an empty error); registries=none|default (Claude Code without the marketplace);
 *        listError=… (the marketplace list failed); pluginsError=…; epoch=1 (a read, like the hourly
 *        refresh). GET /__mock/skills: { epoch, calls, failures, installed } (mock/skills.ts)
 *   MemoryService, the memory event source and memory.* (mock/memory.ts): four seeded entries (by s-1,
 *        by s-3, from the user's terminal, by the removed s-gone); reset restores them.
 *   POST /__mock/memory?set=empty|seed|long      (the entries, as a hand edit; published; long adds a
 *                                                 700-character entry threads do not get)
 *   POST /__mock/memory?drop=<file>&quiet=1      (a file removed by hand, no event: a stale page)
 *   POST /__mock/memory/add?text=…&thread=s-1    (a thread's memory add: the entry and the "Remembered: …"
 *                                                 toast with its Settings › Memory link)
 *   GET  /__mock/memory                          ({ entries, calls })
 *   ThemeService, the theme event source and theme.show/save/duplicate/delete (mock/userThemes.ts):
 *        three user themes (Ocean Dusk and Mocha, warmer dark, Latte, softer light) and a file that
 *        does not load; reset restores them.
 *   POST /__mock/themes?set=empty|seed           (the themes directory, as a hand edit; published)
 *   POST /__mock/themes/card?thread=s-1&theme=ocean-dusk[&apply=true]   (theme save from that thread:
 *        its theme card and, applied, the toast)
 *   POST /__mock/themes/edit?theme=ocean-dusk&canvas=%23330000   (a save of that theme from outside the window: base colours changed)
 *   POST /__mock/themes/recolour?thread=s-1&theme=ocean-dusk&accent=%23e0a060   (that thread's
 *        refinement of the theme: the replaced version kept, a card whose Undo restores it)
 *   GET  /__mock/themes                          ({ themes, calls })
 *   EmberService (mock/ember.ts): Ember's status and task board; enabled is the ember.enabled setting
 *        (off by default; turning it on adds s-resident-ember and the worker threads s-ember-notes,
 *        s-ember-wails, s-ember-flaky). Seeded tasks: t-1a2b3c4d doing (s-ember-notes, progress),
 *        t-2b3c4d5e done and t-5e6f7a8b todo (its subtasks), t-9c0d1e2f blocked (s-ember-wails
 *        reported blocked), t-3a4b5c6d done today (s-ember-flaky), t-7e8f9a0b cancelled. Reset restores them.
 *        Every change below reaches WatchBoard streams.
 *   GET  /__mock/ember                            (the board: status and tasks, as JSON)
 *   POST /__mock/ember?enabled=true|false         (sets ember.enabled, as the settings page would)
 *   POST /__mock/ember/task?id=t-…&state=todo|doing|blocked|done|cancelled[&outcome=…][&branch=…][&title=…]
 *   POST /__mock/ember/task/add?title=…[&state=todo|…][&parent=t-…][&thread=s-…][&detail=…]   ({ id })
 *   POST /__mock/ember/report?id=s-…&status=done|blocked|failed|progress[&summary=…]   (a worker's report, filed now)
 *   POST /__mock/ember/timer?minutes=…[&every=2m][&note=…]   ({ id }: a timer of Ember's thread; thread.unsubscribe cancels it)
 *   POST /__mock/ember/consolidating?on=true|false   (off: it finished, last_consolidated_at now)
 *   POST /__mock/ember/epoch                      (a fresh session: epoch + 1, started now, context 0)
 *   POST /__mock/ember/restart?step=cut|wake      (cut: the app's restart cuts a turn of Ember's, which
 *        ends error "interrupted" with the daemon's process_ended turn end; wake: the restart notice
 *        wakes it and it replies, finished; mock/emberChat.ts)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Code, ConnectError, cors as connectCors, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs } from "@bufbuild/protobuf/wkt";
import { CommandService, ConfirmationRequiredSchema } from "../src/gen/codefoundry/v1/command_pb";
import { SettingsService, SettingsValidationErrorsSchema } from "../src/gen/codefoundry/v1/settings_pb";
import { EventService, EventSource } from "../src/gen/codefoundry/v1/events_pb";
import { FilesystemService } from "../src/gen/codefoundry/v1/filesystem_pb";
import { GhService } from "../src/gen/codefoundry/v1/gh_pb";
import { HealthService } from "../src/gen/codefoundry/v1/health_pb";
import { ProjectService } from "../src/gen/codefoundry/v1/project_pb";
import { ThreadFlagLevel, ThreadReportStatus, ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { TerminalService, TerminalState, type AttachEventSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { ThreadDecision, ThreadService } from "../src/gen/codefoundry/v1/thread_pb";
import { ActionRunMode, ActionRunState, ActionService } from "../src/gen/codefoundry/v1/action_pb";
import { UiService } from "../src/gen/codefoundry/v1/ui_pb";
import { PluginService } from "../src/gen/codefoundry/v1/plugin_pb";
import { SkillService } from "../src/gen/codefoundry/v1/skill_pb";
import { MemoryService } from "../src/gen/codefoundry/v1/memory_pb";
import { ThemeService } from "../src/gen/codefoundry/v1/theme_pb";
import { UpdateService, UpdateState } from "../src/gen/codefoundry/v1/update_pb";
import { EmberService, type EmberTaskState } from "../src/gen/codefoundry/v1/ember_pb";
import { emberStateNames } from "./ember";
import { groups as settingsGroups, SettingsValidation } from "./settings";
import { updateStateNames, type UpdateEventInit } from "./update";
import { MockFiles } from "./files";
import { mockPaint, publishMockTheme, themeRoute } from "./theme";
import { bridgeRoute, holdWait, mockWaits, resetWaits } from "./bridge";
import { pagelibRoute } from "./pagelib";
import { completionCalls, listDirectories, listSkills, resetCompletion, searchFilesSlow, searchMode, setMockFiles } from "./filesystem";
import { cloneRepo, githubCalls, lookupGitHub, resetClones, searchGitHub } from "./clone";
import { createProject, deleteProject, listPublishOwners, projectCalls, publishProject, resetProjects, visibilityFlag } from "./create";
import { ghEvent } from "./github";
import { prDetailCall } from "./prDetail";
import { retiredUsage, utcDay } from "./usage";
import { ageMcp, reconnectMcp, refreshMcp } from "./mcp";
import type { ActionEventInit } from "./actions";
import { pageStorageOf, resetPageStorage, setPageStorage } from "./pageStorage";
import { listPrompts } from "./prompts";
import { mockFetches, mockProxyFetch, resetFetches } from "./proxyFetch";
import { refuseSlashCommand, slashCommandsFor } from "./slashCommands";
import { MOCK_ATTACHMENT, MOCK_ATTACHMENT_PNG, MockThreadLogs, THREAD_STATES, type ThreadState as ScriptedThreadState } from "./thread";
import { CommandError, ConfirmNeeded, snoozeUntil, World, type EventInit } from "./world";

type AttachEventInit = MessageInitShape<typeof AttachEventSchema>;

const port = Number(process.env.MOCK_PORT ?? 7788);
const token = process.env.MOCK_TOKEN ?? "dev-mock-token";
const world = new World();
/** Files on disk and worktree file diffs, over the worktree details' changed files. */
const mockFiles = new MockFiles((path) => {
  const d = world.gh.details.get(path);
  if (!d) return undefined;
  return { projectId: d.projectId ?? "", baseRef: d.baseRef, files: (d.files ?? []).map((f) => ({ path: f.path ?? "", status: f.status ?? "", oldPath: f.oldPath, binary: f.binary, uncommitted: f.uncommitted })) };
});

/**
 * MOCK_SCENARIO=status-kinds: the status-kinds threads (World.addStatusKinds) in the world from
 * the start and after every reset; transcript-deleted: the thread whose transcript Claude
 * Code deleted (World.addTranscriptDeleted).
 */
function seedScenario(): void {
  if (process.env.MOCK_SCENARIO === "status-kinds") world.addStatusKinds();
  if (process.env.MOCK_SCENARIO === "transcript-deleted") world.addTranscriptDeleted();
}
seedScenario();

/** False simulates a pre-Phase-2a daemon (see POST /__mock/threads-service). */
let threadsEnabled = true;
/** "Service/Method" paths that 404 like a daemon built before they existed. */
const missingRpcs = new Set<string>();

function rpcError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  if (err instanceof ConfirmNeeded) {
    return new ConnectError(err.message, Code.FailedPrecondition, undefined, [
      { desc: ConfirmationRequiredSchema, value: { command: err.command, title: err.title, message: err.message, confirmLabel: err.confirmLabel } },
    ]);
  }
  if (err instanceof SettingsValidation) {
    return new ConnectError(err.message, Code.InvalidArgument, undefined, [{ desc: SettingsValidationErrorsSchema, value: { errors: err.issues } }]);
  }
  if (err instanceof CommandError) {
    const code = { unavailable: Code.FailedPrecondition, invalid: Code.InvalidArgument, notfound: Code.NotFound }[err.kind];
    return new ConnectError(err.message, code);
  }
  return ConnectError.from(err);
}

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw rpcError(err);
  }
}

async function* attach(id: string, signal: AbortSignal): AsyncGenerator<AttachEventInit> {
  const t = guard(() => world.term(id));
  if (t.state !== TerminalState.RUNNING) {
    yield world.snapshot(t);
    yield { event: { case: "exited", value: { exitCode: t.exitCode } } };
    return;
  }
  // Subscribe before taking the snapshot so no output falls between them.
  const live = t.attach.subscribe(signal);
  const first = live.next();
  try {
    yield world.snapshot(t);
    for (let r = await first; !r.done; r = await live.next()) {
      if (r.value === "end") return;
      yield r.value;
    }
  } finally {
    void live.return(undefined);
  }
}

/** GitHub slugs of the mock's registered projects (what the real daemon tracks). */
function trackedSlugs(): string[] {
  return [...world.projects.values()].map((r) => r.githubSlug.toLowerCase()).filter(Boolean).sort();
}

function routes(router: ConnectRouter): void {
  router.service(HealthService, {
    ping: () => ({ pid: process.pid, version: "mock", uptime: durationFromMs(Date.now() - world.startedAt) }),
    version: () => ({ version: "mock", commit: "", goVersion: "" }),
  });

  router.service(TerminalService, {
    list: () => ({ terminals: [...world.terms.values()].map((t) => world.terminalMsg(t)) }),
    get: (req) => guard(() => ({ terminal: world.terminalMsg(world.term(req.id)) })),
    create: (req) =>
      guard(() => {
        const t = world.create(req.argv.length ? req.argv : ["/bin/zsh"], req.cwd || "/tmp", req.labels, "shell");
        return { terminal: world.terminalMsg(t) };
      }),
    attach: (req, ctx) => tracked("TerminalService/Attach", attach(req.id, ctx.signal)),
    write: (req) => guard(() => (world.write(req.id, req.data), {})),
    resize: (req) => guard(() => (world.resize(req.id, req.cols, req.rows), {})),
    kill: (req) => guard(() => (world.kill(req.id), {})),
    remove: (req) => guard(() => (world.remove(req.id), {})),
    close: (req) => guard(() => (world.close(req.id), {})),
    watch: (_req, ctx) => tracked("TerminalService/Watch", world.termEvents.subscribe(ctx.signal)),
  });

  router.service(ProjectService, {
    list: () => ({ projects: [...world.projects.values()].map((r) => world.projectMsg(r)) }),
    get: (req) => {
      const r = world.projects.get(req.id);
      if (!r) throw new ConnectError(`project ${req.id} not found`, Code.NotFound);
      return { project: world.projectMsg(r) };
    },
    // The Add Project dialog's Local folder tab and an existing clone destination.
    register: (req) => guard(() => ({ project: world.projectMsg(world.registerFolder(req.path)) })),
    inspectFolder: (req) => guard(() => world.inspectFolder(req.path)),
    unregister: () => {
      throw new ConnectError("use the project.unregister command in the mock", Code.Unimplemented);
    },
    createWorktree: () => {
      throw new ConnectError("use the worktree.create command in the mock", Code.Unimplemented);
    },
    removeWorktree: () => {
      throw new ConnectError("use the worktree.remove command in the mock", Code.Unimplemented);
    },
    refresh: () => ({}),
    listRefs: (req) => guard(() => world.listRefs(req.projectId)),
    initGit: (req) => guard(() => ({ project: world.projectMsg(world.initGit(req.id)) })),
    // The Add Project dialog's GitHub tab (mock/clone.ts).
    searchGitHub: (req) => searchGitHub(req.query),
    lookupGitHub: (req) => lookupGitHub(req.owner, req.name),
    clone: (req, ctx) => cloneRepo(world, req.owner, req.name, ctx.signal),
    // The New tab and the publish dialog (mock/create.ts); the GUI goes through the
    // project.create and project.github.publish commands, these serve the RPCs themselves.
    create: (req) => {
      const r = createProject(world, req.name);
      const project = world.projects.get(r.id);
      if (!project) throw new ConnectError("created project vanished", Code.Internal);
      return { project: world.projectMsg(project) };
    },
    listPublishOwners: () => listPublishOwners(),
    delete: (req) => {
      deleteProject(world, req.id);
      return {};
    },
    publish: async (req) => {
      const vis = visibilityFlag(req.visibility);
      await publishProject(world, req.projectId, req.owner, req.name, vis);
      const project = world.projects.get(req.projectId);
      if (!project) throw new ConnectError("published project vanished", Code.Internal);
      return { project: world.projectMsg(project) };
    },
    getWorktreeDetail: (req) => {
      const detail = world.gh.getWorktreeDetail(req.projectId, req.path);
      if (!detail) throw new ConnectError(`worktree ${req.path} not found`, Code.NotFound);
      return { detail };
    },
    getWorktreeFileDiff: (req) => mockFiles.fileDiff(req.path, req.file, req.oldPath, req.scope),
    watch: (_req, ctx) => tracked("ProjectService/Watch", world.projectEvents.subscribe(ctx.signal)),
  });

  router.service(FilesystemService, {
    listDirectories: (req) => {
      const registered = new Set([...world.projects.values()].flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)]));
      return listDirectories(req.prefix, registered);
    },
    listSkills: (req) => ({ skills: listSkills(world.projects, req.sources, req.includeUser) }),
    searchFiles: (req) => searchFilesSlow(world.projects, req.projectId, req.path, req.query, req.limit),
    readFile: (req) => mockFiles.readFile(req.baseDir, req.path, req.maxBytes),
    previewFile: (req) => mockFiles.previewFile(req.baseDir, req.path),
  });

  router.service(GhService, {
    getViewer: () => ({ viewer: world.gh.dashboard.viewer, authenticated: world.gh.authenticated, fetchedAt: world.gh.dashboard.fetchedAt }),
    getDashboard: () => world.gh.getDashboard(trackedSlugs()),
    getRepoActivity: (req) => world.gh.getRepoActivity(req.repoSlug.toLowerCase()),
    getBranchPullRequests: (req) => {
      if (!req.headRef) throw new ConnectError("head_ref is required", Code.InvalidArgument);
      return world.gh.getBranchPullRequests(req.repoSlug.toLowerCase(), req.headRef);
    },
    refresh: () => ({}),
    getPullRequestDetail: (req) => prDetailCall(() => ({ detail: world.gh.prDetails.get(req.repoSlug, req.number, req.refresh) })),
    listReviewerCandidates: (req) => prDetailCall(() => world.gh.prDetails.listCandidates(req.repoSlug, req.number, req.query)),
    setReviewRequest: (req) =>
      prDetailCall(() => ({ requested: world.gh.prDetails.setReviewRequest(req.repoSlug, req.number, req.login, req.kind, req.requested) })),
    revertPullRequest: (req) => prDetailCall(() => world.gh.prDetails.revert(req.repoSlug, req.number)),
    mergePullRequest: (req) => prDetailCall(() => world.gh.prDetails.merge(req.repoSlug, req.number, req.method, req.deleteBranch, req.expectedHeadSha)),
    submitPullRequestReview: (req) => prDetailCall(() => world.gh.prDetails.submitReview(req.repoSlug, req.number, req.event, req.body)),
    addPullRequestComment: (req) => prDetailCall(() => world.gh.prDetails.postComment(req.repoSlug, req.number, req.body)),
    getPullRequestDiff: (req) => world.gh.prDiffs.diff(req.repoSlug, req.number, req.refresh),
    getPullRequestFile: (req) => world.gh.prDiffs.file(req.repoSlug, req.ref, req.path),
  });

  router.service(CommandService, {
    list: (req) => ({ commands: world.listCommands(req.context, req.includeUnavailable) }),
    // Git operations resolve when the fake op finishes (mock/gitops.ts), like the daemon.
    invoke: async (req, ctx) => {
      // Held until the caller aborts it (mock/bridge.ts holdWait).
      if (req.name === "thread.wait") return holdWait(req.args, ctx.signal);
      try {
        const out = await world.invoke(req.name, req.context, req.args, req.confirmed);
        return typeof out === "string" ? { message: out, resultJson: "" } : out;
      } catch (err) {
        throw rpcError(err);
      }
    },
  });

  router.service(SettingsService, {
    getSchema: () => ({ groups: settingsGroups, fields: world.settings.fields(), pages: world.settings.pages() }),
    get: () => ({ settings: world.settings.snapshot() }),
    update: (req) => {
      try {
        return { settings: world.settings.update(req.values) };
      } catch (err) {
        if (err instanceof SettingsValidation) throw rpcError(err);
        throw new ConnectError((err as Error).message, Code.FailedPrecondition);
      }
    },
    listBackdrops: () => ({ backdrops: world.backdrops.list() }),
    importBackdrop: (req) => guard(() => ({ backdrop: world.backdrops.import(req.path) })),
    removeBackdrop: (req) => guard(() => {
      world.backdrops.remove(req.name);
      return {};
    }),
    readBackdrop: (req) => guard(() => world.backdrops.read(req.name)),
    watch: async function* (_req, ctx) {
      yield { event: { case: "snapshot" as const, value: world.settings.snapshot() } };
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.SETTINGS && event.event?.case === "settings") yield event.event.value;
      }
    },
  });

  router.service(UiService, {
    watchIntents: (_req, ctx) => tracked("UiService/WatchIntents", world.intents.subscribe(ctx.signal)),
    emit: (req) => ({ delivered: req.intent ? world.emit(req.intent) : 0 }),
    publishTheme: (req) => {
      try {
        publishMockTheme({ id: req.id, scheme: req.scheme, vars: req.vars });
      } catch (err) {
        throw new ConnectError(err instanceof Error ? err.message : String(err), Code.InvalidArgument);
      }
      return {};
    },
    publishThemeReport: (req) => {
      try {
        world.themes.publishReports(req.reports);
      } catch (err) {
        throw new ConnectError(err instanceof Error ? err.message : String(err), Code.InvalidArgument);
      }
      return {};
    },
  });

  router.service(ThreadService, {
    list: () => ({ threads: [...world.threads.values()].map((s) => world.threadMsg(s)), retiredUsage: retiredUsage() }),
    get: (req) => guard(() => ({ thread: world.threadMsg(world.thread(req.id)) })),
    create: () => {
      throw new ConnectError("use the thread.new command in the mock", Code.Unimplemented);
    },
    fork: () => {
      throw new ConnectError("fork is not mocked", Code.Unimplemented);
    },
    rename: () => {
      throw new ConnectError("use the thread.rename command in the mock", Code.Unimplemented);
    },
    // Kept in the proto for compatibility; the daemon starts and stops threads itself and no
    // command calls them (docs/notes/thread-lifecycle.md).
    close: () => {
      throw new ConnectError("the daemon starts and stops threads itself", Code.Unimplemented);
    },
    reconnect: () => {
      throw new ConnectError("the daemon starts and stops threads itself", Code.Unimplemented);
    },
    remove: () => {
      throw new ConnectError("use the thread.remove command in the mock", Code.Unimplemented);
    },
    stageAttachment: (req) =>
      guard(() => ({ path: req.path ? world.stageAttachmentPath(req.path, req.pages) : world.stageAttachment(req.name, req.mimeType, req.data, req.pages) })),
    // The scripted thread's image (mock/thread.ts); a staged PDF reads back as its bytes, a
    // staged image as that same PNG.
    readAttachment: (req) => {
      const pdf = world.attachmentBytes.get(req.path);
      if (pdf) return { data: pdf, mimeType: "application/pdf" };
      if (req.path === MOCK_ATTACHMENT || world.attachments.has(req.path)) return { data: new Uint8Array(MOCK_ATTACHMENT_PNG), mimeType: "image/png" };
      throw new ConnectError(`attachment ${req.path} not found`, Code.NotFound);
    },
    watch: (_req, ctx) => tracked("ThreadService/Watch", world.threadListEvents.subscribe(ctx.signal, [world.threadListSnapshot()])),
    // ThreadService.Checkouts: the thread's checkouts (world.checkoutsOf); the GUI's Worktree tab lists the others as Also in.
    checkouts: (req) => guard(() => world.checkoutsMsg(req.id)),
    // The conversation (mock/thread.ts). The GUI goes through the thread.* commands for
    // Send / Interrupt / Respond / SetModel / SetPermissionMode / SetEffort; these serve the RPCs themselves.
    listItems: (req) => guard(() => ({ snapshot: world.logs.snapshotValue(req.threadId) })),
    // ThreadService.ListPrompts: the user's sent prompts (mock/prompts.ts).
    listPrompts: (req) => guard(() => listPrompts(world, req)),
    watchThread: (req, ctx) => tracked("ThreadService/WatchThread", guard(() => world.logs.watch(req.threadId, ctx.signal))),
    send: (req) => guard(() => (refuseSlashCommand(req.text), { item: world.logs.send(req.threadId, req.text, req.attachments, req.composerText) })),
    slashCommands: (req) => guard(() => ({ commands: world.logs.slashCommandsOf(req.threadId) })),
    // code-foundry view.inline's RPC (docs/notes/inline-html.md).
    showHtml: (req) => guard(() => ({ item: world.logs.showHtml(req.threadId, req.path, req.title) })),
    // What a thread's pages keep with cf.storage (mock/pageStorage.ts).
    pageStorage: (req) => guard(() => (world.thread(req.threadId), { values: pageStorageOf(req.threadId) })),
    setPageStorage: (req) => guard(() => (world.thread(req.threadId), { values: setPageStorage(req.threadId, req.key, req.value) })),
    // A page's cf.fetch, against a fake upstream (mock/proxyFetch.ts).
    proxyFetch: (req, ctx) => (guard(() => world.thread(req.threadId)), mockProxyFetch(req, ctx.signal)),
    interrupt: (req) => guard(() => (world.logs.finish(req.threadId, { interrupted: true }), {})),
    respond: (req) =>
      guard(() => {
        const decision = req.decision === ThreadDecision.DENY ? "deny" : req.decision === ThreadDecision.ALLOW_FOR_SESSION ? "allow-session" : "allow";
        return { item: world.logs.respond(req.threadId, req.requestId, decision, req.answers, req.message) };
      }),
    setEffort: (req) => guard(() => (world.logs.setEffort(req.threadId, req.effort), { thread: world.threadMsg(world.thread(req.threadId)) })),
    // MCP (mock/mcp.ts): the GUI reads McpStatus once for a thread never checked; refresh and reconnect go through thread.mcp / thread.mcp-reconnect.
    mcpStatus: (req) => guard(() => ({ status: req.refresh ? refreshMcp(world.logs, req.threadId) : world.logs.mcpOf(req.threadId) })),
    mcpReconnect: async (req) => {
      try {
        return await reconnectMcp(world.logs, req.threadId, req.serverName);
      } catch (err) {
        throw rpcError(err);
      }
    },
  });

  // Actions (mock/actions.ts). The GUI may also go through the action.* commands.
  router.service(ActionService, {
    list: (req) => world.actions.list(req.projectId),
    create: (req) => guard(() => ({ action: world.actions.create(req) })),
    update: (req) => guard(() => ({ action: world.actions.update(req) })),
    delete: (req) => guard(() => (world.actions.delete(req.id), {})),
    run: (req) => guard(() => ({ run: world.actions.run(req) })),
    getRun: (req) => guard(() => ({ run: world.actions.getRun(req.runId) })),
    waitRun: async (req, ctx) => {
      try {
        return { run: await world.actions.waitRun(req.runId, ctx.signal) };
      } catch (err) {
        throw rpcError(err);
      }
    },
    watch: (_req, ctx) => tracked("ActionService/Watch", actionEvents(world.events.subscribe(ctx.signal, [{ source: EventSource.ACTION, event: { event: { case: "action", value: world.actions.snapshot() } } }]))),
  });

  router.service(UpdateService, {
    get: () => ({ status: world.update.msg() }),
    check: () => guard(() => (world.update.check(), { status: world.update.msg() })),
    download: () => guard(() => (world.update.download(), { status: world.update.msg() })),
    install: () => guard(() => (world.update.install(), { status: world.update.msg() })),
    relaunch: () => ({ delivered: world.update.relaunch() }),
    watch: (_req, ctx) => tracked("UpdateService/Watch", updateEvents(world.events.subscribe(ctx.signal, [{ source: EventSource.UPDATE, event: { event: { case: "update", value: world.update.event() } } }]))),
  });

  // Plugins (mock/plugins.ts): the list, the hello demo's surface, acts, logs, environment.
  router.service(PluginService, {
    list: (req) => ({ plugins: world.plugins.list(req.context), ...world.plugins.dirs() }),
    enable: (req) =>
      guard(() => {
        const p = world.plugins.list().find((x) => x.name === req.name);
        if (p?.needsConsent && !req.consent) return { plugin: p, needsConsent: true, consentText: p.consentText ?? "" };
        void world.invoke("plugin.enable", undefined, { name: req.name }, true);
        return { plugin: world.plugins.list().find((x) => x.name === req.name) };
      }),
    disable: (req) => guard(() => (void world.invoke("plugin.disable", undefined, { name: req.name }), { plugin: world.plugins.list().find((x) => x.name === req.name) })),
    restart: (req) => guard(() => (void world.invoke("plugin.restart", undefined, { name: req.name }), { plugin: world.plugins.list().find((x) => x.name === req.name) })),
    logs: (req) => guard(() => world.plugins.logs(req.name)),
    environment: () => ({ environments: world.plugins.environment() }),
    browse: (req) => world.plugins.registry.browse(req.refresh),
    refreshRegistries: () => ({ registries: world.plugins.registry.browse(true).registries }),
    listSecrets: (req) => guard(() => ({ secrets: world.plugins.listSecrets(req.name) })),
    deleteSecret: (req) => guard(() => (world.plugins.deleteSecret(req.name, req.key), {})),
    reload: () => ({}),
    watch: async function* (_req, ctx) {
      yield world.plugins.snapshot();
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.PLUGIN && event.event?.case === "plugin") yield event.event.value;
      }
    },
    watchSurface: (req, ctx) => {
      if (!req.ref) throw new ConnectError("a surface ref is required", Code.InvalidArgument);
      const ref = req.ref;
      return tracked("PluginService/WatchSurface", world.plugins.watch(ref, ctx.signal));
    },
    act: async (req) => ({ version: await world.plugins.act(req) }),
  });

  // The Skills marketplace (mock/skills.ts): reads only; the actions are skill.* commands.
  router.service(SkillService, {
    search: (req) => world.skills.search(req),
    installed: () => world.skills.list(),
    registries: () => world.skills.registries(),
    watch: async function* (_req, ctx) {
      yield world.skills.event();
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.SKILL && event.event?.case === "skill") yield event.event.value;
      }
    },
  });

  // The app memory (mock/memory.ts): reads only; writes are the memory.* commands.
  router.service(MemoryService, {
    get: () => ({ memory: world.memory.snapshot() }),
    watch: async function* (_req, ctx) {
      yield world.memory.event();
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.MEMORY && event.event?.case === "memory") yield event.event.value;
      }
    },
  });

  // The user's themes (mock/userThemes.ts): reads only; writes are the theme.* commands.
  router.service(ThemeService, {
    list: () => ({ themes: world.themes.snapshot() }),
    watch: async function* (_req, ctx) {
      yield world.themes.event();
      for await (const { source, event } of world.events.subscribe(ctx.signal)) {
        if (source === EventSource.THEME && event.event?.case === "theme") yield event.event.value;
      }
    },
  });

  // Ember (mock/ember.ts): reads only; the board changes through the /__mock/ember controls.
  router.service(EmberService, {
    getStatus: () => ({ status: world.ember.status() }),
    listTasks: (req) => ({ tasks: world.ember.list(req.open) }),
    watchBoard: (_req, ctx) => tracked("EmberService/WatchBoard", world.ember.watch(ctx.signal)),
  });

  router.service(EventService, {
    // The real daemon paces GitHub polling by it; the mock has nothing to pace.
    setClientState: () => ({}),
    // Snapshots first in the order events.proto promises (project, workspace, terminal,
    // thread, gh, gitops, theme, settings, update, action, plugin, skill, memory), then everything published, filtered by `sources`.
    watch: (req, ctx) => {
      const want = new Set(
        req.sources.length > 0
          ? req.sources
          : [EventSource.PROJECT, EventSource.WORKSPACE, EventSource.TERMINAL, EventSource.THREAD_LIST, EventSource.THREAD, EventSource.GH, EventSource.GITOPS, EventSource.THEME, EventSource.SETTINGS, EventSource.UPDATE, EventSource.UI, EventSource.ACTION, EventSource.PLUGIN, EventSource.SKILL, EventSource.MEMORY],
      );
      if (!threadsEnabled) want.delete(EventSource.THREAD_LIST);
      const initial: { source: EventSource; event: EventInit }[] = [
        { source: EventSource.PROJECT, event: { event: { case: "project", value: { event: { case: "snapshot", value: { projects: [...world.projects.values()].map((r) => world.projectMsg(r)) } } } } } },
        { source: EventSource.WORKSPACE, event: { event: { case: "workspace", value: world.workspaceSnapshot() } } },
        ...[...world.terms.values()].map((t) => ({ source: EventSource.TERMINAL, event: { event: { case: "terminal" as const, value: { event: { case: "updated" as const, value: world.terminalMsg(t) } } } } })),
        { source: EventSource.THREAD_LIST, event: { event: { case: "threadList", value: world.threadListSnapshot() } } },
        { source: EventSource.THREAD, event: { event: { case: "thread", value: world.logs.pendingSnapshot() } } },
        ghEvent(world.gh.polledEvent()),
        { source: EventSource.GITOPS, event: { event: { case: "gitops", value: world.gitops.snapshot() } } },
        { source: EventSource.THEME, event: { event: { case: "theme", value: world.themes.event() } } },
        { source: EventSource.SETTINGS, event: { event: { case: "settings", value: { event: { case: "snapshot", value: world.settings.snapshot() } } } } },
        { source: EventSource.UPDATE, event: { event: { case: "update", value: world.update.event() } } },
        { source: EventSource.ACTION, event: { event: { case: "action", value: world.actions.snapshot() } } },
        { source: EventSource.PLUGIN, event: { event: { case: "plugin", value: world.plugins.snapshot() } } },
        { source: EventSource.SKILL, event: { event: { case: "skill", value: world.skills.event() } } },
        { source: EventSource.MEMORY, event: { event: { case: "memory", value: world.memory.event() } } },
      ];
      const ui = want.has(EventSource.UI);
      return tracked("EventService/Watch", filterEvents(world.events.subscribe(ctx.signal, initial), want), () => {
        if (ui) world.uiEventWatchers++;
        return () => {
          if (ui) world.uiEventWatchers--;
        };
      });
    },
  });
}

async function* actionEvents(src: AsyncGenerator<{ source: EventSource; event: EventInit }>): AsyncGenerator<ActionEventInit> {
  for await (const { source, event } of src) {
    if (source === EventSource.ACTION && event.event?.case === "action") yield event.event.value;
  }
}

/** Action controls: GET /__mock/actions, POST /__mock/action/{finish|setup|run}. */
function actionControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const modes: Record<string, ActionRunMode> = { terminal: ActionRunMode.TERMINAL, background: ActionRunMode.BACKGROUND };
  try {
    let run;
    switch (action) {
      case "finish":
        run = world.actions.finishNow({ run: q.get("run") ?? undefined, terminal: q.get("terminal") ?? undefined }, Number(q.get("code") ?? "0"));
        break;
      case "setup":
        run = world.actions.setupRun(q.get("thread") ?? "", Number(q.get("code") ?? "1"), q.get("action") ?? "");
        break;
      case "run": {
        const mode = q.get("mode") ?? "";
        if (mode && modes[mode] === undefined) throw new CommandError("invalid", "mode must be terminal or background");
        run = world.actions.run({ action: q.get("action") ?? "", threadId: q.get("thread") ?? "", worktreePath: q.get("worktree") ?? "", mode: modes[mode] ?? ActionRunMode.UNSPECIFIED });
        break;
      }
      default:
        json(res, 404, { error: "unknown action control" });
        return;
    }
    json(res, 200, { id: run.id, terminalId: run.terminalId, state: ActionRunState[run.state ?? 0], mode: ActionRunMode[run.mode ?? 0], exitCode: run.exitCode, output: run.output });
  } catch (err) {
    json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Ember controls: POST /__mock/ember[/task|/task/add|/report|/timer|/consolidating|/epoch]. */
function emberControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const e = world.ember;
  const bool = (name: string): boolean => {
    const v = q.get(name);
    if (v !== "true" && v !== "false") throw new CommandError("invalid", `${name} must be true or false`);
    return v === "true";
  };
  const state = (v: string | null): EmberTaskState => {
    const s = emberStateNames[v ?? ""];
    if (s === undefined) throw new CommandError("invalid", "state must be one of " + Object.keys(emberStateNames).join(", "));
    return s;
  };
  try {
    switch (action) {
      case "":
        world.settings.update({ "ember.enabled": String(bool("enabled")) });
        break;
      case "/task":
        e.setTask(q.get("id") ?? "", state(q.get("state")), q.get("outcome"), q.get("branch"), q.get("title"));
        break;
      case "/task/add": {
        const id = e.addTask({ title: q.get("title") ?? "", state: q.has("state") ? state(q.get("state")) : undefined, parentId: q.get("parent") ?? "", threadId: q.get("thread") ?? "", detail: q.get("detail") ?? "" });
        json(res, 200, { id });
        return;
      }
      case "/report": {
        const status = { done: ThreadReportStatus.DONE, blocked: ThreadReportStatus.BLOCKED, failed: ThreadReportStatus.FAILED, progress: ThreadReportStatus.PROGRESS }[q.get("status") ?? ""];
        if (status === undefined) throw new CommandError("invalid", "status must be done, blocked, failed or progress");
        e.setReport(q.get("id") ?? "", status, q.get("summary") ?? "");
        break;
      }
      case "/timer": {
        const id = e.addTimer({ minutes: Number(q.get("minutes") ?? ""), every: q.get("every") ?? "", note: q.get("note") ?? "" });
        json(res, 200, { id });
        return;
      }
      case "/consolidating":
        e.setConsolidating(bool("on"));
        break;
      case "/epoch":
        e.nextEpoch();
        break;
      case "/restart": {
        const step = q.get("step");
        if (step !== "cut" && step !== "wake") throw new CommandError("invalid", "step must be cut or wake");
        world.emberRestart(step);
        break;
      }
      default:
        json(res, 404, { error: "unknown ember control" });
        return;
    }
    json(res, 200, e.json());
  } catch (err) {
    json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function* updateEvents(src: AsyncGenerator<{ source: EventSource; event: EventInit }>): AsyncGenerator<UpdateEventInit> {
  for await (const { source, event } of src) {
    if (source === EventSource.UPDATE && event.event?.case === "update") yield event.event.value;
  }
}

/** Update controls: POST /__mock/update/{state|latest|fail|disabled}. */
function updateControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const u = world.update;
  switch (action) {
    case "state": {
      const state = updateStateNames[q.get("state") ?? ""];
      if (state === undefined) {
        json(res, 400, { error: "state must be one of " + Object.keys(updateStateNames).join(", ") });
        return;
      }
      u.set(state, state === UpdateState.IDLE ? "" : (q.get("version") ?? "v0.2.0"), {
        failureReason: q.get("reason") ?? (state === UpdateState.FAILED ? "installer: exit status 1: error: checksum mismatch" : ""),
        progress: state === UpdateState.DOWNLOADING ? "==> downloading code-foundry-darwin-arm64.tar.gz" : "",
        currentVersion: q.get("current") ?? u.status.currentVersion,
        lastCheckedAt: new Date(),
      });
      break;
    }
    case "latest":
      u.latest = q.get("version") ?? "v0.2.0";
      break;
    case "fail":
      u.failNext = q.get("reason") ?? "installer: exit status 1: error: checksum mismatch";
      break;
    case "disabled":
      u.set(UpdateState.IDLE, "", { enabled: false, disabledReason: q.get("reason") ?? "dev build" });
      break;
    default:
      json(res, 404, { error: "unknown update action" });
      return;
  }
  json(res, 200, updateSummary());
}

function updateSummary(): Record<string, unknown> {
  const s = world.update.status;
  return { state: UpdateState[s.state], current: s.currentVersion, target: s.targetVersion, progress: s.progress, relaunches: world.update.relaunches, restarts: world.update.restarts };
}

async function* filterEvents(src: AsyncGenerator<{ source: EventSource; event: EventInit }>, want: Set<EventSource>): AsyncGenerator<EventInit> {
  for await (const { source, event } of src) if (want.has(source)) yield event;
}

/** Long-lived streams currently open, by RPC, for GET /__mock/streams (connection budget tests). */
const openStreams = new Map<string, number>();

function bump(name: string, by: number): void {
  const n = (openStreams.get(name) ?? 0) + by;
  if (n > 0) openStreams.set(name, n);
  else openStreams.delete(name);
}

async function* tracked<T>(name: string, src: AsyncIterable<T>, onOpen?: () => () => void): AsyncGenerator<T> {
  bump(name, 1);
  const onClose = onOpen?.();
  try {
    yield* src;
  } finally {
    onClose?.();
    bump(name, -1);
  }
}

const rpc = connectNodeAdapter({ routes });

const allowHeaders = [...connectCors.allowedHeaders, "Authorization"].join(", ");
const exposeHeaders = connectCors.exposedHeaders.join(", ");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(body, null, 2));
}

/** JSON-safe thread summary (proto timestamps carry bigints). */
function threadSummary(id: string): Record<string, unknown> {
  const s = world.thread(id);
  return {
    id: s.id,
    name: s.name,
    state: ThreadState[s.state],
    status: ThreadStatus[s.status],
    statusReason: s.statusReason,
    statusChangedAt: s.statusChangedAt.toISOString(),
    projectId: s.projectId,
    worktreePath: s.worktreePath,
    workspaceId: s.workspaceId,
    projectIds: world.projectIdsOf(s),
    branch: s.branch,
    createdWorktree: s.createdWorktree,
    pendingWorktreePath: s.pendingWorktreePath,
    pinned: s.pinned,
    archivedAt: s.archivedAt?.toISOString() ?? null,
    snoozedUntil: s.snoozedUntil?.toISOString() ?? null,
    linkedPullRequests: s.linkedPullRequests.map((l) => ({ slug: l.slug, number: l.number, url: l.url })),
    flags: s.flags.map((f) => ({ plugin: f.plugin, level: ThreadFlagLevel[f.level], reason: f.reason, untilSeen: f.untilSeen })),
  };
}

const statusNames: Record<string, ThreadStatus> = { busy: ThreadStatus.BUSY, idle: ThreadStatus.IDLE, attention: ThreadStatus.NEEDS_ATTENTION };
const flagLevels: Record<string, ThreadFlagLevel | null> = { attention: ThreadFlagLevel.ATTENTION, error: ThreadFlagLevel.ERROR, none: null };

/**
 * Thread controls: POST /__mock/thread/{attention|status|stop|hold|release|focus|archive|snooze|wake|flag|envstale|transcript}?id=…[&status=…][&reason=…&code=…].
 * transcript: [&missing=false] (Claude Code deleted the thread's transcript: stopped, held and flagged).
 * flag: &plugin=…&name=<display name>&level=attention|error|none&reason=…[&untilSeen=1] (a plugin's thread/setFlag).
 */
function threadControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const id = q.get("id") ?? "";
  try {
    switch (action) {
      case "attention":
        world.setThreadStatus(id, ThreadStatus.NEEDS_ATTENTION, q.get("reason") ?? undefined);
        break;
      case "status": {
        const status = statusNames[q.get("status") ?? ""];
        if (status === undefined) throw new CommandError("invalid", "status must be busy, idle or attention");
        world.setThreadStatus(id, status, q.get("reason") ?? undefined);
        break;
      }
      case "stop": {
        const at = q.get("status");
        const status = at === null ? undefined : statusNames[at];
        if (at !== null && status === undefined) throw new CommandError("invalid", "status must be busy, idle or attention");
        world.stopThread(id, q.get("reason") ?? "crashed", Number(q.get("code") ?? 1), status);
        break;
      }
      case "hold":
      case "release":
        for (const each of q.getAll("id")) world.holdThread(each, action === "hold");
        break;
      case "focus":
        json(res, 200, { delivered: world.focusThread(id) });
        return;
      case "archive":
        world.archiveThread(id, q.get("archived") !== "false");
        break;
      case "sidebar":
        world.setThreadSidebar(id, q.get("shown") !== "false");
        break;
      case "snooze":
        world.snoozeThread(id, snoozeUntil({ until: q.get("until") ?? "", clear: q.get("clear") ?? "" }));
        break;
      case "wake":
        world.wakeThread(id);
        break;
      case "envstale":
        world.setPluginEnvChange(id, q.get("change") ?? "");
        break;
      case "transcript":
        world.setTranscriptMissing(id, q.get("missing") !== "false");
        break;
      case "flag": {
        const level = flagLevels[q.get("level") ?? "attention"];
        if (level === undefined) throw new CommandError("invalid", "level must be attention, error or none");
        const plugin = q.get("plugin") ?? "hello";
        world.setFlag(id, { plugin, pluginDisplayName: q.get("name") ?? plugin, level, reason: q.get("reason") ?? "", untilSeen: q.get("untilSeen") === "1" });
        break;
      }
      default:
        json(res, 404, { error: "unknown thread action" });
        return;
    }
    json(res, 200, threadSummary(id));
  } catch (err) {
    json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/**
 * Plugin controls: POST /__mock/plugin/state?name=hello&state=crashed|running|failed,
 * POST /__mock/plugin/toast?name=hello&text=…, POST /__mock/plugin/invoke?name=hello&command=plugin.hello.forget[&thread=s-1],
 * POST /__mock/plugin/registry?error=… (the default registry's Browse error; empty clears it) and/or
 * &installError=… (every install fails with it after its first step; empty clears it),
 * POST /__mock/plugin/dirs?home=… (the home PluginService.List names the plugin directories under),
 * POST /__mock/plugin/demotab?tab=overview|form|log|assistant|shell|stress, GET /__mock/plugin/acts.
 */
function pluginControl(res: ServerResponse, what: string, q: URLSearchParams): void {
  try {
    const name = q.get("name") ?? "hello";
    switch (what) {
      case "POST state": {
        const state = q.get("state") ?? "running";
        if (state !== "running" && state !== "crashed" && state !== "failed") throw new Error(`unknown state ${state}`);
        world.plugins.setState(name, state);
        json(res, 200, { ok: true });
        return;
      }
      case "POST toast":
        json(res, 200, { delivered: world.plugins.toast(name, q.get("text") ?? "") });
        return;
      case "POST invoke": {
        const thread = q.get("thread") ?? "";
        const ctx = thread ? ({ activeThreadId: thread, activeTerminalId: "", activeProjectId: "", activeWorktreePath: "", activeView: "", activeWorkspaceId: "" } as Parameters<typeof world.plugins.invokeAsk>[2]) : undefined;
        json(res, 200, { delivered: world.plugins.invokeAsk(name, q.get("command") ?? "", ctx, {}) });
        return;
      }
      case "POST demotab":
        world.plugins.demoTab(q.get("tab") ?? "overview");
        json(res, 200, { ok: true });
        return;
      case "POST registry":
        if (q.has("error") || !q.has("installError")) world.plugins.registry.error = q.get("error") ?? "";
        if (q.has("installError")) world.plugins.registry.installError = q.get("installError") ?? "";
        json(res, 200, { ok: true });
        return;
      case "POST dirs":
        world.plugins.home = q.get("home") ?? "";
        json(res, 200, { ok: true });
        return;
      case "GET acts":
        json(res, 200, world.plugins.acts);
        return;
    }
    json(res, 404, { error: `no plugin control ${what}` });
  } catch (err) {
    json(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

function control(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): void {
  const thread = /^\/__mock\/thread\/(attention|status|stop|hold|release|focus|archive|snooze|wake|flag|envstale|transcript)$/.exec(path);
  if (req.method === "POST" && thread?.[1]) {
    threadControl(res, thread[1], q);
    return;
  }
  const emberCtl = /^\/__mock\/ember(|\/task|\/task\/add|\/report|\/timer|\/consolidating|\/epoch|\/restart)$/.exec(path);
  if (req.method === "POST" && emberCtl) {
    emberControl(res, emberCtl[1] ?? "", q);
    return;
  }
  const actionCtl = /^\/__mock\/action\/([a-z]+)$/.exec(path);
  if (req.method === "POST" && actionCtl?.[1]) {
    actionControl(res, actionCtl[1], q);
    return;
  }
  const update = /^\/__mock\/update\/([a-z]+)$/.exec(path);
  if (req.method === "POST" && update?.[1]) {
    updateControl(res, update[1], q);
    return;
  }
  const plugin = /^\/__mock\/plugin\/([a-z]+)$/.exec(path);
  if (plugin?.[1]) {
    pluginControl(res, `${req.method ?? ""} ${plugin[1]}`, q);
    return;
  }
  switch (`${req.method ?? ""} ${path}`) {
    case "POST /__mock/terminal/exit":
      try {
        const id = q.get("id") ?? "";
        world.kill(id, Number(q.get("code") ?? 0), q.get("keep") === "1");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/terminal/new":
      if (q.has("delay")) world.terminalNewDelayMs = Number(q.get("delay"));
      if (q.has("fail")) world.terminalNewFail = q.get("fail") ?? "";
      json(res, 200, { delayMs: world.terminalNewDelayMs, fail: world.terminalNewFail });
      break;
    case "POST /__mock/daemon/restart":
      world.restartDaemon();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/threads-service":
      // enabled=false simulates a daemon without Phase 2a: ThreadService 404s and the
      // events stream carries no thread source. Reset turns it back on.
      threadsEnabled = q.get("enabled") !== "false";
      json(res, 200, { enabled: threadsEnabled });
      break;
    case "POST /__mock/missing-rpc":
      for (const rpc of q.getAll("rpc")) missingRpcs.add(rpc);
      json(res, 200, { missing: [...missingRpcs] });
      break;
    case "POST /__mock/gitops":
      // fail=git.push makes that command's next op fail; delay=ms sets how long ops run.
      for (const name of q.getAll("fail")) world.gitops.failNext.add(name);
      if (q.has("delay")) world.gitops.delayMs = Number(q.get("delay"));
      json(res, 200, { fail: [...world.gitops.failNext], delayMs: world.gitops.delayMs });
      break;
    case "POST /__mock/worktree/checkout": {
      // path=…&branch=… (no branch, or empty: detached HEAD).
      const ok = world.checkout(q.get("path") ?? "", q.get("branch") ?? "");
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/worktree/dirty": {
      // path=…&modified=2 (0: clean).
      const ok = world.setDirty(q.get("path") ?? "", Number(q.get("modified") ?? "0"));
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/worktree/operation": {
      // path=…&op=rebase&step=3&total=6&conflicted=2[&file=a.go&file=b.go]; no op: it ends.
      const ok = world.setOperation(q.get("path") ?? "", q.get("op") ?? "", Number(q.get("step") ?? "0"), Number(q.get("total") ?? "0"), Number(q.get("conflicted") ?? "0"), q.getAll("file"));
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/worktree/merged":
      try {
        const w = world.addMergedWorktree(q.get("project") ?? "", q.get("branch") ?? "", q.get("path") ?? "");
        json(res, 200, { path: w.path });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/workspace":
      try {
        const w = world.addWorkspace(q.get("name") ?? "", (q.get("projects") ?? "").split(",").filter(Boolean), {
          root: q.get("root") ?? "",
          primary: q.get("primary") ?? "",
          instructions: q.get("instructions") ?? "",
          skills: (q.get("skills") ?? "").split(",").filter(Boolean),
        });
        json(res, 200, w);
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/project/rename":
      // id=repo-dot&name=workspace: the project's name.
      try {
        const r = world.renameProject(q.get("id") ?? "", q.get("name") ?? "");
        json(res, 200, { id: r.id, name: r.name });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/workspace-thread":
      // workspace=login[&project=repo-gp][&name=driver][&status=busy]: a connected thread owned by the workspace.
      try {
        const s = world.addWorkspaceThread(q.get("workspace") ?? "", q.get("project") ?? "", q.get("name") ?? "driver", statusNames[q.get("status") ?? "idle"] ?? ThreadStatus.IDLE);
        json(res, 200, threadSummary(s.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/workspace-files":
      try {
        const skills = q.get("skills");
        const rootMissing = q.get("rootMissing");
        json(res, 200, world.setWorkspaceFiles(q.get("workspace") ?? "", q.get("instructions") ?? undefined, skills === null ? undefined : skills.split(",").filter(Boolean),
          rootMissing === null ? undefined : rootMissing === "1"));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/project-ids":
      // id=…&projects=repo-cf,repo-gp: the thread's project set (as a later thread new --projects would make it).
      try {
        const t = world.setThreadProjectIds(q.get("id") ?? "", (q.get("projects") ?? "").split(",").filter(Boolean));
        json(res, 200, threadSummary(t.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/set-thread":
      try {
        const s = world.addSetThread({
          projects: (q.get("projects") ?? "").split(",").filter(Boolean),
          project: q.get("project") ?? "",
          workspace: q.get("workspace") ?? "",
          branch: q.get("branch") ?? "",
          name: q.get("name") ?? "set thread",
        });
        json(res, 200, threadSummary(s.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/multi-thread":
      try {
        const s = world.addMultiThread((q.get("projects") ?? "").split(",").filter(Boolean), q.get("project") ?? "", q.get("branch") ?? "feat/multi", q.get("name") ?? "multi", q.get("workspace") ?? "");
        json(res, 200, threadSummary(s.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/link-pr":
      // thread=s-1&slug=owner/name&number=12: a pr-link record; the thread is republished if the URL is new.
      try {
        const id = q.get("thread") ?? "";
        const added = world.linkPullRequest(id, q.get("slug") ?? "", Number(q.get("number") ?? ""), Number(q.get("ago") ?? "0"));
        json(res, 200, { added, ...threadSummary(id) });
      } catch (err) {
        json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/usage":
      // thread=s-2&model=claude-opus-5&requests=3&cacheRead=1000[&input=…&output=…&cacheWrite5m=…&cacheWrite1h=…&day=YYYY-MM-DD]
      try {
        const id = q.get("thread") ?? "";
        const n = (k: string) => Number(q.get(k) ?? "0");
        world.addUsage(id, {
          model: q.get("model") ?? "",
          day: q.get("day") ?? utcDay(0),
          requests: n("requests"),
          input: n("input"),
          output: n("output"),
          cacheRead: n("cacheRead"),
          cacheWrite5m: n("cacheWrite5m"),
          cacheWrite1h: n("cacheWrite1h"),
        });
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread": {
      // state=permission|question|streaming|idle[&id=s-r1]: the sketch's scripted thread.
      const state = (q.get("state") ?? "permission") as ScriptedThreadState;
      if (!THREAD_STATES.includes(state)) {
        json(res, 400, { error: `state must be one of ${THREAD_STATES.join(", ")}` });
        break;
      }
      const s = world.addScriptedThread(state, q.get("id") ?? "s-r1");
      json(res, 200, { id: s.id });
      break;
    }
    case "POST /__mock/thread/agent-end":
      // id=s-r1&run=a1[&status=done|failed]: a subagent run ends (mock/agents.ts).
      try {
        world.logs.endAgent(q.get("id") ?? "s-r1", q.get("run") ?? "", q.get("status") === "failed");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/shell-end":
      // id=s-r1[&status=failed]: the oldest background shell ends (mock/shells.ts).
      try {
        world.logs.endShell(q.get("id") ?? "s-r1", q.get("status") === "failed");
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/mcp-age":
      // id=s-r1&ago=<seconds>: the thread's last MCP check that long ago (mock/mcp.ts ageMcp).
      try {
        ageMcp(world.logs, q.get("id") ?? "s-r1", Number(q.get("ago") ?? "720"));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/cache":
      try {
        world.ageThreadCache(q.get("id") ?? "s-r1", Number(q.get("ago") ?? "3660"), q.has("tokens") ? Number(q.get("tokens")) : undefined, q.get("model") ?? undefined);
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/retry":
      // id=s-r1&in=20&attempt=3&max=10&status=429&error=rate_limit, or clear=1.
      try {
        world.setThreadRetry(
          q.get("id") ?? "s-r1",
          q.has("clear")
            ? null
            : { inSeconds: Number(q.get("in") ?? "20"), attempt: Number(q.get("attempt") ?? "3"), maxRetries: Number(q.get("max") ?? "10"), errorStatus: Number(q.get("status") ?? "429"), error: q.get("error") ?? "rate_limit" },
        );
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/stream":
      world.logs.stream(q.get("id") ?? "s-r1", q.get("text") ?? "");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/thread/delta":
      world.logs.delta(q.get("id") ?? "s-r1", q.get("text") ?? "");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/thread/finish":
      world.logs.finish(q.get("id") ?? "s-r1", {
        rest: q.get("rest") ?? MockThreadLogs.answerRest,
        total: q.has("total") ? Number(q.get("total")) : undefined,
        turnCost: q.has("turnCost") ? Number(q.get("turnCost")) : undefined,
        model: q.get("model") ?? undefined,
      });
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/thread/commands":
      try {
        world.logs.setSlashCommands(q.get("id") ?? "s-r1", slashCommandsFor(q.get("set") ?? "default"));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/fail-respond":
      world.logs.failRespond = q.get("withdrawn") ? "withdrawn" : "error";
      json(res, 200, { ok: true });
      break;
    case "GET /__mock/thread/calls":
      json(res, 200, world.logs.calls);
      break;
    case "POST /__mock/status-kinds":
      json(res, 200, world.addStatusKinds());
      break;
    case "POST /__mock/lineage":
      json(res, 200, world.addLineage());
      break;
    case "POST /__mock/resident":
      json(res, 200, { id: world.addResident() });
      break;
    case "POST /__mock/transcript-deleted":
      json(res, 200, { id: world.addTranscriptDeleted() });
      break;
    case "POST /__mock/empty":
      world.empty();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/threads":
      // project=repo-cf&count=3&status=busy|idle|attention[&prefix=Job]: connected threads in the project's main worktree.
      try {
        const list = world.addThreads(q.get("project") ?? "repo-cf", Number(q.get("count") ?? "1"), statusNames[q.get("status") ?? "busy"] ?? ThreadStatus.BUSY, q.get("prefix") ?? "Thread");
        json(res, 200, list.map((s) => s.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "GET /__mock/workspaces":
      json(res, 200, [...world.workspaces.values()]);
      break;
    case "POST /__mock/thread-new":
      if (q.has("delay")) world.worktreeDelayMs = Number(q.get("delay"));
      json(res, 200, { delayMs: world.worktreeDelayMs });
      break;
    case "GET /__mock/attachments":
      json(res, 200, [...world.attachments].map(([path, a]) => ({ path, ...a })));
      break;
    case "GET /__mock/gitops":
      json(res, 200, world.gitops.summaries());
      break;
    case "GET /__mock/update":
      json(res, 200, updateSummary());
      break;
    case "POST /__mock/gh/update":
      world.gh.update();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/poll":
      world.gh.poll();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/inbox-zero":
      world.gh.inboxZero();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/stale":
      world.gh.stale();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/auth":
      world.gh.authenticated = q.get("ok") !== "false";
      json(res, 200, { authenticated: world.gh.authenticated });
      break;
    case "POST /__mock/gh/branch-pr":
      // slug=o/r&head=b&number=N&title=…&state=open|draft|merged|closed[&ago=ms][&append=1]
      world.gh.setBranchPullRequest(q.get("slug") ?? "", q.get("head") ?? "", Number(q.get("number") ?? "0"), q.get("title") ?? "", q.get("state") ?? "open", Number(q.get("ago") ?? "1200000"), q.get("append") === "1");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/touch":
      json(res, world.gh.touch(q.get("path") ?? "") ? 200 : 404, { ok: true });
      break;
    case "GET /__mock/projects/calls":
      json(res, 200, projectCalls);
      break;
    case "GET /__mock/github/calls":
      json(res, 200, githubCalls);
      break;
    case "GET /__mock/gh/calls":
      json(res, 200, world.gh.calls);
      break;
    case "POST /__mock/gh/pr-fail":
      // command=pr.refresh makes that pull request command's next run fail.
      for (const name of q.getAll("command")) world.gh.prDetails.failNext.add(name);
      json(res, 200, { fail: [...world.gh.prDetails.failNext] });
      break;
    case "POST /__mock/gh/pr-delay":
      world.gh.prDetails.threadDelayMs = Number(q.get("ms") ?? "0");
      json(res, 200, { delayMs: world.gh.prDetails.threadDelayMs });
      break;
    case "POST /__mock/gh/pr-comment": {
      // A poll saw a new comment on a pull request with a detail: pull_request_detail_updated.
      const ok = world.gh.prDetails.addComment(q.get("repo") ?? "alexwaumann/code-foundry", Number(q.get("number") ?? "145"), q.get("body") ?? "New comment");
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/gh/pr-push": {
      // A poll saw a push to a pull request with a detail: its head moves (mock/prDiff.ts).
      const ok = world.gh.prDetails.push(q.get("repo") ?? "alexwaumann/code-foundry", Number(q.get("number") ?? "145"), q.get("sha") ?? "b0b0".padEnd(40, "0"));
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "GET /__mock/streams":
      json(res, 200, Object.fromEntries(openStreams));
      break;
    case "GET /__mock/threads":
      json(res, 200, [...world.threads.keys()].map(threadSummary));
      break;
    case "GET /__mock/ember":
      json(res, 200, world.ember.json());
      break;
    case "GET /__mock/actions":
      json(res, 200, world.actions.json());
      break;
    case "GET /__mock/skills":
      json(res, 200, world.skills.state());
      break;
    case "POST /__mock/skills":
      json(res, 200, world.skills.control(q));
      break;
    case "GET /__mock/memory":
      json(res, 200, world.memory.json());
      break;
    case "POST /__mock/memory":
    case "POST /__mock/memory/add":
      try {
        if (path === "/__mock/memory") json(res, 200, world.memory.control(q));
        else {
          const id = q.get("thread") ?? "";
          json(res, 200, { added: world.memory.add(q.get("text") ?? "", id, world.threads.get(id)?.name ?? "") });
        }
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "GET /__mock/themes":
      json(res, 200, world.themes.json());
      break;
    case "POST /__mock/themes/card":
      try {
        json(res, 200, world.themes.card(q));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/themes/edit":
      try {
        json(res, 200, world.themes.edit(q));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/themes/recolour":
      try {
        json(res, 200, world.themes.recolour(q));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/themes":
      try {
        json(res, 200, world.themes.control(q));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "GET /__mock/invocations":
      json(res, 200, world.invocations);
      break;
    case "GET /__mock/waits":
      json(res, 200, mockWaits());
      break;
    case "GET /__mock/fetches":
      json(res, 200, mockFetches());
      break;
    case "GET /__mock/settings":
      json(res, 200, { raw: world.settings.raw, values: world.settings.values(), loadError: world.settings.loadError });
      break;
    case "POST /__mock/settings/external": {
      const values = Object.fromEntries([...q.entries()].filter(([k]) => k !== "loadError"));
      world.settings.external(values, q.get("loadError"));
      json(res, 200, { raw: world.settings.raw });
      break;
    }
    case "POST /__mock/backdrops/import":
      try {
        // JSON-safe: the proto message carries bigints.
        json(res, 200, { name: world.backdrops.import(q.get("path") ?? "")?.name ?? "" });
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
      break;
    case "GET /__mock/backdrops":
      json(res, 200, { images: world.backdrops.list().map((b) => b.name), calls: world.backdrops.calls });
      break;
    case "GET /__mock/writes":
      json(res, 200, world.writes);
      break;
    case "GET /__mock/resizes":
      json(res, 200, world.resizes);
      break;
    case "POST /__mock/reset":
      threadsEnabled = true;
      missingRpcs.clear();
      world.reset();
      seedScenario();
      resetClones();
      resetProjects();
      resetCompletion();
      mockFiles.reset();
      resetPageStorage();
      resetWaits();
      resetFetches();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/files": {
      const projectId = q.get("project") ?? "";
      if (!world.projects.has(projectId)) {
        json(res, 404, { error: `unknown project ${projectId}` });
        break;
      }
      setMockFiles(projectId, q.getAll("path"));
      json(res, 200, { project: projectId, files: q.getAll("path") });
      break;
    }
    case "POST /__mock/files/search":
      if (q.has("delay")) searchMode.delayMs = Number(q.get("delay"));
      if (q.has("fail")) searchMode.fail = q.get("fail") === "1";
      json(res, 200, searchMode);
      break;
    case "GET /__mock/files/calls":
      json(res, 200, completionCalls);
      break;
    case "POST /__mock/fs/write":
      mockFiles.write(q.get("path") ?? "", q.get("text") ?? "");
      json(res, 200, { ok: true });
      break;
    case "GET /__mock/fs/calls":
      json(res, 200, mockFiles.calls);
      break;
    default:
      json(res, 404, { error: "unknown control endpoint" });
  }
}

const server = createServer((req, res) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Expose-Headers", exposeHeaders);
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Methods": connectCors.allowedMethods.join(", "),
      "Access-Control-Allow-Headers": allowHeaders,
      "Access-Control-Max-Age": "7200",
    });
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://mock");
  if (url.pathname.startsWith("/__mock/")) {
    control(req, res, url.pathname, url.searchParams);
    return;
  }
  if (!threadsEnabled && url.pathname.startsWith("/codefoundry.v1.ThreadService/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 page not found\n");
    return;
  }
  if (missingRpcs.has(url.pathname.replace(/^\/codefoundry\.v1\./, ""))) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 page not found\n");
    return;
  }
  // The frame stylesheet, the bridge script and the page library need no credential, like
  // the daemon's (internal/theme/frame.go, internal/bridge, internal/pagelib).
  if (url.pathname.startsWith("/cf/")) {
    const r = bridgeRoute(url.pathname) ?? themeRoute(url.pathname, url.searchParams.get("scheme")) ?? pagelibRoute(url.pathname);
    res.writeHead(r ? 200 : 404, { "Content-Type": r?.type ?? "text/plain", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" });
    res.end(r?.body ?? "404 page not found\n");
    return;
  }
  // The HTML preview's route authenticates by the grant in its URL, like the daemon's (internal/preview).
  if (url.pathname.startsWith("/preview/")) {
    const e = mockFiles.previewEntry(url.pathname);
    if (!e) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found\n");
      return;
    }
    res.writeHead(200, {
      "Content-Type": e.mime,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      // allow-same-origin as the frame has it (the bridge's storage); the pages listener's
      // origin is not the app's (docs/notes/bridge-2-gui.md).
      "Content-Security-Policy": "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
    });
    // A thread's page is painted in the theme from its first byte, as the daemon does.
    const themed = url.searchParams.get("cf-page") === "1" && e.mime.startsWith("text/html");
    res.end(themed ? mockPaint(new TextDecoder().decode(e.data)) : e.data);
    return;
  }
  if (req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401, { "WWW-Authenticate": "Bearer", "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: "unauthenticated", message: "missing or bad bearer token" }));
    return;
  }
  rpc(req, res);
});

// Streams are long-lived: no request timeout (Node's default would cut them at 5 min).
server.requestTimeout = 0;
server.keepAliveTimeout = 60_000;

server.listen(port, "127.0.0.1", () => {
  world.start();
  const url = `http://127.0.0.1:${String(port)}`;
  console.log(`mock daemon listening on ${url}`);
  console.log(`token: ${token}`);
  console.log(`browser: http://127.0.0.1:9245/?daemon=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`);
});

function shutdown(): void {
  world.stop();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
