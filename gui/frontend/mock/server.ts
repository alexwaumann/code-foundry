/**
 * Mock code-foundry daemon for frontend development and e2e tests.
 *
 *   bun run mock            # http://127.0.0.1:7788, token "dev-mock-token"
 *   MOCK_PORT=7799 MOCK_TOKEN=secret bun run mock
 *
 * Serves Health, Terminal, Project, Filesystem, Gh, Command, Settings, Ui, Thread, Action, GitOps, Update,
 * Plugin, Skill, Memory, Ember, Dictation, Search, Layout and Event over Connect (HTTP/1.1,
 * like the real daemon's loopback listener for browsers), with bearer auth and
 * permissive CORS, and the streams the GUI tunnels over a WebSocket at /stream/ (mock/tunnel.ts).
 * Non-RPC control endpoints for tests live under /__mock/:
 *
 *   GET  /__mock/invocations | writes | threads | streams
 *   GET  /__mock/waits                            (every thread.wait invoked, held until its caller aborts it: mock/bridge.ts)
 *   GET  /__mock/fetches                          (every proxied page fetch: mock/proxyFetch.ts)
 *   POST /__mock/reset
 *   ProjectService.SearchGitHub / LookupGitHub / Clone: mock/clone.ts (a project named "fail" fails
 *        to clone; octo-org/already-here's destination exists)
 *   ProjectService.Create / ListPublishOwners / Publish, project.create, project.github.publish:
 *        mock/create.ts (publishing private to octo-org, or a repository named "taken", fails like gh)
 *   POST /__mock/thread/attention?id=s-1
 *   POST /__mock/thread/status?id=s-1&status=busy|idle|attention[&reason=question: Which color?][&busyTool=Bash make check]
 *        (busyTool: Thread.busy_tool, kept only while busy and not compacting; "" clears it)
 *   POST /__mock/thread/stop?id=s-1&reason=crashed&code=139[&status=busy|idle|attention]   (the process ends: a crash, or reason=idle for the idle stop)
 *        (status: what it was doing at that moment; busy ends as ERROR "interrupted", other
 *        statuses persist, like the daemon)
 *   POST /__mock/status-kinds                     (one thread per status kind: approval, question,
 *        plan, finished, Claude error, busy, idle, interrupted, and a stopped one still asking
 *        a question)
 *   POST /__mock/lineage                          (thread lineage: a creator, the child s-l-child with
 *        six siblings, one archived, and a child of its own; every child out of the
 *        sidebar while its creator exists; World.addLineage)
 *   POST /__mock/shell-sidebar                    (the shell sidebar's rows: asks, a long title, threads without a
 *        project with and without counts: World.addShellSidebar)
 *   POST /__mock/needs-you                        (three threads waiting on real asks: a long command, a question,
 *        a short command without a project: World.addNeedsYou)
 *   POST /__mock/live-count                       (the sidebar's live count: a working thread with background
 *        subagents, a lead "waiting on 2 child threads and 1 subagent" with a nested lead,
 *        one waiting on a shell alone; World.addLiveCount)
 *   POST /__mock/thread/focus?id=s-3     (FocusThread intent, explicit as thread.focus)
 *   GET  /__mock/layout                           ({rev, state, viewport, applied, seeds}: the layout as internal/layout's
 *        JSON, the last SetViewport, every Apply as an op and client id; mock/layout.ts)
 *   POST /__mock/layout?seed=empty|one-thread|thread-and-diff|grid|spaces   (that layout as one commit; or
 *        the body's state, internal/layout's JSON, for any other tree)
 *   POST /__mock/layout/import?imported=0|1&fail=N&error=…&delay=ms   (the first-load import's mark; the
 *        next N ImportLegacy calls fail; each answers after `delay`; GET /__mock/layout lists the calls as `imports`)
 *   POST /__mock/emit   (the body's {"intent": <UiIntent as Connect JSON>} to every window, as a
 *     command emits it; answers {"delivered": <watchers>})
 *   POST /__mock/thread/transcript?id=s-3[&missing=false]   (Claude Code deleted the thread's transcript:
 *     Thread.transcript_missing; stopped and held; thread.send and thread.fork refuse it)
 *   POST /__mock/thread/setup?id=s-1&state=running|fresh|warn|multi|failed|cancelled|done|done-warn[&queued=1]
 *     (Thread.setup: the thread stands where that script of mock/setup.ts leaves it, with no cwd
 *     until it is placed and held, and its timeline is its first message and, for a setup that did
 *     not finish, the synthetic turn end. Scripting another state moves it on, keeping the message,
 *     and watchers get a new snapshot, as for a retry. queued: a message sent during the setup waits there)
 *   POST /__mock/thread/archive?id=s-1[&archived=false]   (thread.archive as the CLI's --yes does it:
 *                                                 closes, removes its shells, unpins, stamps; false unarchives;
 *                                                 child threads go along: World.archiveCascade)
 *   POST /__mock/thread/forget?id=s-l-parent      (forgets that one thread, no cascade: its children's
 *                                                 creator no longer exists, so they join the sidebar)
 *   POST /__mock/thread/snooze?id=s-1&until=2m|<RFC 3339>[&clear=true][&save=true]   (thread.snooze as the CLI's
 *                                                 --yes does it: closes, removes its shells, unpins, unarchives)
 *   POST /__mock/thread/cache?id=s-r1&ago=<seconds>[&tokens=N&model=M]   (a thread's last result that long ago; only tokens: its context, the result's time kept; mock/context.ts)
 *   POST /__mock/thread?state=permission|question|streaming|idle|…   (the scripted thread s-r1:
 *        mock/thread.ts, every state in its THREAD_STATES); POST /__mock/thread/delta?text=… | /__mock/thread/stream?text=… |
 *        /__mock/thread/finish[?total=1.5&turnCost=1.5&model=claude-sonnet-5] (the turn_end's figures) |
 *        /__mock/thread/fail-turn[?subtype=error_max_turns] (the next message's turn ends in error
 *        before any text; default error_during_execution);
 *        /__mock/thread/api-error[?text=…] (the next message's turn ends with Claude Code's API-error
 *        text, api_error set; default "Invalid API key · Fix external API key"); GET /__mock/thread/calls;
 *        /__mock/thread/wake-fire?sub=…, /__mock/thread/wake-status?sub=…&status=… (state=waiting's wake rows: mock/wakes.ts) |
 *        /__mock/thread/mcp-age?id=s-r1&ago=720 (the last MCP check that many seconds ago: mock/mcp.ts) |
 *        /__mock/thread/mcp-servers?id=s-r1&keep=t3-code,github (only those of the six: mock/mcp.ts)
 *   POST /__mock/thread/retry?id=s-r1&in=20&attempt=3&max=10&status=429&error=rate_limit | ?id=…&clear=1
 *        (Claude Code is retrying an API error: Thread.retry; clear ends it)
 *   POST /__mock/thread/flag?id=s-1&plugin=…&name=<display name>&level=attention|error|none&reason=…[&untilSeen=1]
 *        (a plugin's thread/setFlag; none clears it)
 *   POST /__mock/terminal/exit?id=t-s1-shell&code=1[&keep=1]   (the process exits; keep=1: a
 *                                                 shell stays, exited, as if the reaper were late)
 *   POST /__mock/terminal/print?id=t-top   (the request's body as program output on it)
 *   POST /__mock/terminal/flood?id=t-top   (the request's body, a line, printed as fast as `yes`
 *                                                 does until the shell reads ^C)
 *   POST /__mock/terminal/new?delay=700&fail=reason   (terminal.new takes that long; its next run
 *                                                 fails with that reason; reset: at once, no failure)
 *   POST /__mock/terminal/facts?id=t-new-1[&liveCwd=/tmp][&foreground=make dev][&lastCommand=…]
 *                                                (what the process table says of a terminal: its
 *                                                 directory, its foreground job, its last command)
 *   POST /__mock/daemon/restart                   (every shell goes without a removed event and the
 *                                                 event streams end: the GUI reconnects and Lists)
 *   POST /__mock/thread/hold?id=s-1&id=s-5   (the clock stops changing them: s-1 stops flipping
 *        busy/idle, a starting or closing one does not settle; the sidebar order then holds still.
 *        e2e's resetMock holds s-1 and s-5.)
 *   POST /__mock/link-pr?thread=s-1&slug=owner/name&number=12[&ago=<ms>][&up=1]   (Claude linked a pull
 *                                                 request ago ms ago; deduplicated by URL like the daemon;
 *                                                 up=1 copies it up the creator chain)
 *   POST /__mock/thread-new?delay=700            (how long thread.new takes to make a worktree)
 *   POST /__mock/thread-setup?state=failed       (where the next background thread.new stops: mock/setup.ts)
 *   POST /__mock/worktree/dirty?path=…&modified=2   (the worktree has modified files; 0: clean)
 *   POST /__mock/leftovers?project=repo-cf[&clean=1]   ("Worktrees without threads": cf/perf-spike with 3 commits
 *                                                 not in origin/main, cf/old-copy with 4 uncommitted files (merged
 *                                                 otherwise), each with an archived thread, and exp/shaders made outside
 *                                                 the app; clean=1 adds cf/usage-polish, clean and merged: World.addLeftovers)
 *   POST /__mock/workspace?name=login&projects=repo-cf,repo-gp[&root=…&primary=…&instructions=CLAUDE.md&skills=a,b]
 *                                                 (a workspace: a saved project set; nothing on disk changes)
 *   POST /__mock/set-thread?projects=repo-sk,repo-wr[&project=…|workspace][&workspace=…][&branch=feat/x][&name=…]
 *                                                 (a thread over a project set; a branch: worktree mode, none: in place)
 *   thread.new --like and thread.new-like copy a thread's set, branch, workspace and mode; thread.new's
 *   sets and thread.new-like return the collision hints as warnings (mock/projectSets.ts);
 *   thread.workspace sets a thread's workspace reference; thread.project.add and .remove change a
 *   thread's set (its workspace reference goes; a dirty member's removal asks first).
 *   POST /__mock/thread-info?scenario=single|archived|ws9|home|child-server   (the thread info card's fixtures; World.addThreadInfo)
 *   POST /__mock/multi-thread?projects=repo-cf,repo-gp[&project=repo-gp&branch=feat/x&name=multi&workspace=login&createdBy=s-ti-1]
 *                                                 (a worktree-mode thread over several projects, its worktrees made)
 *   POST /__mock/empty                            (a fresh install: no projects, threads or terminals)
 *   POST /__mock/welcome                          (a first run: empty, then s-welcome with no project and its
 *                                                 busy demo child s-welcome-demo; World.addWelcome)
 *   POST /__mock/threads?project=repo-cf&count=3&status=busy|idle|attention[&prefix=Job]
 *   POST /__mock/workspace-thread?workspace=login[&project=repo-gp&name=driver&status=busy]
 *                                                 (a connected thread that references the workspace, its
 *                                                 members as its set, in project's main worktree)
 *   thread.run-in queues a move (pendingWorktreePath) that lands ~2s after the thread is not busy.
 *   thread.move (and ThreadService.Move) takes a thread without a project into a project or a
 *   workspace: pending_move and naming for ~600ms, then renamed and placed (World.moveThread).
 *   POST /__mock/thread/move-fail[?message=…]  (the next moves fail after the wait; no message: they land)
 *   POST /__mock/thread/move-delay?ms=3000     (how long a move takes)
 *   thread.new takes workspace and/or projects (the set; new-worktree makes worktrees on a new
 *   branch), or no-project (a thread in the home directory with no project or workspace).
 *   GET  /__mock/attachments                      (StageAttachment uploads: path, name, type, size, pages)
 *   POST /__mock/attachments/hold?on=true|false   (StageAttachment waits until on=false: a send mid-upload)
 *   FilesystemService.ListSkills / SearchFiles: mock/filesystem.ts (project skills review and
 *        deploy in every project, user skill commit; DEFAULT_FILES in every project)
 *   POST /__mock/files?project=repo-cf&path=a.ts&path=src/b.ts   (that project's files; no path:
 *                                                 none; reset restores DEFAULT_FILES; several
 *                                                 projects: project=a&path=x&project=b&path=y)
 *   GET  /__mock/files/calls                      ("skills <project,…|-> <includeUser>", "search <project,…> <query>")
 *   FilesystemService.ReadFile, WriteFile, PreviewFile (+ GET /preview/<grant>/<path>), ProjectService.GetWorktreeCompareFile: mock/files.ts (code-foundry's README.md,
 *        src/app.ts, docs/preview.html, docs/logo.png, docs/; every detail's changed files)
 *   POST /__mock/compare/files?count=500[&first=10]  (that many more files in every comparison, and that many sorting above them all; reset: none)
 *   POST /__mock/compare/commits?count=800[&subject=N]   (that many more commits on every comparison's list, older than the rest;
 *        subject: N more characters on the newest commit's subject; reset: none)
 *   POST /__mock/fs/write?path=…&text=…[&touch=1] (a file's contents on disk, or touch=1: only its time; reset restores the fixtures)
 *   POST /__mock/fs/link?path=…&real=…            (ReadFile says a link leads from the path to real)
 *   GET  /__mock/fs/text?path=…                   ({ text }: a file's contents, null when absent)
 *   thread.new with a prompt containing FAIL fails (after the worktree delay, if any).
 *   GET  /__mock/settings                          ({ raw, values } of the settings "file")
 *   POST /__mock/settings/external?appearance.font_size=18   (a hand edit; "" deletes a key)
 *   POST /__mock/settings/external?loadError=…               (the file stops parsing)
 *   GET  /__mock/update
 *   POST /__mock/update/latest?version=v0.2.0     (what the next check finds)
 *   POST /__mock/update/fail?reason=…             (the next download fails)
 *        app.restart (Restart Now) and daemon.restart come back as the installed version;
 *        GET /__mock/update counts app.restart runs (restarts)
 *   POST /__mock/gh/inbox-zero                (empties the review queue, leaving the reviews that wait on their authors)
 *   POST /__mock/gh/many-prs?count=150        (every list of the Pull Requests page that many long)
 *   POST /__mock/gh/project-merged-capped[?shown=3&total=64]   (the dashboard's project-wide
 *        merged list shows its first `shown` of `total`: "Showing 3 of 64")
 *   GET  /__mock/gh/calls                         (GhService/GetWorktreeDetail call counts;
 *        "ListReviewerCandidates query" counts the searches)
 *   POST /__mock/gh/pr-fail?command=pr.refresh             (that command's next run fails;
 *        also pr.ask, pr.explain, pr.fix.findings, pr.task (the fork refusal), pr.merge
 *        as a moved head, and pr.review as unconfirmed)
 *   POST /__mock/gh/pr-delay?ms=800          (pr.ask, pr.explain, pr.fix.findings, pr.task, pr.merge, pr.revert, pr.review take 800ms)
 *   POST /__mock/gh/pr-detail-delay?ms=1500  (GetPullRequestDetail takes 1500ms, as with nothing cached; 0: at once)
 *   POST /__mock/gh/pr-comment?repo=o/r&number=145&body=…   (a new comment on a PR detail;
 *        pull_request_detail_updated). PR detail fixtures: mock/prDetail.ts (#145 open,
 *        #138 merged, #131 closed, #140 read-only, #142 mergeable, #146 from a fork, #147 open
 *        with failing checks on no dashboard, #139 awaiting the viewer's review); its commands
 *        are pr.merge, pr.revert, pr.review.request, pr.review, pr.comment and pr.refresh
 *        ("SubmitPullRequestReview" and "AddPullRequestComment" count in /__mock/gh/calls)
 *   POST /__mock/gh/pr-stale?repo=o/r&number=145&ms=800&body=…   (the next read of the detail is a stale
 *        copy, refreshing; the fetch lands ms later, adding body to the description; ms=-1: never)
 *   POST /__mock/gh/dashboard-cold            (GetDashboard as a daemon before its first poll, until
 *        /__mock/gh/dashboard-warm, which answers with the lists and publishes polled)
 *   The pull request Code tab's diff and files: mock/prDiff.ts (one
 *        three-file diff for every pull request, #140's refused as too large; counts
 *        "GetPullRequestDiff", "GetPullRequestDiff refresh", "GetPullRequestFile <path>")
 *   ActionService, the action event source and action.*: mock/actions.ts (repo-cf's six seeded
 *        actions, a-dev000000000 … a-debug0000000; every other project has none). A terminal run
 *        is a kind=action terminal that plays its script and stays EXITED; reset restores the seeds.
 *   POST /__mock/action/setup?thread=s-1&code=1[&action=Install deps]   (a worktree-create
 *                                                 background run for that thread: some output, then
 *                                                 code after ~600 ms; default action: the project's
 *                                                 first on-worktree-create one)
 *   POST /__mock/skills?many=1240   (that many more skills in the marketplace)
 *   POST /__mock/skills?fail=skill.install&error=…   (that skill.* command fails with the message until
 *        cleared with an empty error); registries=none|default (Claude Code without the marketplace);
 *        listError=… (the marketplace list failed); pluginsError=…; epoch=1 (a read, like the hourly
 *        refresh). GET /__mock/skills: { epoch, calls, failures, installed } (mock/skills.ts)
 *   MemoryService, the memory event source and memory.* (mock/memory.ts): four seeded entries (by s-1,
 *        by s-3, from the user's terminal, by the removed s-gone); reset restores them.
 *   POST /__mock/memory?set=empty|seed|long      (the entries, as a hand edit; published; long adds a
 *                                                 700-character entry threads do not get)
 *   POST /__mock/memory?drop=<file>&quiet=1      (a file removed by hand, no event: a stale page)
 *   GET  /__mock/memory                          ({ entries, calls })
 *   The theme event source and theme.show/save/duplicate/delete (mock/userThemes.ts):
 *        three user themes (Ocean Dusk and Mocha, warmer dark, Latte, softer light) and a file that
 *        does not load; reset restores them.
 *   POST /__mock/themes/card?thread=s-1&theme=ocean-dusk[&apply=true]   (theme save from that thread:
 *        its theme card and, applied, the toast)
 *   POST /__mock/themes/recolour?thread=s-1&theme=ocean-dusk&accent=%23e0a060   (that thread's
 *        refinement of the theme: the replaced version kept, a card whose Undo restores it)
 *   EmberService (mock/ember.ts): Ember's status and task board; enabled is the ember.enabled setting
 *        (off by default; turning it on adds s-resident-ember and the worker threads s-ember-notes,
 *        s-ember-wails, s-ember-flaky). Seeded tasks: t-1a2b3c4d doing (s-ember-notes, progress),
 *        t-2b3c4d5e done and t-5e6f7a8b todo (its subtasks), t-9c0d1e2f blocked (s-ember-wails
 *        reported blocked), t-3a4b5c6d done today (s-ember-flaky), t-7e8f9a0b cancelled. Reset restores them.
 *   DictationService and dictation.* (mock/dictation.ts): enabled is dictation.enabled; the model, hardware,
 *        sessions and the microphone are scripted. A session plays levels and two phrases 1 s apart.
 *   POST /__mock/dictation?state=off|no-model|downloading|ready|unloaded|listening|error[&m1=true][&denied=true][&access=none|missing|granted|silent]
 *   POST /__mock/dictation/script?phrases=One.|Two.[&gap=1000][&flush=Tail.][&loadMs=800][&silence=1]
 *   POST /__mock/dictation/end?reason=silence|stopped|disabled|error   (the open session ends)
 *   GET  /__mock/dictation                        ({ state, enabled, downloaded, session, micDenied, calls })
 *   SearchService and search.* (mock/agentSearch.ts): the history and a scripted agent run over the world's
 *        threads (steps, hits, answer, status, stepMs apart).
 *   POST /__mock/search?stepMs=350&fail=1&hits=2&long=1  (the next runs' pace, a FAILED end, a hit cap, a long markdown answer with more hits)
 *   POST /__mock/search/seed                      (a history for Recent searches)
 *   GET  /__mock/search                           ({ entries, calls })
 *   GET  /__mock/ember                            (the board: status and tasks, as JSON)
 *   POST /__mock/ember?enabled=true|false         (sets ember.enabled, as the settings page would)
 *   PluginService and the hello demo plugin (mock/plugins.ts):
 *   POST /__mock/plugin/demotab?tab=overview|form|log|assistant|shell|stress   (the demo shows that tab)
 *   POST /__mock/plugin/terminals?count=N         (the plugin owns terminals t-wall-0..)
 *   GET  /__mock/plugin/acts                      (what the plugin was asked to do, in order)
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Code, ConnectError, cors as connectCors, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import { fromJson, type JsonValue, type MessageInitShape } from "@bufbuild/protobuf";
import { durationFromMs, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { CommandService, ConfirmationRequiredSchema } from "../src/gen/codefoundry/v1/command_pb";
import { SettingsService, SettingsValidationErrorsSchema } from "../src/gen/codefoundry/v1/settings_pb";
import { EventService, EventSource } from "../src/gen/codefoundry/v1/events_pb";
import { FilesystemService } from "../src/gen/codefoundry/v1/filesystem_pb";
import { GhService } from "../src/gen/codefoundry/v1/gh_pb";
import { HealthService } from "../src/gen/codefoundry/v1/health_pb";
import { ProjectService } from "../src/gen/codefoundry/v1/project_pb";
import { ThreadFlagLevel, ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { TerminalService, TerminalState, type AttachEventSchema } from "../src/gen/codefoundry/v1/terminal_pb";
import { ThreadDecision, ThreadService } from "../src/gen/codefoundry/v1/thread_pb";
import { ActionRunMode, ActionRunState, ActionService } from "../src/gen/codefoundry/v1/action_pb";
import { GitOpsService } from "../src/gen/codefoundry/v1/gitops_pb";
import { UiIntentSchema, UiService } from "../src/gen/codefoundry/v1/ui_pb";
import { PluginService } from "../src/gen/codefoundry/v1/plugin_pb";
import { SkillService } from "../src/gen/codefoundry/v1/skill_pb";
import { MemoryService } from "../src/gen/codefoundry/v1/memory_pb";
import { UpdateService, UpdateState } from "../src/gen/codefoundry/v1/update_pb";
import { EmberService } from "../src/gen/codefoundry/v1/ember_pb";
import { DictationService } from "../src/gen/codefoundry/v1/dictation_pb";
import { SearchService } from "../src/gen/codefoundry/v1/search_pb";
import { LayoutService } from "../src/gen/codefoundry/v1/layout_pb";
import { EDITOR_APPS } from "./gitops";
import { groups as settingsGroups, SettingsValidation } from "./settings";
import { type UpdateEventInit } from "./update";
import { MockFiles, WELCOME_PAGE } from "./files";
import { layoutRpcError, opFromProto, SEEDS, tabMsg, type State as LayoutState } from "./layout";
import { frameTag, navigated } from "./frame";
import { insertInHead, mockPaintTag, mockThemeJson, publishMockTheme, resetMockTheme, themeRoute } from "./theme";
import { bridgeRoute, holdWait, mockWaits, resetWaits } from "./bridge";
import { pagelibRoute } from "./pagelib";
import { serveTunnel } from "./tunnel";
import { completionCalls, listDirectories, listSkills, resetCompletion, searchFiles, setMockFiles } from "./filesystem";
import { cloneRepo, lookupGitHub, resetClones, searchGitHub } from "./clone";
import { renameProjectIn } from "./projectRename";
import { createProject, deleteProject, listPublishOwners, publishProject, visibilityFlag } from "./create";
import { ghEvent } from "./github";
import { prDetailCall } from "./prDetail";
import { retiredUsage } from "./usage";
import { ageMcp, keepMcpServers, reconnectMcp, refreshMcp } from "./mcp";
import { pageStorageOf, resetPageStorage, setPageStorage } from "./pageStorage";
import { listPrompts } from "./prompts";
import { listItems, searchThreads } from "./search";
import { mockFetches, mockProxyFetch, resetFetches } from "./proxyFetch";
import { refuseSlashCommand } from "./slashCommands";
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
world.exportDisk = mockFiles;

function rpcError(err: unknown): ConnectError {
  if (err instanceof ConnectError) return err;
  if (err instanceof ConfirmNeeded) {
    return new ConnectError(err.message, Code.FailedPrecondition, undefined, [
      { desc: ConfirmationRequiredSchema, value: { command: err.command, title: err.title, message: err.message, confirmLabel: err.confirmLabel, args: err.args } },
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

/** While set, StageAttachment calls wait here (POST /__mock/attachments/hold?on=true); on=false lets them go. */
let stageHold: (() => void)[] | null = null;

function releaseStageHold(): void {
  const held = stageHold ?? [];
  stageHold = null;
  for (const go of held) go();
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
    version: () => ({ version: "mock", commit: "", goVersion: "", welcomePage: WELCOME_PAGE }),
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
      throw new ConnectError("use the project.worktree.new command in the mock", Code.Unimplemented);
    },
    removeWorktree: () => {
      throw new ConnectError("use the project.worktree.remove command in the mock", Code.Unimplemented);
    },
    refresh: () => ({}),
    listRefs: (req) => guard(() => world.listRefs(req.projectId)),
    cleanupWorktrees: (req) => guard(() => world.cleanupWorktreesMsg(req.project, req.path, req.dryRun)),
    initGit: (req) => guard(() => ({ project: world.projectMsg(world.initGit(req.id)) })),
    rename: (req) =>
      guard(() => {
        const project = world.projects.get(renameProjectIn(world, req.id, req.name).id);
        if (!project) throw new ConnectError("renamed project vanished", Code.Internal);
        return { project: world.projectMsg(project) };
      }),
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
    compareWorktree: (req) => mockFiles.compare(req.path, req.base, req.head),
    getWorktreeCompareFile: (req) => mockFiles.compareFile(req.path, req.base, req.head, req.file, req.oldPath),
    listCompareCommits: (req) => mockFiles.compareCommits(req.path),
    getCompareCommit: (req) => mockFiles.compareCommitBody(req.path, req.sha),
    watch: (_req, ctx) => tracked("ProjectService/Watch", world.projectEvents.subscribe(ctx.signal)),
  });

  router.service(FilesystemService, {
    listDirectories: (req) => {
      const registered = new Set([...world.projects.values()].flatMap((r) => [r.path, ...r.worktrees.map((w) => w.path)]));
      return listDirectories(req.prefix, registered);
    },
    listSkills: (req) => ({ skills: listSkills(world.projects, req.sources, req.includeUser) }),
    searchFiles: (req) => searchFiles(world.projects, req),
    readFile: (req) => mockFiles.readWithLink(req.baseDir, req.path, req.maxBytes),
    writeFile: (req) => mockFiles.writeFile(req),
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
    getPullRequestDetail: (req) => world.gh.prDetails.delayed(() => prDetailCall(() => ({ detail: world.gh.prDetails.get(req.repoSlug, req.number, req.refresh) }))),
    listReviewerCandidates: (req) => prDetailCall(() => world.gh.prDetails.listCandidates(req.repoSlug, req.number, req.query)),
    setReviewRequest: (req) =>
      prDetailCall(() => ({ requested: world.gh.prDetails.setReviewRequest(req.repoSlug, req.number, req.login, req.kind, req.requested) })),
    revertPullRequest: (req) => prDetailCall(() => world.gh.prDetails.revert(req.repoSlug, req.number)),
    mergePullRequest: (req) => prDetailCall(() => world.gh.prDetails.merge(req.repoSlug, req.number, req.method, req.deleteBranch, req.expectedHeadSha)),
    submitPullRequestReview: (req) => prDetailCall(() => world.gh.prDetails.submitReview(req.repoSlug, req.number, req.event, req.body)),
    addPullRequestComment: (req) => prDetailCall(() => world.gh.prDetails.postComment(req.repoSlug, req.number, req.body)),
    setPullRequestDraft: (req) => prDetailCall(() => world.gh.prDetails.setDraft(req.repoSlug, req.number, req.draft)),
    setPullRequestCheckbox: (req) => prDetailCall(() => world.gh.prDetails.setCheckbox(req.repoSlug, req.number, req.index, req.text, req.checked)),
    setPullRequestAutoMerge: (req) =>
      prDetailCall(() => world.gh.prDetails.setAutoMerge(req.repoSlug, req.number, req.enabled, req.enabled ? req.method : 0, req.enabled ? req.expectedHeadSha : "")),
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
  });

  router.service(UiService, {
    watchIntents: (_req, ctx) => tracked("UiService/WatchIntents", world.intents.subscribe(ctx.signal)),
    publishTheme: (req) => {
      try {
        publishMockTheme({ id: req.id, scheme: req.scheme, vars: req.vars });
      } catch (err) {
        throw new ConnectError(err instanceof Error ? err.message : String(err), Code.InvalidArgument);
      }
      return {};
    },
    getTheme: () => mockThemeJson(),
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
    linkPullRequest: (req) =>
      guard(() => {
        const r = world.linkPullRequestByHand(req.id, req.pullRequest);
        return { thread: world.threadMsg(world.thread(req.id)), linked: r.linked, link: { slug: r.link.slug, number: r.link.number, url: r.link.url, linkedAt: timestampFromDate(r.link.linkedAt) } };
      }),
    create: () => {
      throw new ConnectError("use the thread.new command in the mock", Code.Unimplemented);
    },
    fork: () => {
      throw new ConnectError("fork is not mocked", Code.Unimplemented);
    },
    rename: () => {
      throw new ConnectError("use the thread.rename command in the mock", Code.Unimplemented);
    },
    remove: () => {
      throw new ConnectError("use the thread.remove command in the mock", Code.Unimplemented);
    },
    // ThreadService.Move: the thread.move command's World.moveThread, from the request's fields.
    move: async (req) => {
      try {
        const args: Record<string, string> = {};
        if (req.projectId) args.project = req.projectId;
        if (req.workspaceId) args.workspace = req.workspaceId;
        if (req.worktreePath) args.worktree = req.worktreePath;
        if (req.newWorktree) {
          args["new-worktree"] = "true";
          if (req.newWorktree.baseRef) args.base = req.newWorktree.baseRef;
          if (req.newWorktree.branch) args.branch = req.newWorktree.branch;
        } else if (req.checkoutMode) args["new-worktree"] = "false";
        const s = world.thread(req.id);
        await world.moveThread(s, args);
        return { thread: world.threadMsg(s) };
      } catch (err) {
        throw rpcError(err);
      }
    },
    stageAttachment: async (req) => {
      // Held (POST /__mock/attachments/hold): the upload waits until it is let go.
      const held = stageHold;
      if (held) await new Promise<void>((r) => held.push(r));
      return guard(() => ({ path: req.path ? world.stageAttachmentPath(req.path, req.pages) : world.stageAttachment(req.name, req.mimeType, req.data, req.pages) }));
    },
    // The scripted thread's image (mock/thread.ts); a staged PDF reads back as its bytes, a
    // staged image as that same PNG.
    readAttachment: (req) => {
      const pdf = world.attachmentBytes.get(req.path);
      if (pdf) return { data: pdf, mimeType: "application/pdf" };
      if (req.path === MOCK_ATTACHMENT || world.attachments.has(req.path)) return { data: new Uint8Array(MOCK_ATTACHMENT_PNG), mimeType: "image/png" };
      throw new ConnectError(`attachment ${req.path} not found`, Code.NotFound);
    },
    checkPlacement: (req) => world.checkPlacement(req.projectIds, req.branch, req.checkoutMode),
    // The conversation (mock/thread.ts). The GUI goes through the thread.* commands for
    // Send / Interrupt / Respond / SetModel / SetPermissionMode / SetEffort; these serve the RPCs themselves.
    // A page with a query (thread read, the Find dialog's preview; mock/search.ts).
    listItems: (req) => guard(() => listItems(world, req)),
    // ThreadService.Search: thread names and messages (mock/search.ts).
    search: (req) => guard(() => searchThreads(world, req)),
    // ThreadService.ListPrompts: the user's sent prompts (mock/prompts.ts).
    listPrompts: (req) => guard(() => listPrompts(world, req)),
    listSubscriptions: (req) => guard(() => ({ subscriptions: world.logs.listWakes(req.subscriberThreadId) })),
    watchThread: (req, ctx) => tracked("ThreadService/WatchThread", guard(() => world.logs.watch(req.threadId, ctx.signal))),
    send: (req) => guard(() => (refuseSlashCommand(req.text, (name) => world.logs.offersSlashCommand(req.threadId, name)), { item: world.logs.send(req.threadId, req.text, req.attachments, req.composerText) })),
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
    lastRun: (req) => world.actions.lastRun(req.projectId, req.threadId),
    waitRun: async (req, ctx) => {
      try {
        return { run: await world.actions.waitRun(req.runId, ctx.signal) };
      } catch (err) {
        throw rpcError(err);
      }
    },
  });

  // GitOpsService: the GUI runs git operations through the git.*/worktree.* commands
  // (mock/gitops.ts); only the editor app list and the app icons are direct reads.
  router.service(GitOpsService, {
    listEditorApps: () => ({ apps: EDITOR_APPS }),
    // No real app artwork in the mock: every icon is absent, so views show their fallbacks.
    listAppIcons: () => ({ icons: [] }),
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
    listSecrets: (req) => guard(() => ({ secrets: world.plugins.listSecrets(req.name) })),
    deleteSecret: (req) => guard(() => (world.plugins.deleteSecret(req.name, req.key), {})),
    reload: () => ({}),
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
  });

  // The app memory (mock/memory.ts): reads only; writes are the memory.* commands.
  router.service(MemoryService, {
    get: () => ({ memory: world.memory.snapshot() }),
  });

  // Ember (mock/ember.ts): reads only; the board changes through the /__mock/ember controls.
  router.service(EmberService, {
    watchBoard: (_req, ctx) => tracked("EmberService/WatchBoard", world.ember.watch(ctx.signal)),
  });

  // Dictation (mock/dictation.ts): the snapshot, scripted sessions, and the model's download.
  router.service(DictationService, {
    watch: (_req, ctx) => tracked("DictationService/Watch", world.dictation.watch(ctx.signal)),
    download: () => guard(() => ({ snapshot: world.dictation.startDownload() })),
    cancelDownload: () => ({ snapshot: world.dictation.cancelDownload() }),
    removeModel: () => ({ snapshot: world.dictation.removeModel() }),
    start: async (req, ctx) => {
      try {
        return { sessionId: await world.dictation.start(req.clientId, ctx.signal) };
      } catch (err) {
        throw rpcError(err);
      }
    },
    stop: (req) => (world.dictation.stop(req.sessionId, req.flush), {}),
    session: (req, ctx) => tracked("DictationService/Session", guardStream(() => world.dictation.sessionEvents(req.sessionId, ctx.signal))),
    // The host's microphone stream: the mock has no host, so frames are read and dropped.
    audio: async (frames) => {
      const it = frames[Symbol.asyncIterator]();
      while (!(await it.next()).done) {
        // dropped
      }
      return {};
    },
    micDenied: (req) => (world.dictation.setMicDenied(req.denied), {}),
    // The host's report: the mock has no host; POST /__mock/dictation?access= stands in.
    accessibility: () => ({}),
    inputs: () => ({}),
    composerTarget: (req) => (world.dictation.setComposerTarget(req.available), {}),
  });

  // Agent search and the history (mock/agentSearch.ts).
  router.service(SearchService, {
    startAgent: (req) => guard(() => ({ entry: world.searches.startAgent(req.question) })),
    watch: (req, ctx) => tracked("SearchService/Watch", guardStream(() => world.searches.watch(req.id, ctx.signal))),
    watchRecent: (_req, ctx) => tracked("SearchService/WatchRecent", world.searches.watchRecent(ctx.signal)),
    stop: (req) => guard(() => ({ entry: world.searches.stop(req.id) })),
    listRecent: () => ({ entries: world.searches.list() }),
    get: (req) => guard(() => ({ entry: world.searches.getMsg(req.id) })),
    openHit: (req) => guard(() => ({ entry: world.searches.openHit(req.id, req.n) })),
    markSeen: (req) => guard(() => ({ entry: world.searches.markSeen(req.id) })),
    recordFind: (req) => guard(() => ({ entry: world.searches.recordFind(req.query, req.hits) })),
    forget: (req) => (world.searches.forget(req.id), {}),
    clear: () => ({ removed: world.searches.clear() }),
    promote: (req) => guard(() => ({ threadId: world.searches.promote(req.id) })),
    report: () => {
      throw new ConnectError("the mock's agent search reports its own hits", Code.Unimplemented);
    },
  });

  // The window shell's layout (mock/layout.ts): Go's mechanical ops, simplified thread ops.
  router.service(LayoutService, {
    get: () => ({ layout: world.layout.get() }),
    apply: (req) => {
      try {
        const { rev, result } = world.layout.apply(opFromProto(req.op), req.clientId);
        return { rev: BigInt(rev), spaceId: result.space ?? "", paneId: result.pane ?? "", tabId: result.tab ?? "", existing: result.existing ?? false, closed: (result.closed ?? []).map(tabMsg), rule: result.rule ?? "", draftId: result.draft ?? "" };
      } catch (err) {
        throw layoutRpcError(err);
      }
    },
    setViewport: (req) => {
      try {
        world.layout.setViewport(req.clientId, req.width, req.height);
        return {};
      } catch (err) {
        throw layoutRpcError(err);
      }
    },
    importLegacy: async (req) => {
      if (world.layout.importDelayMs > 0) await new Promise((r) => setTimeout(r, world.layout.importDelayMs));
      try {
        return world.layout.importLegacy(req.panelJson, req.bottomJson, req.clientId);
      } catch (err) {
        throw layoutRpcError(err);
      }
    },
  });

  router.service(EventService, {
    // The real daemon paces GitHub polling by it; the mock has nothing to pace.
    setClientState: () => ({}),
    // Snapshots first in the order events.proto promises (project, workspace, terminal,
    // thread, gh, gitops, theme, settings, update, action, plugin, skill, memory, search, layout), then everything published, filtered by `sources`.
    watch: (req, ctx) => {
      const want = new Set(
        req.sources.length > 0
          ? req.sources
          : [EventSource.PROJECT, EventSource.WORKSPACE, EventSource.TERMINAL, EventSource.THREAD_LIST, EventSource.THREAD, EventSource.GH, EventSource.GITOPS, EventSource.THEME, EventSource.SETTINGS, EventSource.UPDATE, EventSource.UI, EventSource.ACTION, EventSource.PLUGIN, EventSource.SKILL, EventSource.MEMORY, EventSource.SEARCH, EventSource.LAYOUT],
      );
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
        { source: EventSource.SEARCH, event: { event: { case: "search", value: world.searches.activity() } } },
        { source: EventSource.LAYOUT, event: { event: { case: "layout", value: world.layout.snapshotEvent() } } },
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

/** Action controls: POST /__mock/action/setup. */
function actionControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  try {
    if (action !== "setup") {
      json(res, 404, { error: "unknown action control" });
      return;
    }
    const run = world.actions.setupRun(q.get("thread") ?? "", Number(q.get("code") ?? "1"), q.get("action") ?? "");
    json(res, 200, { id: run.id, terminalId: run.terminalId, state: ActionRunState[run.state ?? 0], mode: ActionRunMode[run.mode ?? 0], exitCode: run.exitCode, output: run.output, ports: run.ports ?? [] });
  } catch (err) {
    json(res, err instanceof CommandError && err.kind === "notfound" ? 404 : 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Ember control: POST /__mock/ember?enabled=true|false. */
function emberControl(res: ServerResponse, q: URLSearchParams): void {
  const v = q.get("enabled");
  if (v !== "true" && v !== "false") {
    json(res, 400, { error: "enabled must be true or false" });
    return;
  }
  world.settings.update({ "ember.enabled": v });
  json(res, 200, world.ember.json());
}

async function* updateEvents(src: AsyncGenerator<{ source: EventSource; event: EventInit }>): AsyncGenerator<UpdateEventInit> {
  for await (const { source, event } of src) {
    if (source === EventSource.UPDATE && event.event?.case === "update") yield event.event.value;
  }
}

/** Update controls: POST /__mock/update/{latest|fail}. */
function updateControl(res: ServerResponse, action: string, q: URLSearchParams): void {
  const u = world.update;
  switch (action) {
    case "latest":
      u.latest = q.get("version") ?? "v0.2.0";
      break;
    case "fail":
      u.failNext = q.get("reason") ?? "installer: exit status 1: error: checksum mismatch";
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

/** Long-lived streams currently open, by RPC, for GET /__mock/streams (stream count tests). */
const openStreams = new Map<string, number>();

function bump(name: string, by: number): void {
  const n = (openStreams.get(name) ?? 0) + by;
  if (n > 0) openStreams.set(name, n);
  else openStreams.delete(name);
}

/** A stream whose first step may throw a command error: mapped to its Connect code, like guard. */
async function* guardStream<T>(open: () => AsyncGenerator<T>): AsyncGenerator<T> {
  try {
    yield* open();
  } catch (err) {
    throw rpcError(err);
  }
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
    savedAt: s.savedAt?.toISOString() ?? null,
    linkedPullRequests: s.linkedPullRequests.map((l) => ({ slug: l.slug, number: l.number, url: l.url })),
    flags: s.flags.map((f) => ({ plugin: f.plugin, level: ThreadFlagLevel[f.level], reason: f.reason, untilSeen: f.untilSeen })),
  };
}

const statusNames: Record<string, ThreadStatus> = { busy: ThreadStatus.BUSY, idle: ThreadStatus.IDLE, attention: ThreadStatus.NEEDS_ATTENTION };
const flagLevels: Record<string, ThreadFlagLevel | null> = { attention: ThreadFlagLevel.ATTENTION, error: ThreadFlagLevel.ERROR, none: null };

/**
 * Thread controls: POST /__mock/thread/{attention|status|stop|hold|focus|archive|forget|snooze|flag|transcript|setup|move-fail|move-delay}?id=…[&status=…][&reason=…&code=…].
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
        world.setThreadStatus(id, status, q.get("reason") ?? undefined, q.get("busyTool") ?? undefined);
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
        for (const each of q.getAll("id")) world.holdThread(each, true);
        break;
      case "focus":
        json(res, 200, { delivered: world.focusThread(id, true) });
        return;
      case "archive":
        world.archiveThread(id, q.get("archived") !== "false");
        break;
      case "move-fail":
        // thread.move fails after its wait with this message (a refused set_cwd); none: it lands.
        world.moveFail = q.get("message");
        json(res, 200, { moveFail: world.moveFail });
        return;
      case "move-delay":
        world.moveDelayMs = Number(q.get("ms") ?? 600);
        json(res, 200, { moveDelayMs: world.moveDelayMs });
        return;
      case "forget":
        world.forgetThread(id);
        // Gone: no summary to answer with.
        json(res, 200, { forgotten: id });
        return;
      case "snooze":
        if (q.get("save") === "true") world.saveThread(id);
        else world.snoozeThread(id, snoozeUntil({ until: q.get("until") ?? "", clear: q.get("clear") ?? "" }));
        break;
      case "transcript":
        world.setTranscriptMissing(id, q.get("missing") !== "false");
        break;
      case "setup":
        world.scriptSetup(id, q.get("state") ?? "running", q.get("queued") === "1");
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
 * Plugin controls: POST /__mock/plugin/demotab?tab=overview|form|log|assistant|shell|stress,
 * POST /__mock/plugin/terminals?count=N, GET /__mock/plugin/acts.
 */
function pluginControl(res: ServerResponse, what: string, q: URLSearchParams): void {
  try {
    switch (what) {
      case "POST demotab":
        world.plugins.demoTab(q.get("tab") ?? "overview");
        json(res, 200, { ok: true });
        return;
      case "POST terminals":
        world.addWallTerminals(Number(q.get("count") ?? "0"));
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
  const thread = /^\/__mock\/thread\/(attention|status|stop|hold|focus|archive|forget|snooze|flag|transcript|setup|move-fail|move-delay)$/.exec(path);
  if (req.method === "POST" && thread?.[1]) {
    threadControl(res, thread[1], q);
    return;
  }
  if (req.method === "POST" && path === "/__mock/ember") {
    emberControl(res, q);
    return;
  }
  const actionCtl = /^\/__mock\/action\/([a-z]+)$/.exec(path);
  if (req.method === "POST" && actionCtl?.[1]) {
    actionControl(res, actionCtl[1], q);
    return;
  }
  const searchCtl = /^\/__mock\/search(|\/seed)$/.exec(path);
  if (searchCtl) {
    if (req.method === "GET" && searchCtl[1] === "") json(res, 200, world.searches.json());
    else if (req.method === "POST") json(res, 200, searchCtl[1] === "/seed" ? world.searches.seed() : world.searches.control(q));
    else json(res, 405, { error: "method" });
    return;
  }
  const dictation = /^\/__mock\/dictation(|\/script|\/end)$/.exec(path);
  if (dictation) {
    const which = dictation[1];
    if (req.method === "GET" && which === "") json(res, 200, world.dictation.json());
    else if (req.method === "POST") json(res, 200, which === "/script" ? world.dictation.scriptControl(q) : which === "/end" ? world.dictation.endControl(q) : world.dictation.control(q));
    else json(res, 405, { error: "method" });
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
    case "GET /__mock/layout":
      json(res, 200, { rev: world.layout.rev, state: world.layout.state(), viewport: world.layout.viewport, applied: world.layout.applied, seeds: Object.keys(SEEDS), legacyImported: world.layout.legacyImported, imports: world.layout.imports });
      break;
    case "POST /__mock/layout/import":
      // The first-load import: ?imported=0|1 sets the mark; ?fail=N makes the next N calls fail (with ?error=…).
      if (q.has("imported")) world.layout.legacyImported = q.get("imported") === "1";
      if (q.has("fail")) {
        world.layout.failImports = Number(q.get("fail") ?? 0);
        world.layout.importError = q.get("error") ?? "";
      }
      if (q.has("delay")) world.layout.importDelayMs = Number(q.get("delay") ?? 0);
      json(res, 200, { legacyImported: world.layout.legacyImported, imports: world.layout.imports });
      break;
    case "POST /__mock/layout": {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8").trim();
          world.layout.seed(text ? (JSON.parse(text) as LayoutState) : (q.get("seed") ?? "empty"));
          json(res, 200, { rev: world.layout.rev, state: world.layout.state() });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
    }
    case "POST /__mock/emit": {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { intent?: JsonValue };
          json(res, 200, { delivered: world.emit(fromJson(UiIntentSchema, body.intent ?? {})) });
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
    }
    case "POST /__mock/terminal/print":
    case "POST /__mock/terminal/flood": {
      const flood = path.endsWith("/flood");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (flood) world.flood(q.get("id") ?? "", text);
          else world.print(q.get("id") ?? "", text);
          json(res, 200, { ok: true });
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      break;
    }
    case "POST /__mock/terminal/facts":
      try {
        const facts: { liveCwd?: string; foreground?: string; lastCommand?: string } = {};
        for (const k of ["liveCwd", "foreground", "lastCommand"] as const) {
          const v = q.get(k);
          if (v !== null) facts[k] = v;
        }
        world.setTerminalFacts(q.get("id") ?? "", facts);
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
    case "POST /__mock/worktree/dirty": {
      // path=…&modified=2 (0: clean).
      const ok = world.setDirty(q.get("path") ?? "", Number(q.get("modified") ?? "0"));
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/leftovers":
      try {
        json(res, 200, { paths: world.addLeftovers(q.get("project") ?? "repo-cf", q.get("clean") === "1") });
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
    case "POST /__mock/workspace-thread":
      // workspace=login[&project=repo-gp][&name=driver][&status=busy]: a connected thread owned by the workspace.
      try {
        const s = world.addWorkspaceThread(q.get("workspace") ?? "", q.get("project") ?? "", q.get("name") ?? "driver", statusNames[q.get("status") ?? "idle"] ?? ThreadStatus.IDLE);
        json(res, 200, threadSummary(s.id));
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
    case "POST /__mock/thread-info":
      // scenario=single|archived|ws9|busy|child|nogit|unnamed|home|servers|child-server: the thread info card's fixtures (World.addThreadInfo).
      try {
        json(res, 200, { id: world.addThreadInfo(q.get("scenario") ?? "single") });
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/multi-thread":
      try {
        const s = world.addMultiThread((q.get("projects") ?? "").split(",").filter(Boolean), q.get("project") ?? "", q.get("branch") ?? "feat/multi", q.get("name") ?? "multi", q.get("workspace") ?? "", "", q.get("createdBy") ?? "");
        json(res, 200, threadSummary(s.id));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/link-pr":
      // thread=s-1&slug=owner/name&number=12: a pr-link record; the thread is republished if the URL is new.
      // up=1 copies it up the creator chain (child copies with via, as the daemon).
      try {
        const id = q.get("thread") ?? "";
        const added = world.linkPullRequest(id, q.get("slug") ?? "", Number(q.get("number") ?? ""), Number(q.get("ago") ?? "0"), q.get("up") === "1");
        json(res, 200, { added, ...threadSummary(id) });
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
    case "POST /__mock/thread/wake-fire":
      // sub=sub-pr: a one-shot fires, so its row goes (mock/wakes.ts).
      json(res, world.logs.removeWake(q.get("sub") ?? "") ? 200 : 404, { ok: true });
      break;
    case "POST /__mock/thread/wake-status":
      // id=s-r1&sub=sub-pr&status=…: a target's status changes (mock/wakes.ts).
      world.logs.setWakeStatus(q.get("id") ?? "s-r1", q.get("sub") ?? "", q.get("status") ?? "");
      json(res, 200, { ok: true });
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
    case "POST /__mock/thread/mcp-servers":
      // id=s-r1&keep=a,b: the thread's MCP servers become those of the fixture's six (mock/mcp.ts keepMcpServers).
      try {
        keepMcpServers(world.logs, q.get("id") ?? "s-r1", (q.get("keep") ?? "").split(",").filter((n) => n !== ""));
        json(res, 200, { ok: true });
      } catch (err) {
        json(res, 404, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/thread/cache":
      try {
        world.ageThreadCache(q.get("id") ?? "s-r1", q.has("ago") || !q.has("tokens") ? Number(q.get("ago") ?? "3660") : undefined, q.has("tokens") ? Number(q.get("tokens")) : undefined, q.get("model") ?? undefined);
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
    case "POST /__mock/thread/fail-turn":
      world.logs.failTurn = q.get("subtype") || "error_during_execution";
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/thread/api-error":
      world.logs.apiError = q.get("text") || "Invalid API key · Fix external API key";
      json(res, 200, { ok: true });
      break;
    case "GET /__mock/thread/calls":
      json(res, 200, world.logs.calls);
      break;
    case "POST /__mock/status-kinds":
      json(res, 200, world.addStatusKinds());
      break;
    case "POST /__mock/shell-sidebar":
      json(res, 200, world.addShellSidebar());
      break;
    case "POST /__mock/needs-you":
      json(res, 200, world.addNeedsYou());
      break;
    case "POST /__mock/live-count":
      json(res, 200, world.addLiveCount());
      break;
    case "POST /__mock/lineage":
      json(res, 200, world.addLineage());
      break;
    case "POST /__mock/welcome":
      json(res, 200, world.addWelcome());
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
    case "POST /__mock/thread-setup":
      world.nextSetup = q.get("state") ?? world.nextSetup;
      json(res, 200, { nextSetup: world.nextSetup });
      break;
    case "POST /__mock/thread-new":
      if (q.has("delay")) world.worktreeDelayMs = Number(q.get("delay"));
      json(res, 200, { delayMs: world.worktreeDelayMs });
      break;
    case "GET /__mock/attachments":
      json(res, 200, [...world.attachments].map(([path, a]) => ({ path, ...a })));
      break;
    case "POST /__mock/attachments/hold":
      if (q.get("on") === "false") releaseStageHold();
      else stageHold ??= [];
      json(res, 200, { held: stageHold !== null });
      break;
    case "GET /__mock/update":
      json(res, 200, updateSummary());
      break;
    case "POST /__mock/gh/inbox-zero":
      world.gh.inboxZero();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/many-prs":
      world.gh.manyPrs(Number(q.get("count") ?? "150"));
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/project-merged-capped":
      world.gh.capProjectMerged(Number(q.get("shown") ?? "3"), Number(q.get("total") ?? "64"));
      json(res, 200, { ok: true });
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
    case "POST /__mock/gh/pr-detail-delay":
      world.gh.prDetails.readDelayMs = Number(q.get("ms") ?? "0");
      json(res, 200, { delayMs: world.gh.prDetails.readDelayMs });
      break;
    case "POST /__mock/gh/pr-comment": {
      // A poll saw a new comment on a pull request with a detail: pull_request_detail_updated.
      const ok = world.gh.prDetails.addComment(q.get("repo") ?? "alexwaumann/code-foundry", Number(q.get("number") ?? "145"), q.get("body") ?? "New comment");
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/gh/pr-stale": {
      const ok = world.gh.prDetails.markStale(q.get("repo") ?? "alexwaumann/code-foundry", Number(q.get("number") ?? "145"), Number(q.get("ms") ?? "500"), q.get("body") ?? "");
      json(res, ok ? 200 : 404, { ok });
      break;
    }
    case "POST /__mock/gh/dashboard-cold":
      world.gh.setCold(true);
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/gh/dashboard-warm":
      world.gh.setCold(false);
      json(res, 200, { ok: true });
      break;
    case "GET /__mock/streams":
      json(res, 200, Object.fromEntries(openStreams));
      break;
    case "GET /__mock/threads":
      json(res, 200, [...world.threads.keys()].map(threadSummary));
      break;
    case "GET /__mock/ember":
      json(res, 200, world.ember.json());
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
      try {
        json(res, 200, world.memory.control(q));
      } catch (err) {
        json(res, 400, { error: err instanceof Error ? err.message : String(err) });
      }
      break;
    case "POST /__mock/themes/card":
      try {
        json(res, 200, world.themes.card(q));
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
    case "GET /__mock/writes":
      json(res, 200, world.writes);
      break;
    case "POST /__mock/reset":
      releaseStageHold();
      world.reset();
      resetClones();
      resetCompletion();
      mockFiles.reset();
      resetPageStorage();
      resetWaits();
      resetFetches();
      resetMockTheme();
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/files": {
      // Each project= starts a group; the path= after it are that project's files.
      const groups: { project: string; files: string[] }[] = [];
      for (const [k, v] of q) {
        if (k === "project") groups.push({ project: v, files: [] });
        else if (k === "path") groups.at(-1)?.files.push(v);
      }
      const unknown = groups.find((g) => !world.projects.has(g.project)) ?? (groups.length === 0 ? { project: "" } : undefined);
      if (unknown) {
        json(res, 404, { error: `unknown project ${unknown.project}` });
        break;
      }
      for (const g of groups) setMockFiles(g.project, g.files);
      json(res, 200, groups.length === 1 ? groups[0] : { projects: groups });
      break;
    }
    case "GET /__mock/files/calls":
      json(res, 200, completionCalls);
      break;
    case "POST /__mock/compare/files":
      mockFiles.extraCompareFiles = Number(q.get("count") ?? "0");
      mockFiles.firstCompareFiles = Number(q.get("first") ?? "0");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/compare/commits":
      mockFiles.extraCompareCommits = Number(q.get("count") ?? "0");
      mockFiles.longCommitSubject = Number(q.get("subject") ?? "0");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/fs/write":
      mockFiles.write(q.get("path") ?? "", q.get("text") ?? "", q.get("touch") === "1");
      json(res, 200, { ok: true });
      break;
    case "POST /__mock/fs/link":
      mockFiles.links.set(q.get("path") ?? "", q.get("real") ?? "");
      json(res, 200, { ok: true });
      break;
    case "GET /__mock/fs/text":
      json(res, 200, { text: mockFiles.textOf(q.get("path") ?? "") });
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
    // A thread's page is painted in the theme from its first byte, and a document a frame
    // navigates to gets the frame's script, as the daemon does.
    const html = e.mime.startsWith("text/html");
    const themed = html && url.searchParams.get("cf-page") === "1";
    const dest = req.headers["sec-fetch-dest"];
    const tag = (themed ? mockPaintTag() : "") + (html && navigated(typeof dest === "string" ? dest : undefined, themed) ? frameTag : "");
    res.end(tag ? insertInHead(new TextDecoder().decode(e.data), tag) : e.data);
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

const dropTunnels = serveTunnel(server, port);

server.listen(port, "127.0.0.1", () => {
  world.start();
  const url = `http://127.0.0.1:${String(port)}`;
  console.log(`mock daemon listening on ${url}`);
  console.log(`token: ${token}`);
  console.log(`browser: http://127.0.0.1:9245/?daemon=${encodeURIComponent(url)}&token=${encodeURIComponent(token)}`);
});

function shutdown(): void {
  world.stop();
  // Upgraded sockets have left the server's connection list, and close() would wait for them.
  dropTunnels();
  server.closeAllConnections();
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
