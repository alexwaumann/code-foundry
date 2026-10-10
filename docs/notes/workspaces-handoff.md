# Multi-repo workspaces — handoff

Status: **built** (all five steps of section 5; notes listed there). Decided with Alex on 2026-10-09 in a design
conversation; this note is the record so a fresh agent can pick it up. Read
`ARCHITECTURE.md` and `PLAN.md` first, then `new-thread-composer.md` (composer branch
`t3code/new-thread-initial-prompt-ui`) and the side panel note (branch
`t3code/right-side-panel-with-pr-tab`), both of which this work builds on.

## 1. Problem

At work Alex's changes span several repositories at once: a UI repo plus one or two
service repos, or the same mechanical change across many repos. The old personal tool
(claude-foundry) had "workspaces": one named branch, one worktree per member repo, and
sessions that knew about the sibling worktrees. The settled workflow is **one driver
session** in any member worktree that edits, commits, and opens PRs across all members
(using its own subagents for fan-out). Two things make that hard with plain Claude Code:

1. **Edit access.** The work managed settings sandbox Claude to its cwd plus added
   directories. The org's managed settings put `additionalDirectories` at the top level
   with `~/**`, which is a no-op (the key is `permissions.additionalDirectories`, a
   list of directory paths; `--add-dir` validates each path is an existing directory and
   no glob support is documented).
2. **Context.** Nothing tells the session which other worktrees belong to the change.

## 2. Verified Claude Code facts (docs, 2026-10-09)

* `--add-dir <path>` grants read/edit access and, unlike the settings key, also loads
  skills, commands and subagents from that directory. `CLAUDE.md` / `.claude/rules` from
  added directories load only with env `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`.
  `permissions.additionalDirectories` (settings) grants file access only.
* `/add-dir <path>` widens a running session. There is **no** command to drop a
  directory. Mid-turn it asks for confirmation.
* `/cd <path>` moves the session's primary cwd keeping the conversation; loads the new
  dir's CLAUDE.md, settings, hooks, MCP; prompts for trust if the folder is untrusted;
  keeps `--add-dir` directories. `--resume <id>` searches other projects too (v2.1.223+).
* The system prompt (including `--append-system-prompt`) is recorded on the first
  request and reused until compaction. Changing it on reconnect takes effect only after
  compaction. Hence: keep the appended prompt tiny and static.
* Sandbox: sandboxed commands may write to cwd, `$TMPDIR`, added directories, and (when
  cwd is a linked worktree) the main repo's shared `.git`. Unsandboxed: file tools, MCP,
  hooks. User-level sandbox/permission settings still apply alongside managed settings
  unless a managed-only lock covers them.
* Work sandbox specifics (Alex checked on the work laptop): **Unix sockets are
  blocked**; `network.allowLocalBinding = true` and `allowedDomains` includes
  `localhost` / `127.0.0.1`; bind+connect on an ephemeral 127.0.0.1 port works; h2c +
  Connect over TCP works.

## 3. Decisions

* **Workspace = branch set.** `{id, name, branch, members: [{repo_id, worktree_path}]}`,
  persisted in SQLite by a new `internal/store/workspace` (snapshot + bus events like
  every store). Members are editable after creation. Saved "templates" (workspace with
  no branch) are a possible later addition, not in scope.
* **A thread's owner is one field**: `project` (repo) **or** `workspace`. Never "a repo
  via its worktree". The thread's **cwd is a separate fact** (the member it runs in).
* **Launch for workspace threads**: `--add-dir` for every *other* member,
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`, and one appended system-prompt line:
  "This thread belongs to workspace <name>. Run `code-foundry workspace members` for the
  current worktrees." Reconnect and fork read the *current* member list from the store,
  not the session row. No manifest file.
* **Membership lookup is a CLI verb, not a file.** `workspace members` resolves the
  workspace from `--cwd` (default: caller's cwd) when no id is given.
* **CLI transport inside sessions = loopback TCP + bearer token.** The daemon passes
  `CODE_FOUNDRY_ENDPOINT` (`http://127.0.0.1:<port>`) and `CODE_FOUNDRY_TOKEN` in every
  session's environment; the CLI prefers them over the socket and never auto-starts a
  daemon when they are set. Outside sessions the CLI keeps the Unix socket. The loopback
  listener and token already exist (`internal/daemon/daemon.go`, `internal/client`
  `NewLoopback`).
* **Add repo**: create the worktree on the workspace branch (base = base ref / default
  branch, same fetch-then-`worktree add` path the composer uses), pre-trust, done. No
  base/time bookkeeping. Running threads pick it up on their next
  `workspace members` call; new and reconnected threads get it on `--add-dir`.
* **Remove repo**: refuse while a live thread's cwd is in that worktree (name the
  thread); otherwise reuse `repo.worktree.remove` semantics (dirty check, `--force`).
  Nothing is revoked from running threads (impossible and unnecessary).
* **"Run in…"** thread action: move cwd to another member by queueing `/cd <path>` for
  when the thread is idle (reuse the pending-input mechanism `session.close` uses);
  update the row's cwd. **Verify first** that `/cd` does not prompt in auto mode on a
  pre-trusted worktree.
* **Sidebar becomes a flat thread list.** Row = project, thread name, branch, status,
  workspace badge. Pinned and needs-attention sections on top; filters later. No
  grouping, no thread-less worktree rows. Workspace worktrees **never** appear under
  their repo (Alex: it splits one change across the sidebar).
* **Projects page** takes over what the hierarchy showed: per project its worktrees with
  state; per workspace its members. "Repo" becomes "project" in user-facing copy (copy
  only, like the session→thread rename).
* **Right panel workspace surface** (needs the side-panel registry): members with
  branch, dirty, ahead/behind, PR and CI state; add/remove member; each member openable
  as a tab showing the worktree view. The projects page and this surface share one
  member-list component.
* **Composer**: picker lists workspaces above projects; picking one prefills member
  chips and the primary (cwd) member. Picking a project allows "Also in: + add repo",
  which creates a workspace on send. New-worktree mode creates `cf/<slug>` in every
  member after the single slug wait (`Options.SlugTimeout`).

## 4. Dropped / deferred

* Orchestration verbs (`session wait`, `session say`): dropped; the driver session's own
  subagents fan out. Not visible in the sidebar; accepted.
* Pushing `/add-dir` into running threads: dropped.
* A fixer for the misplaced `additionalDirectories` key in `~/.claude/settings.json`:
  deferred (only helps sessions started outside code-foundry).
* A "workspace root" directory containing the worktrees: rejected (loses per-repo
  CLAUDE.md discovery and trust handling).

## 5. Build order

All five steps are done: 1 `workspaces-1-store.md`, 2 `workspaces-2-launch.md`,
3 `workspaces-3-composer.md`, 4 `workspaces-4-sidebar.md`, 5 `workspaces-5-panel.md`.

1. `internal/store/workspace` + proto (`workspace.proto`, `make gen`) + commands
   `workspace.new | add-repo | remove-repo | remove | members` + CLI; session env
   endpoint/token + CLI loopback preference. Table tests; fake in `workspacetest`.
2. Session launch: owner field on the session row (migration), `--add-dir` siblings,
   CLAUDE.md env, appended prompt line; reconnect/fork from the store. Verify end to end
   on a scratch daemon with haiku (`CODE_FOUNDRY_HOME=/tmp/…`).
3. Composer: workspace entries in the picker, member chips, "Also in".
4. Sidebar flat list + Projects page + "Run in…" (after the `/cd` check).
5. Right panel workspace surface (after `t3code/right-side-panel-with-pr-tab` lands).

Each step: `make check` green, exercised end to end, a `docs/notes/` entry.

## 6. Open checks before step 2/4

* ~~`/cd` in auto mode on a pre-trusted member: prompt or not?~~ **Answered (step 2,
  2026-10-09, Claude Code 2.1.296, haiku, auto mode): no prompt.** `/cd <member>`
  printed `Moved to <path>` with no trust or confirmation dialog; `pwd` in the next turn
  was the new member. Typed mid-turn, Claude queues it and runs it after the turn. See
  `workspaces-2-launch.md`.
* `--add-dir` on a sibling worktree under the work sandbox: can `git commit` there
  write the sibling's main-repo `.git`? Alex says `permissions.additionalDirectories`
  with `~/` makes this moot at work, and it is not sandboxed at home; still worth one
  real run.
* Loopback endpoint in session env: confirm the CLI works from inside a sandboxed
  session on the work laptop once step 1 exists.

## 7. Code pointers

* Launch argv: `internal/store/session/claude.go` (`launch.argv`); spawn options and
  `Options.Claude` in `manager.go`; the attachments `--add-dir` is already added there.
* Worktree create/remove, fetch-first: `internal/store/repo`, `repo.worktree.new` /
  `repo.worktree.remove` commands in `internal/command`.
* Paths/socket/token: `internal/paths/paths.go`; client transports and auto-start:
  `internal/client/client.go`, `internal/client/autostart.go`.
* Composer: `gui/frontend/src/components/compose/Composer.tsx`, `ComposerPicker.tsx`
  (composer branch).
* Memory note for the same decisions: `workspace-branch-set-decisions` in Alex's
  Claude auto-memory.
