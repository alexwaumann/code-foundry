# Live e2e suite (2026-11-11)

The opt-in Playwright specs in `gui/frontend/e2e/live*.spec.ts` drive the GUI against a REAL
daemon, real Claude Code and, for a few, the real `gh`. They are not part of `make check` or
`make gui-e2e` (the mock config ignores them), so nothing kept them current and they had
rotted. This pass repaired every spec whose flow still exists, deleted the tests of a page
that is gone, moved the helpers they copied from each other into `e2e/live.ts`, and wrote
down how to run them (below; the config's header and every spec's header point here).

## How to run it

Needs: `make build` (the specs call `bin/code-foundry`), `claude` logged in (threads use your
account and write transcripts under `~/.claude/projects/`), WebKit installed for Playwright,
and `gh` logged in for the specs marked gh below. Everything runs on a scratch home and
scratch projects under `~/cf-live-scratch`; never on `~/.code-foundry` (`requireLive` refuses
it) and never in a real repository.

```bash
# 1. Scratch projects under ~ (projects must be under home): two git repos, a skill, a plain folder.
S=~/cf-live-scratch; mkdir -p $S/plain $S/home
for p in alpha beta; do mkdir -p $S/$p && (cd $S/$p && git init -q -b main &&
  printf '# %s live fixture\n' $p > README.md && git add . && git -c user.name=live -c user.email=live@example.invalid commit -qm init); done
mkdir -p $S/alpha/.claude/skills/demo && printf -- '---\nname: demo\ndescription: Live e2e demo skill.\n---\n\nReply with the single word skillran and stop. Use no tools.\n' > $S/alpha/.claude/skills/demo/SKILL.md

# 2. A scratch daemon + Vite in the background (the home under ~: new projects and clones land in <home>/projects).
DRIVE_HOME=$S/home make drive DAEMON=dev

# 3. In another shell: register the fixtures, make threads cheap.
cd gui/frontend && . .playwright/drive.env     # exports CODE_FOUNDRY_HOME etc. for the scratch daemon
B=../../bin/code-foundry
$B project add --path $S/alpha; $B project add --path $S/beta; $B workspace new demo --projects alpha,beta
$B settings set threads.default_model 'claude-haiku-5-5[1m]'; $B settings set models.utility 'claude-haiku-5-5[1m]'

# 4. One spec at a time.
LIVE_DAEMON=1 bun run e2e:live e2e/live.spec.ts
```

`playwright.live.config.ts` reads the Vite port from `.playwright/drive.env` (or
`LIVE_APP_URL`); `openApp` (e2e/live.ts) adds the daemon's port and token from
`CODE_FOUNDRY_HOME` as the dev-only `?daemon=&token=` query. `LIVE_SHOTS=<dir>` saves the
specs' screenshots. Stop the `make drive` task when done, and delete `~/cf-live-scratch`.

Cost: every thread uses `LIVE_MODEL` (default `claude-haiku-5-5[1m]`, the cheapest model the
app offers that also runs off Bedrock; `claude-4.5-haiku[1m]` fails there) at medium effort
with one-line prompts, except `live-stall`, whose default prompt is a long turn (pass a short
`LIVE_STALL_PROMPT`). Running every spec once starts about 11 threads and spends about 11 short
turns, plus the daemon's naming jobs on `models.utility`.

## The specs

| Spec | Covers | Needs | Turns |
|---|---|---|---|
| `live.spec.ts` | CLI-made thread listed idle; selecting it focuses the prompt; a watched turn ends idle (never "finished"); an unwatched one needs attention until viewed (window title count); an archived thread opened from Archived keeps its composer and a message continues it; cmd+n picker → composer, model families; `thread focus` selects it | a project | 3 |
| `live-addproject` | Add Project's GitHub tab: search, look up by URL, clone with streamed progress, the project page opens | gh, `LIVE_CLONE_REPO` (a public repo that is not yours, e.g. `octocat/Hello-World`; cloned read-only and deleted) | 0 |
| `live-create` | Add Project's New tab, the publish picker's owners and visibility, the project page's Publish dialog; never publishes | gh | 0 |
| `live-nogit` | a plain folder: the index row and project page read without git, a terminal from the page, `project git init` and the open page follows (checkouts, Publish); removes the `.git` it made | `LIVE_NOGIT_DIR` (`~/cf-live-scratch/plain`) | 0 |
| `live-bottom` | cmd+j starts a real shell, `exit` hides the panel, cmd+j again, cmd+w; a panel whose shells went while away comes back closed | `LIVE_THREAD` or starts an idle thread | 0 |
| `live-codeblock` | a reply's bash block: Run in terminal runs it once in a new shell of the thread, in its checkout, and the shell stays | `LIVE_THREAD` or starts one | 1 |
| `live-files` | `@READ` card → README.md tag, Fresh copy; the Read tool reads README.md in the new worktree | a git project with README.md | 1 |
| `live-skills` | `/dem` card → `/demo` tag ("Project skill"); Claude gets the skill's slash command (and its reply with `LIVE_SKILL_REPLY=skillran`) | a project with `.claude/skills/demo` | 1 |
| `live-workspace` | the picker's workspace row, Run in its second project; the thread's workspace, project and path | workspace `demo` (`LIVE_WORKSPACE`) | 1 |
| `live-sidebar` | rows of a workspace thread (Layers glyph) and a project thread, the workspace's page, Run in only on the workspace thread, and the move | workspace `demo` | 2 |
| `live-prs` | the Pull Requests page from cmd+shift+d: viewer, freshness, the commits chart; `LIVE_ALL=1` also an authored row | gh | 0 |
| `live-prthread` | the PR panel on a project page, Explain this PR starts a thread with the explain prompt, the page keeps the PR tab | gh, a clone of `LIVE_PR_SLUG` registered as `LIVE_PROJECT`, `LIVE_PR` (used: `octocat/Hello-World` #1) | 1 |
| `live-stall` | diagnostic: samples daemon, store and DOM while a turn runs and fails naming the layer that lags | `LIVE_STALL_THREAD` or starts one in a new worktree | 1 (long) |

All thirteen passed against a scratch daemon (Claude Code 2.1.322, WebKit) on 2026-11-11.
Seen to fail with their subject broken on purpose: `live-stall` (the page's websocket
silently dropped mid-turn: `deliveryStall: true`) and `live-bottom` (the removed-terminal
handler in `stores/events.ts` disabled: the panel stays after `exit`). Both edits were
temporary. `live.spec` also failed first on each stale expectation listed below, which is
how they were found.

## What changed

- **Deleted** from `live-prs`: "worktree overview of a GitHub-backed clone" and "worktree
  overview of this worktree". They double-clicked a project or worktree on the Projects page
  to open its overview; the overview page is gone (a checkout's diff is a Diff tab in the
  page's side panel now, covered by the mock suite), so nothing they asserted exists.
- `live.spec`: the threads run in the scratch project, not the repository's checkout; the
  model is Haiku 5.5 (it passed `opus` and the alias `haiku`, which `thread new` refuses);
  no "Fable" option (not in `internal/model`); `thread list` prints `attention (finished)`;
  archiving now lists the thread apart and moves the selection, so step d opens it from the
  Archived section (the `thread-disconnected` card it asserted absent is gone); cmd+n's
  picker opens on No project, so step e clicks the project's row.
- `live-create`: `publish-github` → `project-publish` on the project page, and it asserts
  Publish is unchecked before Create.
- `live-nogit`: rewritten for the Projects index (`index-project[data-kind=nogit]`) and the
  project page (`project-init-git`, `project-checkouts`, `project-publish`), with the
  terminal opened from the page's Threads line; the old project card and overview Diff tab
  are gone.
- `live-workspace`: `workspace members` does not exist; `liveWorkspace` reads `workspace list`
  and `project list`. Run in is picked by the project's name.
- `live-sidebar`: the workspace page through `openWorkspacePage`; the dropped asserts were on
  `[data-testid=workspace]` and project/worktree sidebar rows, neither of which exists.
- `live-files`: Fresh copy is picked (the default is the project folder now), and the Read
  path is asserted in the new worktree instead of printed.
- `live-prthread`: the project page instead of the overview; no default slug (it pointed at
  this repository); archives its thread.
- `live-bottom`, `live-codeblock`, `live-stall`: start their own thread when the env var
  naming one is unset; codeblock checks `pwd` against the thread's worktree instead of a
  hardcoded `/cf-cba-scratch`.

## Gotchas

- `cli()` drops `CODE_FOUNDRY_ENDPOINT`, `CODE_FOUNDRY_TOKEN` and `CODE_FOUNDRY_THREAD`: inside
  a Code Foundry thread they name the user's daemon and the calling thread, and the home alone
  should pick the daemon.
- `thread list` hides archived threads; `listThreads` passes `--archived --limit 0` so a
  spec can follow a thread it archived.
- A thread's status reads idle before its first turn starts: wait on the transcript, or on
  `thread wait` (`waitThread`), not on the status alone.
- A scratch home under `/tmp` works for every spec but `live-create` and `live-addproject`,
  whose projects land in `<home>/projects`, which must be under `~`.
