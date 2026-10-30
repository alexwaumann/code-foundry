# Thread info card 4/5: project set on the fly, actions in any member

Status: done on branch `cf/thread-project-set` (one PR, daemon then GUI, one commit per
item). The fourth of five PRs (1/5 `thread-info-facts.md`, 2/5 `thread-info-card.md`,
3/5 `thread-header-crumb.md`). A thread's project set was fixed at Create; now the card
changes it, a thread runs any member's Project Actions, and the pickers say up front
which branches a Create would refuse.

## 1. Thread project set mutation (daemon)

* `thread.Manager.AddProject(id, ref)` and `RemoveProject(id, ref)`
  (`internal/store/thread/members.go`); `ThreadService.AddProject`/`RemoveProject`
  (`AddThreadProjectRequest{id, project}`); `thread.project.add <project>` and
  `thread.project.remove <project>` (`commands_thread_project.go`, NoPalette: the card is
  their GUI place).
* **Placement of an added member** is Create's rule, through Create's own code: in
  worktree mode a git project gets the worktree for the thread's created-for branch
  (`makeWorktrees` with one project: `memberWorktree` shares a worktree on the branch,
  else one is made; the up-front `worktreeFor` refuses a main checkout on the branch and a
  default path holding a worktree moved to another branch, the #401 refusal word for
  word). A plain folder is its folder; in checkout mode a project gets its own checkout
  (`mainCheckout`). A worktree made here runs the project's on-worktree-create actions
  (`WorktreeCreated`, as Create's do) and is pre-trusted; a project folder is pre-trusted
  too (the restart below does not go through `preTrustCheckouts`).
* **Removal** drops the member and its `CheckoutPaths` entry; the checkout stays on disk
  (no worktree removal, no branch deletion). Refused for the cwd's project ("run it in
  another project first") and for a member a queued Run in moves to.
* **Detach.** Either change clears `Thread.WorkspaceID`; the workspace is untouched. The
  crumb then reads "<cwd> +N" (`lib/threadCrumb` already did for an unnamed set) and Save
  as workspace is offered. Refused for a thread without a project and for one in its
  workspace's folder (`CheckMembersChange`, which reuses `CheckWorkspaceChange`): leaving
  the workspace would leave it without a cwd.
* **Save as workspace on a detached thread** needed no change: `workspace.new` then
  `thread.workspace` (SetWorkspace) attach it; `TestAddProjectStopped` and the e2e check it.
* **The live Claude.** Claude Code has no control request that changes the `--add-dir`
  list of a local process (its `add_directory` is for a cloud container: a mount path, a
  staging step, an env var the container must set; read from the 2.1.314 binary). So the
  change is applied the way an effort change is (`effort.go`): `changeMembers` sets the
  runner's `dirsStale` flag (an atomic, under `Manager.mu`, with the row change), and
  `maybeRestart` restarts the process with `--resume` once it is quiet at its prompt (no
  turn, no background shell, no wake pending); `respawn` swaps the flag off and reads the
  row's set as it is then (a change after that read sets it again). A stopped thread just
  takes it at its next start. This is "queued until idle, applied at once without a
  process", as Run in is, with a restart instead of `set_cwd`.
* **The restart is visible** (review): a live thread's note ends "Claude restarts with the
  new folders once it is idle." (a removal: "…; until then <path> stays one of its
  folders."), and `onRestarted` writes "Restarted Claude with the new project list"
  (`DirsRestartNote`, a command-output line like "Set effort to …") when the restart that
  carried the new set is up.
* **A note that cannot reach the runner** (review): the flag is set with the row, not by the
  note's command, so the restart still comes at the next idle. The note and "Could not
  restart Claude for the new project list: <err>; it retries when idle" are queued on the
  runner (`queueNote`) and written by its next `maybeRestart` (every tick).
* **Archived threads** are refused (review): "thread … is archived; unarchive it first"
  (`CheckMembersChange`, the fake and the mock too).
* **Branch PR links of a removed member go** (review, decided): links whose source is
  `branch` in the removed member's GitHub repository are dropped from the thread (memory
  and `thread_pull_requests`), unless another remaining member works in the same
  repository. Branch links keep no project, only the repository (the daemon matches them by
  repository and branch), and only members in that repository produce them, so the slug is
  the member. Links from Claude's records and from child threads stay; the copies a branch
  link made up the creator chain (as child links) stay too.
* **Timeline notes**: "Added project lib to this thread (new worktree …)." / "Removed
  project api from this thread. Its checkout (…) stays on disk.", plus "The thread no
  longer follows workspace platform: its projects are its own set now." when it left one.
  Live: through the runner (the same command as the restart); stopped: written to the log.
* **Dirty member confirm.** `thread.project.remove` has `Confirm` + `ConfirmIf` +
  `DynamicConfirm`: when the member's checkout has uncommitted changes (the Checkouts RPC's
  status) it asks, naming the counts ("api's checkout at … has uncommitted work: 1
  untracked. It stays on disk with the work, but this thread no longer sees it."). The GUI
  gets the app's confirm dialog through `runCommand`, the CLI the usual `--yes`. Nothing is
  deleted, so this is the first-stage confirm, not the `--force` second stage.
* **The guide** was at 25,388 bytes; the two verbs took it to 25,995. Kept in the guide
  (an agent can grow its own set) with short descriptions, and other Thread descriptions
  were trimmed (budget, sidebar, snooze, set-effort). The enforced cap is **25,600**
  (`internal/guide/topics_test.go`), not the 25,500 the first version aimed at. Review:
  four facts the first trim lost are back (agents: foreground and background runs, the
  header's count of the thread's own background shells, Bash run_in_background and
  Monitor; slash commands: Claude's own list, plugin skills; labels: up to 40 characters
  each; agent.open: under the thread), and thread.wait's description no longer repeats its
  `--until` values (its flag's line lists them): 25,596 bytes after the rebase onto #416. The
  help skill's Workspaces paragraph says adding or removing a project leaves the workspace
  (one line; 109 of 109).
* **CLI wording** (review): the workspace a thread left is "<name> (<id>)" (from the
  Checkouts RPC, which carries the name), and the count is "1 project" / "N projects".

## 2. Actions in any member (daemon)

* `action.Options.Thread` returns a `ThreadPlace` (the cwd's project and checkout, and
  every member's existing checkout by project id; the daemon fills it from
  `thread.CheckoutsOf`) instead of the cwd only.
* A run with a thread (`action/thread_run.go`): `project_id` given must be a member; an
  action id may be any member's; a name is looked up in the cwd's project first, then in
  the other members (exactly one, else INVALID_ARGUMENT naming the ids). The run goes to the
  thread's checkout of the action's project with the thread as owner: the terminal is
  labelled with the thread (its bottom panel), `CODE_FOUNDRY_THREAD` is set, the record has
  `thread_id`, so `action last` / the card's pick says "ran last in this thread" for that
  project. A thread in its workspace's folder (no cwd project) can now run its members'
  actions too.
* The Projects page's worktree path is unchanged (`owner(worktree, project)`).
* `action.run` no longer sends the thread's cwd project as `project_id` (that would pin
  name lookup to the cwd); its description and the proto say "an action of any of its
  projects".

## 3. Card wiring (GUI)

* `components/threadinfo/PlaceGroup.tsx`: the project row is a menu for every thread with
  a project (one project too: Add project). Add project opens `AddProjectPicker`: the
  composer's multi-select `ComposerPicker`, now able to be opened from elsewhere (`anchor`,
  `open`, `onOpenChange`: a `PopoverAnchor` under the row instead of a trigger); members are
  checked, a pick runs `thread.project.add` and the list stays open. Save as workspace shows
  for an unnamed set of two or more and is enabled when no saved workspace has the set
  (`useCanSaveAsWorkspace`); it opens the existing dialog. Run in rows have a × on hover or
  highlight (and Delete/Backspace on the highlighted row) for every member but the cwd's:
  `thread.project.remove` (`stores/threadProjects.ts`); the daemon's confirm covers a dirty
  checkout. The × has no tooltip (a known gesture; its accessible name says what it removes).
* **Actions**: `runCardAction(actionId, threadId)` always runs for the thread; #407's
  worktree owner and toast went.
* **Refused branches greyed** (`lib/placementCandidates.ts`, `stores/placementChecks.ts`):
  the GUI cannot compute the default path, so it picks candidates from what the projects
  store knows (a main checkout on the branch; a linked worktree whose folder is the
  branch's, `feat/x` → `…/feat-x`, with another HEAD) and asks `thread.placement.check`
  only for those, cached per set, branch and a signature of those worktrees (a switch back
  asks again). The composer's Work in branch rows and the card's Run in rows (each member
  alone on the thread's created-for branch, while the menu is open) and the card's Add
  project rows (worktree mode) show a refused one greyed with the refusal as its tooltip.
* `PickerOption.unavailable`: greyed (`opacity-50`), not picked, tooltip on an inner span
  filling the row. Not cmdk's `disabled` (it drops pointer events, so no tooltip) and not on
  the `CommandItem` itself (cmdk's item sets its own `onPointerMove` over the tooltip
  trigger's).
* **The thread's own moved checkout** (review): the daemon's refusal names the thread that
  works in the checkout, which in Run in is the thread itself. When the refused member's
  checkout is the folder of the created-for branch with another HEAD (`ownMovedText`), the
  tooltip says "This checkout moved from feat/x to other; a new thread on feat/x would be
  refused here." instead; any other checkout keeps the daemon's words.
* **Checks only while a list is open** (review): the composer's Work in asks the daemon only
  while its list is open (`onOpenChange`), as the card's Run in menu and Add project do.
* **Run in rows stay selectable when greyed**: Run in to a member whose worktree moved is
  fine (it is still the thread's checkout); the grey and the refusal say a new thread on the
  branch would be refused there and how to fix it. The Work in and Add project rows cannot be
  picked: those would be refused.

## 4. Composer (GUI)

* `lib/projectSet.resolveSet`: a set picked from a named workspace that no longer matches
  its members (a project added or taken out) has no workspace: the heading names the set
  ("3 projects", or the lone project), the workspace chip goes, and `thread.new` is sent
  without `workspace`. Derived, not stored: picks that match again bring the workspace back,
  since nothing was sent. The workspace's default primary still applies while it is in the
  set (adding a project does not move where the thread runs); the workspace's folder as the
  primary goes with the workspace. A workspace not listed yet keeps the reference; members
  the registry no longer knows are not compared.
* Tests: `projectSet.test.ts` rows (added, taken out, another order, folder primary, unknown
  member, unlisted workspace) and `sameProjects`; `compose.test.ts`'s three workspace cases
  follow the rule. Review: `composer-fixes.spec.ts` test 1 checks the composer's empty state
  again (the detach, then the last project out through Add project's list, since a lone
  project has no chip: the empty note, Send disabled, Enter sends no `thread.new`), and 1b
  the add-then-take-out round trip.

## Gotchas

* A `PopoverAnchor` span inside the row's wrapper places the list under the row; the menu
  item opens it in a microtask, after the dropdown let go of the keyboard (as Save as
  workspace's dialog does), or the list closes as a focus outside.
* The mock now models both verbs (`World.addThreadProject`/`removeThreadProject`, the
  placement check's refusals, notes via `logs.addNote`) and a thread's action run over its
  members (`MockActions.threadRun`).

## Tests

* Go: `TestWithAndWithoutMember`, `TestCheckMembersChange` (pure);
  `TestAddAndRemoveProjectLive` (worktree made for the branch, workspace left, note, the
  restart with `--resume` and the new `--add-dir`, removal restarts without it and keeps the
  worktree, the cwd's refused); `TestAddProjectStopped` (checkout mode, a folder, nothing
  made or started, persisted, the next spawn's add-dirs, Save as workspace attaches);
  `TestAddProjectRefusals` (moved default path, a main checkout on the branch, unknown
  project, no project, workspace folder, archived); review: `TestAddProjectRestartWaitsForTheTurn`
  (a permission request holds the restart, the restart note after it),
  `TestFailedSetChangeNoteRetriesTheRestart`, `TestRemoveProjectArchived`, `TestDropBranchLinks`,
  `TestRemoveProjectDropsItsBranchLinks` (across a daemon restart); `TestThreadProjectSet` (CLI messages, the dirty confirm, `--yes`);
  `TestRunOwnerAndAction` rows for members; `TestThreadRunsAMembersAction` (labels, env,
  record, pick); `TestResolveForThread`.
* GUI: `placementCandidates.test.ts` (and `ownMovedText`), `projectSet.test.ts`, `compose.test.ts`;
  `e2e/thread-project-set.spec.ts` (add per pick and detach, remove with the dirty confirm,
  the greyed Run in row, the greyed Work in branch); `thread-info.spec.ts` (one project's
  menu, Add project enabled, another member's action runs for the thread),
  `composer-fixes.spec.ts` and `project-sets.spec.ts` follow item 4.

## Verified

* `make check` green.
* Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cf-pset`, repos `web`, `api`, `lib` with local bare
  remotes under `~/cf-pset-scratch`, workspace `platform` = web+api, Sonnet 5.5 medium,
  one-word prompts), CLI only:
  * `thread new --workspace platform --new-worktree --branch feat/pset`, then `thread
    project add lib`: lib's `feat/pset` worktree made, workspace cleared ("it no longer
    follows workspace …"), and the idle Claude restarted within a second with `--resume` and
    `--add-dir …/lib/feat-pset` (and no workspace dir).
  * With an untracked file in api's worktree and a 12 s `sleep` turn running, `thread
    project remove api` exited 2 with the confirmation naming "1 untracked"; with `--yes` it
    was removed at once and Claude restarted only when the turn ended (14 s later), without
    api; the worktree and its file are still on disk. The timeline has both notes.
  * `thread project remove web` (the cwd's) refused; `thread project add api` on a thread
    on `feat/m` while api's `feat/m` worktree had `other` checked out refused with Create's
    text, naming the thread working there.
  * An in-place thread, archived and unarchived (stopped): `thread project add api` recorded
    api's own folder, started nothing; the next message spawned with `--add-dir` api's folder.
  * `workspace new duo --projects web,lib` then `thread workspace --workspace duo` on the
    detached thread: it references duo.
  * Actions: lib's `Where` (thread's cwd web) ran in `…/lib/feat-pset` with
    `CODE_FOUNDRY_THREAD` set; `Test` (in web and lib) resolved to web's; lib's `Test` by
    id ran in lib's worktree; `--terminal` labelled the terminal with the thread; `action
    last --project lib` named "ran last in this thread"; from the lib folder without a
    thread it ran as the folder's worktree run as before; another thread whose set lacks lib
    was refused.
  * Daemon log: no warnings or errors.
* The built app on an isolated home: shots in the PR body (Run in with the greyed moved
  member and the ×, the crumb after Add project, dark and light).

## Review fixes (PR #418)

One commit each, except that the restart note, the queued failure note and their tests
share one (the flag that makes a failed note still restart is what the visible restart
reads): the restart in the timeline and the failure path; the composer's empty-state e2e;
the removed member's branch PR links; archived threads refused; CLI and Run in wording; the
guide's four facts under the 25,600 cap; Work in checks only while open. Rebased onto #416
(thread servers) and #417; the conflicts were the pinned command lists, the mock's header
and generated code (regenerated). `make check` green; thread-project-set, composer-fixes and
compose specs re-run on WebKit.
