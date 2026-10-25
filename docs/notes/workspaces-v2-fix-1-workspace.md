# Workspaces v2, fuzz fix 1: the workspace store

Status: done on branch `cf/workspaces-v2-fix-workspace`, off `main` after #349-#356.
Fixes fuzz round B's findings (workspace store, managed dirs, instructions, workspace
verbs, skills text, the Add Project scan), all but the help skill's "Save as workspace"
line (finding 18: PR 3 ships it) and anything under `components/compose` or
`components/sidebar` (PR 3's files). Decisions settled with a user override the report where
they differ; they are marked "decided" below. Needs a daemon restart (proto, store and
spawn changes) and a GUI build (the card's missing mark).

## Per finding

1. **Removing a synthetic workspace a thread runs in** (decided). The workspace store
   takes `Options.InUse`; the daemon wires it to the thread snapshot
   (`internal/daemon/workspace_projects.go`, `workspaceInUse`): Remove of a synthetic
   workspace is FailedPrecondition while a thread that is not archived (nor being
   removed) has its cwd in the managed dir: "workspace shop: thread t-wsprim (s-…) runs
   in its folder; archive it or move it with thread run-in". Rooted ones are not asked
   (the root stays). The GUI's Remove goes through `workspace.remove`, so its error shows
   like any command error. **Missing cwd**: `internal/store/thread/cwd.go`, `ensureCwd`,
   runs in `spawn` (create, start, fork), in `resumeLaunch` (replacing its `stat` with the
   confusing `worktree …: stat …` text) and in the effort/user restart (`respawn`) before
   `claudestream.Start`: a workspace's managed dir is made again (EnsureDirs, empty); any
   other missing cwd fails "working directory <path> is missing", not exec's ENOENT that
   read as a missing claude. A derived worktree is made again as PR 1 does, at the next
   start (`ensureWorktree` runs before `resumeLaunch`); a restart of a live process does
   not recreate it (it would fetch on the runner's goroutine) and fails with the message,
   so the next message recreates it.
2. **A child Register refuses**. `ChildRepos` (`project/inspect.go`, `repoChild`) lists
   a child only when its `.git` is a directory holding a `HEAD`, or a file whose
   `gitdir:` is `<repo>/.git/worktrees/<name>` (Register's rule in
   `mainWorktreeFromCommonDir`). A submodule's or separate git dir's `.git` file is
   skipped, so the dialog never offers a folder that can only fail.
3. **Moved root** (decided). `WorkspaceService.SetRoot` + `workspace.set-root <root>
   [--workspace]` (Create's root validation; `ensureDir` repoints the links). `thread new
   --workspace` resolves the workspace without the folder check (`resolveWorkspace`);
   only a thread whose primary is the workspace needs the folder (`workspaceDir`, whose
   error names `workspace set-root`). A spawn whose rooted workspace's root is gone adds
   neither the managed dir nor the block (logged). `thread checkouts` prints "(missing)"
   after the root; `Workspace.root_missing` (refreshed with the contents) marks the
   Projects page card ("missing", red caption, the tip says set-root) and `workspace list`.
4. **A project named "workspace"** (decided). `workspace.IsKeyword(snap, ref)`: the
   keyword only when no registered project resolves from the ref (id or exact name).
   Used by `thread new --project` (with and without `--workspace`), `set-primary` and
   Create's default primary. `project.add-workspace` no longer passes `default_primary:
   "workspace"` (the store's default for a rooted workspace is the root), so a child
   folder named `workspace` does not become the default. Documented in `thread new
   --workspace`, `workspace new --primary` and `workspace set-primary`. Consequence: while
   such a project exists, `--project workspace` cannot name the workspace's folder; the
   default primary still can (see follow-ups).
5. **Unregistering a member** (decided). `Store.ProjectRemoved(id)`: the project leaves
   every workspace. The daemon calls it on `project.ProjectRemoved` and at start for
   members already unregistered (`startWorkspaceProjects`; the project snapshot is
   loaded synchronously by `project.Start`). The default primary moves as RemoveProject
   moves it (26). `projectByRef` now says "project <ref> is not registered" (it said
   "thread not found: project …").
6. **Rooted workspace's files** (decided). `thread checkouts`' WORKSPACE row is
   `Workspace.Dir()` (the root of a rooted workspace). The card's instructions/skills
   (`contents`) and the spawn's block (`readInstructions`) read the root itself, not the
   managed dir's links, so a real file in the managed dir never wins over the root's.
   Such a file stays logged at EnsureDirs, and `thread checkouts` adds "<path> is a real
   file; the workspace's root has the one Claude loads" after the table
   (`workspace.Strays`, `ThreadCheckoutsResponse.workspace_strays`). The entry skill's
   Scopes paragraph is unchanged.
7. **Members inside the root** (decided, verified below). No block when the cwd is the
   root or inside it; inside it the managed dir stays an `--add-dir` (Claude does not
   find a parent's `.claude/skills`).
8. **Names vs ids** (decided). `cleanName` refuses `w-` + 12 hex; `nameFree` refuses any
   workspace's id (any case). Resolution was already id-exact-first.
9. **Home as a root** (decided). `cleanRoot` refuses home itself; `Inspect` lists no
   children for home (`mayBeRoot`), and `project.add-workspace` of home says why.
10. **A root in a project** (decided). `cleanRoot` refuses a root that is, or is inside, a
    registered project's checkout or worktree, naming it. `Inspect` lists no children
    there (the plain-folder add still works); `project.add-workspace` refuses with the
    project named.
11. **A CLAUDE.md that is not a file** (decided). `workspace.InstructionsFile` is the one
    rule for the card and the spawn: the first of CLAUDE.md, AGENTS.md that is a regular
    file; names that exist but are not (a folder, a symlink loop) are logged and skipped.
12. **Permissions** (decided). `ensureDir` chmods the managed dir back to 0700 (warn log)
    at every EnsureDirs, start included.
13. `thread checkouts` with no projects ends its line.
14. Project names in messages: a registry-level `ProjectNameLister` set by
    `RegisterProject` (`command/project_names.go`); `describeWorkspace` and `thread new`
    use it (ids when no lister, as in single-domain tests). A default primary that is a
    project named "workspace" reads "project workspace (<id>)".
15. `thread new` prints "(worktrees on <branch>)" when the thread has no base (its
    primary is the workspace's folder).
16. add-workspace classifies a child by the returned project's id being in the List and
    names each project once (a linked worktree child registers its repository).
17. A blank instructions file adds no block.
19. `workspace add-project` resolves its arg as a project (`ID: ProjectID`) and prints the
    project's name.
20. `--projects` outside the workspace's members: allowed, with a one-line warning (a
    `CheckoutHints` line: "web not in workspace solo; the thread still gets its
    instructions and skills").
21. Card contents: `WorkspaceService.Watch` calls `EnsureDirs("")` after subscribing,
    before the snapshot (the start's refresh was there already); no polling.
22. add-workspace of a folder a workspace already has as its root adds the projects it
    lacks to that workspace instead of making "x 2".
23. Names are NFC-normalised (`cleanName`, `Snapshot.Named` compares NFC);
    `golang.org/x/text` became a direct dependency (it was in the module graph).
24. `resolveDir` (Register and Inspect) says "<path> does not exist" instead of the raw
    `lstat` error.
25. The scan skips an empty `.git` directory (2's rule). Register itself still treats a
    folder with any `.git` as git (out of the scan's reach now; not changed).
26. A removed default primary moves to the first member left of a synthetic workspace,
    else to "workspace" (a rooted one, or none left). **Deviation**: decision 6 says an
    unregistered default moves to "workspace"; it moves by the same rule as
    RemoveProject, since the decision described RemoveProject's behaviour and 26 changes
    it.

## Verification runs (Haiku 5.5, medium, `claude -p` 2.1.306, clean environment)

* **Parent `.claude/skills`**: a skill `heron-probe` in `<root>/.claude/skills`, a git
  repo `<root>/child` as the cwd, "list every skill available to you": not listed ("No, a
  heron probe skill is not among them"). So the managed dir stays an `--add-dir` for
  members inside the root.
* **AGENTS.md natively**: an `AGENTS.md`-only cwd (no CLAUDE.md) with a codename: Haiku
  answered the codename and quoted `<cwd>/AGENTS.md`. The handoff §2 line is corrected.

## End to end (scratch daemon, `CODE_FOUNDRY_HOME=/tmp/cfv2-fix-b`, fixtures under
`~/cfv2-fix-b`, both deleted after)

The report's repros, rerun: (1) remove refused naming the thread; the managed dir
deleted by hand came back at `thread restart` and Claude was at its prompt; archive,
then remove worked. (3) after `mv root1 root1-moved`: a member thread started (log:
"workspace root is gone"), `thread checkouts` "… root1 (missing)", `workspace list`
"(missing: workspace set-root)", a thread in the root refused naming set-root, a restart
of the root thread "Claude did not restart: failed precondition: working directory …
root1 is missing"; `workspace set-root` relinked CLAUDE.md and a new root thread ran in
`root1-moved`. (2, 16, 25) the scan folder (r1, a linked worktree of it, a repo named
`workspace`, a separate-git-dir child, an empty `.git`, a plain folder): "2 projects (r1,
workspace), starts in workspace"; again: "already has this folder as its root and every
repository inside". (24) "… nope does not exist". (4) `--project workspace` with and
without `--workspace` ran in the project. (5) after unregistering `lonely`: "1 project
(api), starts in api", a thread started there; `--project nope` "project nope is not
registered". (8) id-shaped names refused on new and rename. (9, 10) home and a project
checkout refused as roots, with reasons. (13) the zero-project lines. (26, 19)
"removed web … starts in api", "added web to workspace syn". (20) the warning. (15)
"(worktrees on feat/fix-b)". (23) the NFD spelling "exists". (6) a stray `CLAUDE.md`
(LOON) in rooted2's managed dir, GULL in the root: a member thread's prompt had GULL,
`thread checkouts` printed the root and the stray warning. (7) `prod3/gamma`: add-dirs
include the managed dir, no block. (11) a folder `CLAUDE.md` + `AGENTS.md` (TERN): the
block had TERN, the skip logged. (12) a managed dir chmod 777 was 0700 after a restart.

`make check` green.

## Not fixed, and why

* 18 (help skill's "Save as workspace"): PR 3 ships the item.
* A rooted workspace's managed dir keeps stray real files after `workspace remove` (it
  is removed only when empty): they are a user's or a thread's data, and with 6 new
  files go to the root.
* A root whose `.claude` is a symlink to `~/.claude` (not home itself) is still linked;
  home as a root is what the report showed.

## Follow-ups

* With a project named "workspace" registered, nothing on the CLI names the workspace's
  folder as `--project` (decision 5); `thread run-in` still matches the workspace entry
  after the members. A `--in-workspace-folder` flag or `--project @workspace` would close
  it if users hit it.
* `Register` still takes a folder with an empty `.git` as git (25 outside the scan).
