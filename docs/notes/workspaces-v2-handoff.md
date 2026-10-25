# Workspaces v2: project sets, derived checkouts — handoff

Status: **design settled 2026-10-25, build starting.** Decided with the user in a design
conversation; this note is the record a fresh agent builds from. Read `ARCHITECTURE.md`
and `PLAN.md` first, then the v1 notes this replaces (`workspaces-handoff.md`,
`workspaces-1..5-*.md`), `agent-skills.md` (how skills reach a thread), `new-defaults.md`
(`threads.default_worktree`), `add-project-2-nogit.md` (plain-folder projects),
`hidden-children-1-daemon.md` (how `thread new` is used from inside a thread) and
`internal/store/project/cleanup.go` (the worktree cleanup verdict).

## 1. Problem

A v1 workspace is a *branch set*: a name, one branch, one worktree per member project. It
bundles three different things the user had to create and manage together:

1. which projects belong together (stable, conceptual: "my product's nine repos");
2. a branch name shared across them (per change, belongs to the thread);
3. the worktrees on that branch (derived: given projects and a branch they can be made,
   reused and removed by the daemon).

Users felt they had to manage every workspace that got created instead of picking a set
of projects on the fly, and a workspace lived inside one project. Engineers read
"project" as a repo; product owners read it as a group of repos. Both are right.

## 2. Verified Claude Code facts (2.1.306, tested 2026-10-25)

* Nested `CLAUDE.md` files load on demand only under the **cwd** (attached to the first
  read in that folder). Under an `--add-dir` they **never** load, root or nested, without
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`; with it, only the add-dir's **root**
  `CLAUDE.md` loads (at start), nested ones still never. The flag is all-or-nothing across
  every add-dir.
* Skills in `.claude/skills` **do** load from an add-dir whose `.claude` is a **symlink**.
* Reads and writes through a symlink inside an add-dir are **denied** by Claude Code's
  own check (it resolves the real path: "outside the allowed working directories"). The
  user's managed settings at work add the home directory, so there the real files are
  writable anyway; elsewhere Claude asks. Do **not** add prompt text about writability.
* `--add-dir` refuses a path that does not exist. Loaded files are labelled with their
  path, but small models still blur which repo a file belongs to.
* ~~Claude Code does not read `AGENTS.md` itself.~~ Outdated: 2.1.306 loads `AGENTS.md` like
  `CLAUDE.md`, from the cwd and its parents (verified 2026-10-25 for the fuzz fixes, an
  `AGENTS.md`-only cwd: Haiku 5.5 quoted it with its path). It does **not** find a parent
  folder's `.claude/skills` (a skill in `<root>/.claude/skills` was not listed from a
  thread in `<root>/child`). See `workspaces-v2-fix-1-workspace.md`.

Fixtures used: `/tmp/cfmd` (A, B, R, O, O2) on the user's machine; not in the repo.

## 3. The primitives

### Project (unchanged)

A repo or a plain folder (`Project.Git` false: one synthetic checkout, no git).

### Workspace (redefined; the name stays, it is the VS Code meaning now)

```
Workspace {
  id            w-<12 hex>            key; names are editable (unique, case-insensitive)
  name
  root_path     optional              a real folder the workspace came from (§6 scan)
  members       []project_id          ALWAYS stored and shown sorted by project id
  default_primary  project_id | "workspace"   where new threads start (see Primary)
  created_at
}
```

No branch. No worktrees. A workspace is a saved project set plus a place for
instructions and skills that span the set. Users are expected to have one or two.

**Managed dir.** Every workspace gets `<config home>/workspaces/<id>/` the moment it is
created (and, for existing rows, at daemon start). For a **synthetic** workspace (no
`root_path`) it is empty: the thread creates `CLAUDE.md`, `AGENTS.md`, `.claude/skills/…`
there with its file tools. For a **rooted** workspace it holds symlinks `CLAUDE.md`,
`AGENTS.md`, `.claude` → the same names under `root_path`, made for the ones that exist
and re-checked (missing links added, dangling ones removed) at every spawn. Nothing is
copied. The managed dir is what reaches Claude (§4). Removing a synthetic workspace
deletes its managed dir (the GUI confirm says its instructions and skills go too);
removing a rooted one deletes only the symlinks.

### Thread

```
Thread {
  project_ids   []project_id   sorted by project id; one entry for a single-project thread;
                               empty for a no-project thread
  project_id + worktree_path   the PRIMARY (cwd), as today
  branch                       as today (the branch Create made, or the checkout's)
  created_worktree             as today: this thread uses derived worktrees ("worktree
                               mode"); false: it runs in the members' own checkouts
  workspace_id                 OPTIONAL REFERENCE to a workspace (instructions + skills);
                               independent of project_ids, no longer "the owner"
}
```

The owner concept goes: a thread *has* projects. Sidebar line 2 (§7) and the Threads
tab read `project_ids`, `workspace_id` and `branch`.

**Stable order.** `project_ids` is sorted by id whatever the selection order, and the
primary is a separate field. Two threads with the same set and the same cwd then share a
system prompt prefix (prompt cache).

### Checkouts (derived; nothing persisted beyond what exists today)

For each project in `project_ids` the thread's checkout is:

* **worktree mode** (`created_worktree`): a git member → the worktree for
  `(project, branch)` at `defaultWorktreePath(root, key, branch)` (the same path every
  thread computes, so threads on the same branch share it; made if missing, reused if
  present, pre-trusted, `Managed` recorded); a plain folder → the folder itself.
* **checkout mode**: every member's own checkout (its main checkout, or the folder).

All missing worktrees are made **in parallel at spawn** (create, start on send, fork,
resume), fetch first as today; one failure fails the spawn with the project named. A
resumed thread recreates what a cleanup removed (`recreate.go` already does this for
the primary).

**Cleanup.** When a thread is archived, for each derived worktree of its (any member
except plain folders): if no other non-archived thread has it as a checkout (same path),
it was made by Code Foundry, git status is clean (no staged, modified, untracked or
conflicted entries, no operation in progress), and no thread's cwd or terminal is in
it, remove the worktree **at once**. Never the branch; commits live on the branch, so a
pushed or unpushed commit is not a reason to keep the worktree. This is a new verdict
beside `CleanupVerdict` (which keeps its merged-into-base rule for the abandoned sweep):
reuse its status plumbing, lift the base rule, add the "no other thread" check.

## 4. Spawn

`--add-dir` order, every spawn (through `claudeCommand`): the daemon skills dir,
plugins' dirs, the attachments dir, **the workspace's managed dir** (when the thread has
a `workspace_id` and the cwd is neither the managed dir nor the workspace's `root_path`),
**every other member checkout** (§3, existing directories only; a missing one is a
spawn error, not a skip), grants.

**Instructions.** When the thread has a `workspace_id` and the cwd is neither the managed
dir nor `root_path`: read `CLAUDE.md` from the managed dir (through the symlink), else
`AGENTS.md`; append it under one heading ("Workspace <name> instructions") after the
`ThreadPrompt` line and before app memory, capped at 32 KiB (truncate, log). When the cwd
*is* the managed dir or the root (or, since the fuzz fixes, inside the root), Claude loads
the files natively and nothing is added.
Drop `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` and the "This thread belongs to
workspace" prompt line entirely. Only the primary's `CLAUDE.md` loads natively; the
model learns the others' paths from `thread checkouts` and the entry skill tells it to
read a member's `CLAUDE.md` before editing there.

**Primary.** The cwd. Options: any member's checkout, or **"Workspace"**: the managed
dir (synthetic) or `root_path` (rooted). The default is the workspace's
`default_primary` (a rooted workspace defaults to "Workspace"), else the first selected
project. Mode follows `threads.default_worktree` (the user's setting). A rooted
workspace in checkout mode runs at the root with nothing extra. `RunIn` keeps moving
the cwd between a thread's checkouts (offered to multi-project threads, refuses paths
that are not one of them).

**`thread checkouts`** replaces `workspace members`: resolves the thread from
`$CODE_FOUNDRY_THREAD`, else `--id`, else the cwd (deepest checkout wins, paths compared
cleaned and symlink-resolved); prints `PROJECT  PATH  BRANCH  INSTRUCTIONS` per member
(`(current)` on the cwd, `(missing)` when the path is gone, INSTRUCTIONS = the member's
`CLAUDE.md` path or `-`), then, when the thread has a workspace, one row
`WORKSPACE <name>  <managed dir>`; `--json` as usual.

**`thread new`** gains `--projects a,b,…` (the set; `--project` stays as the primary
when given, else the first), `--workspace <id|name>` (reference; its members are the set
when `--projects` is absent), `--like <thread>` (copy project set, branch, primary,
workspace and mode from a thread: the "New thread on this branch" command, §7) and
`--new-branch` (with `--like`: a fresh `cf/<slug>` branch for the same set). Inside a
thread (`$CODE_FOUNDRY_THREAD` set) a child **inherits** the parent's workspace, branch,
project set and mode unless told otherwise; `--projects` narrows, `--new-branch`
branches off, `--project` alone keeps the parent's set and picks the primary. Read the
orchestrate skill first and keep what it relies on working (`--new-worktree`,
`--created-by`, `--request-id`); the skill text itself changes in PR 5.

**Collision hint** (composer, and `thread new` as a one-line warning on stderr): in
worktree mode, a plain-folder member that another non-archived thread also lists cannot
be isolated: "<name> is a folder, not a repo: thread <other> also works there". In any
mode, a member checkout that another non-archived thread already has (same path): "<name>
@ <branch> is also open in <other>". Both are hints, never blockers.

## 5. Store, proto, migration

* `internal/store/workspace`: `Create(name, members, root_path, default_primary)`,
  `AddProject`, `RemoveProject`, `Rename`, `SetDefaultPrimary`, `Remove`, `Watch`,
  `EnsureDirs` (managed dirs + symlinks; at start and on every spawn). The removal guards
  about live threads in member worktrees go (members have no worktrees).
* `WorkspaceService`: the same set; `Members` goes (see `thread checkouts`). Proto:
  `Workspace{id, name, root_path, members (project ids), default_primary, managed_dir,
  created_at}`.
* Thread proto: `repeated string project_ids`; `workspace_id` re-documented as the
  reference; `CreateThreadRequest`: `repeated string project_ids`, `like_thread_id`,
  `new_branch`; `new_workspace` removed (reserve the field). `RunIn` unchanged.
* Migration (one, forward only; GUI and daemon are always the same version): a
  `thread_projects(thread_id, project_id)` table (or a JSON column; the agent picks and
  notes why); every thread gets its own `project_id` as its set; every v1 workspace
  thread gets the workspace's members as its set, `branch` = the workspace's branch,
  `created_worktree` = true, `workspace_id` kept as the reference. `workspaces` drops
  `branch`, gains `root_path` and `default_primary` (first member); `workspace_members`
  loses `worktree_path` (the old member worktrees stay on disk and are exactly the
  derived paths, so nothing moves). Managed dirs are made at the first start after.
* `command.proto`'s `active_workspace_id` context stays (the active thread's reference).

## 6. GUI

* **Composer**: the project picker multi-selects (a workspace row selects its members;
  individual projects toggle; the set shows as chips sorted by id). A **primary** picker
  with "Workspace" at the top when a workspace is selected, then the members; defaults
  per §4. Mode follows the user's setting as today. The collision hints under the picker.
  "Save as workspace" is offered on a **thread** (header menu) whose set has two or more
  members and matches no saved workspace; it asks for a name and creates the workspace
  with the thread's primary as the default and sets the thread's reference.
* **Sidebar**: the workspace badge goes. Line 2 of a multi-project thread reads
  `<workspace name> @ <branch>`, or `<N projects> @ <branch>` when it has no workspace.
  Single-project threads unchanged.
* **"New thread on this branch"** (`thread.new-like`, label exactly that): row menu,
  thread header menu, palette; the GUI opens the composer prefilled (set, branch,
  primary, workspace, mode) so only the prompt is typed; the CLI is `thread new --like`.
* **Projects page**: the Workspaces section (member lists, Run in…) goes. **Workspace
  cards** replace it: name (editable in place), root (when rooted), members with the
  default primary marked, add/remove member, the instructions file (opens the File tab;
  `CLAUDE.md`, else `AGENTS.md`, else "none yet"), skill names from `.claude/skills`,
  Reveal in Finder, Remove (confirm; synthetic: "its instructions and skills are deleted
  too"). "Edit instructions" steers or starts a thread in the workspace with the file as
  context (`panels-read-only-agent-acts`). Worktrees show only under their projects.
* **Panel**: the Workspace surface and `view.panel.workspace` go. The **Worktree tab**
  gains a compact "Also in" list under the primary's facts: one row per other checkout
  (project name, branch, dirty mark), click opens that checkout as its own Worktree tab.
* **Threads tab**: workspace name and project count where it showed the owner.
* **Add Project scan** (PR 6): when the picked folder is not a repo and has git repos one
  level down (from one), the dialog offers two choices with short buttons and one
  explanatory line each: **Add as a workspace** (default when detected) — "The N repos
  inside become projects; this folder is their shared root for instructions and skills."
  — and **Add as a project** — "One folder. No git features for the repos inside." Non-repo
  children are not members; no checklist (edit members on the card later).

## 7. Skills and prompt

* Entry skill (`code-foundry`): a short **scopes** paragraph: app memory (`memory add`)
  for how the model should act in the app; **workspace instructions and skills** (the
  managed dir from `thread checkouts`, `CLAUDE.md` / `AGENTS.md` / `.claude/skills`) for
  what spans a set of projects; a project's own `CLAUDE.md` for one repo; read a member's
  `CLAUDE.md` before editing in it. `thread checkouts` in the reference (it is generated
  from the registry). Keep the guide under its 29 KB cap and SKILL.md under its line cap.
* `ThreadPrompt`: the `thread new` clause mentions `--projects` / `--like` in a few
  words only if it fits; prefer the skill.
* Orchestrate skill: children inherit workspace, branch and set; `--projects` to narrow,
  `--new-branch` to branch off; one worker per checkout still. Caps as in `orch-skill-v4.md`.

## 8. Build order (PRs, each with `make check`, a `docs/notes/workspaces-v2-<n>-*.md`
note, a PLAN.md line, screenshots in the PR body for GUI PRs, `make attest`)

1. **Daemon: thread model and derived checkouts.** §3 Thread + Checkouts, §4 spawn
   add-dirs for members, `thread checkouts`, `thread new` flags and inheritance, the
   collision warning on the CLI, cleanup on archive, migration (threads part), proto.
   Keep the v1 workspace prompt line working until PR 2 removes it. Mock daemon updated.
2. **Daemon: workspace store and managed dirs.** §3 Workspace, §4 managed dir + appended
   instructions + the prompt line and env flag dropped, §5 store/service/migration
   (workspaces part), CLI verbs reshaped (`workspace new/list/add-project/remove-project/
   remove/rename`, no branch or worktree args), `thread new --workspace`. Same agent as
   PR 1, sequential.
3. **GUI: composer and sidebar** (§6 composer, hints, Save as workspace, sidebar line 2,
   New thread on this branch). After PR 2.
4. **GUI: Projects page and panel** (§6 cards, Worktree tab Also in, surfaces removed).
   After PR 2, parallel with 3.
5. **Skills and prompt** (§7). After PR 2, parallel with 3 and 4.
6. **Add Project scan** (§6 last bullet, plus the daemon's detection and the
   workspace-with-root creation path). After PR 2, parallel with 3, 4 and 5.

Then a fuzz round by area (daemon threads/checkouts, workspace store, composer, Projects
page, CLI from inside a thread) with fix PRs.

## 9. Not in scope

Per-member branches (stacked PRs), workspace as a Skills marketplace destination (a
follow-up), artifacts, any new editor UI in a panel.
