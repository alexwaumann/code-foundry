# Workspaces v2, fuzz round D fixes: the composer and the sidebar

Status: done on branch `cf/workspaces-v2-fix-composer` (off `main` after #349-#360; rebased
on #358 and #359). Fixes the sixteen findings of a fuzz round over the composer's project
set, "New thread on this branch", Save as workspace and the sidebar
(`workspaces-v2-3-composer.md` is the record of what they fix). Where the coordinator's
decisions differed from the report's suggested fixes, the decisions were built.

## Per finding

1. **Removing every member of a picked workspace still sent all members.** Taking out the
   last project of a set with a workspace now drops the reference too
   (`stores/compose toggleDraftProject`): the draft has no set. The composer shows an empty
   state: the heading is the set picker reading "Pick a project", a caption says "Pick a
   project or a workspace to start the thread in.", no Work in or Runs in, send disabled
   ("Pick a project first"). `sendDraft` refuses an emptied set (`isSetEmpty`, `NO_SET`) and
   any set with no projects whose workspace has members; `threadArgs` never sends an empty
   `projects` (only a workspace without projects goes without the list, and the daemon's
   empty member list is then right). The daemon's "no projects given means the members"
   rule is unchanged.
2. **Like with the workspace folder failed.** `placeRequest` takes `project workspace` with
   `Like` and no `WorkspaceID` as the like thread's folder (`wsPrimary`);
   `decidePlacement` refuses it unless the like thread has a workspace ("needs a workspace;
   thread X has none"). #358's `copyPlacement` already placed `wsPrimary` copies. Table rows
   in `TestDecidePlacement` (worktree-mode source, a source in its folder, a source without a
   workspace, one without a project).
3. **"A fresh copy of every project" where it cannot work.** A set with no git project
   (plain folders only, or a workspace without projects) offers only "Each project's own
   folder", and its Work in is forced in place (`lib/compose setWorkIn(choice, setting,
   hasGit)`, used by the composer and by `draftWorktree`, so what is sent matches). A note
   under the pickers: "No git repository in this set: it runs in place". The Work in footer
   (the setting) is hidden then.
4. **cmd+N on a project could open a composer without that project.** `composeIn` resets an
   empty draft's set, workspace, primary and base to the target's (the project alone);
   Work in stays (a pick is the draft's own). A draft with text or attachments keeps its
   set, and the heading already names it (the workspace's name or "N projects"), so nothing
   else changed there.
5. **Save as workspace in a workspace folder left an orphan workspace.** The item is hidden
   for a thread whose primary is its workspace's folder (`canSaveAsWorkspace(...,
   inWorkspaceFolder)`, `useCanSaveAsWorkspace`); the daemon's refusal stays.
6. **The tooltip named a workspace-folder thread's place by its id.** `ThreadTipBody` passes
   the thread's workspace name to `threadRowModel` and uses the Layers icon for that row.
7. **"What's next beside <thread>" for every in-place like.** The heading reads "What's next
   on <branch>?" when the thread has a branch (worktree mode), else "What's next in
   <name>?": the workspace's name, else the project's (or "N projects" for a set without a
   workspace, `setName`).
8. **"w-…'s own folder" in the like composer's Runs in.** `useLikeSource` reads the like
   thread's workspace name; the option's detail is "<name>'s folder".
9. **A like draft was lost with its thread.** The like composer remembers its thread
   (`noteLikeSource`, on open and while it shows); once the thread is gone it converts the
   draft (`convertGoneLikeDraft`) to a plain one with the thread's set, workspace, primary
   (the draft's own pick when it made one) and mode as Work in, text, attachments and options
   kept, under the workspace's key (the primary project's without one, No project without
   either), shows that composer and toasts "Thread <name> was removed; starting fresh". A
   draft already waiting there keeps its text first, the moved text after it (nothing typed
   is lost). The conversion runs when the like composer is shown, so a draft whose thread
   went while another view was up converts when the user goes back to it.
10. **Palette and menus disagreed.** One rule, in three places: `lib/threadRow canNewLike`
    (a project or a workspace) and `canRunElsewhere` (two or more places among the projects
    and the workspace's folder), used by the row menu, the header's More menu and the
    palette; the daemon's `When` is the same rule for a GUI caller (`canNewLike` from the
    context's project and workspace, `runElsewhere` reads the thread), and the mock follows.
    From the CLI (no active view) both stay offered: `thread new-like` of a thread without a
    project still copies its home directory, and `run-in` says why it cannot move.
    `TestThreadLifecycleCommands` and `TestThreadWorkspaceAndNewLike` rows.
11. **After-create toasts repeated the hints.** The composer passes the hints it showed to
    `sendDraft`; `lib/collisionHints unshownHints` drops the daemon's lines that match one,
    compared with the daemon's " (<id>)" thread label left out.
12. **The header's workspace chip ran a removed command.** The chip is gone: it repeated
    the header's place name, which already reads the workspace's name for a thread of
    several projects with a workspace or one in its folder. That place name now opens the
    Projects page with the workspace's card as the cursor row
    (`stores/projectsPage showWorkspaceCard`, the reveal #359 added for Add as workspace,
    which `showAddedWorkspace` now calls too; `ThreadParts ThreadLocation`,
    `data-opens="workspace"`). Every other place name keeps opening the Worktree tab: a
    thread without a workspace, a workspace the slice does not know, and a single-project
    thread with a workspace reference, whose place name is its project and branch (its
    workspace shows in the composer and on the Projects page). No new command arg: this is
    navigation, as the composer's Escape to the Projects page is. Unit tests
    (`ThreadParts.test.tsx`, `HeaderActions.test.tsx`); `live-sidebar.spec.ts` reads v2 (no
    badge, the workspace's name on line 2, `workspace list` instead of the removed
    `workspace members`); `sidebar.spec.ts`'s title.
13. **Long similar chip names.** Each chip's name and branch carry a tooltip with the
    project's path (hidden information, `tildify`).
14. **"Workspace" beside a project named "workspace".** The folder is "Workspace folder" in
    the composer's Runs in (and its pill), the row menu's and the palette's Run in…
    (`lib/projectSet WORKSPACE_FOLDER`); a project named "workspace" shows its name. Follow-up:
    the CLI's `thread new --project workspace` still means the folder whenever a workspace is
    given (the project then needs its id); unchanged here, as decided.
15. **The like pill's "In place" in monospace.** The pill uses the editable pickers' role
    (Button xs: `text-body-sm` medium); only a branch in "On <branch>" is mono.
16. **cmd+N did nothing from a new-thread composer's prompt** (pre-existing). A one-liner:
    the prompt's column carries `data-chord-yield`, as the thread composer's does, so cmd
    chords bound to commands reach the app; cmd+N opens the project picker.

## Decisions and gotchas

* The empty state is the draft's own (`Draft.projects` an empty list, `workspace` ""), not
  the target's: a project that is no longer registered still reads "This project is no
  longer registered."
* `runElsewhere` calls `ThreadBackend.Get` from `When`: cheap in the daemon (a snapshot
  read), and only for a GUI context. The command test fakes record it, so the GUI rows list
  the `GetThreadRequest` first.
* The mock's `POST /__mock/workspace` needs a project or a root: a workspace without
  projects in the specs is a rooted one.
* A ThreadMenu with neither item (no new-like, nothing to save) renders nothing.
* The row menu's New thread on this branch could lose the prompt's focus under load: the
  context menu's close handed focus back to the list after the composer took it
  (`project-sets.spec.ts` failed twice in full runs). The menu now keeps focus where it is
  when the selection is that thread's like composer, as it already did for rename.
* The sandbox refuses shell commands that mix git words with file edits; edits went through
  the editor tool.

## Verified

* `make check` green; `make gui-e2e` green.
* Unit: `lib/threadRow.test.ts` (canNewLike, canRunElsewhere), `lib/projectSet.test.ts`
  (labels, Save in a folder), `lib/compose.test.ts` (setWorkIn without git, no empty
  projects list), `lib/collisionHints.test.ts` (unshownHints), `stores/compose.test.ts`
  (emptied set, send refused, composeIn reset, like conversion),
  `keys/bindings.test.ts` (Run in… in a workspace without projects), `HeaderActions.test.tsx`
  (the chip opens the card). Go: `TestDecidePlacement`, `TestThreadLifecycleCommands`,
  `TestThreadWorkspaceAndNewLike`.
* e2e: `composer-fixes.spec.ts` (findings 1-16 but 13's truncation), `project-sets.spec.ts`
  updated (labels, heading, hints no longer toasted twice).
* **Live** (isolated `CODE_FOUNDRY_HOME`, scratch repos `web`, `api` and a plain folder
  `notes` under the home directory, workspaces `shop` (web, api) and `folders` (notes),
  Haiku 5.5 at medium effort, "say hi and stop"; all removed afterwards):
  * CLI: `thread new-like <shop thread> --project workspace` and `thread new --like …
    --project workspace` start in the workspace's managed dir with both projects; the same
    for a thread without a workspace says "project "workspace" (the workspace's folder)
    needs a workspace; thread <id> has none".
  * The built Wails app (`make gui-build`), dark and light: a thread in shop's folder, line
    2 `shop`, the header's place name `shop` with no chip beside the actions.
  * WebKit (Playwright) on the Vite dev server against the same daemon restarted with
    `--dev` (synthetic input to the native window was not used): the like composer of an
    in-place shop thread reads "What's next in shop?", Runs in lists "Workspace folder /
    shop's folder", api, web; sent with the folder, the new thread runs in the managed dir
    (`thread checkouts`). The `folders` workspace's composer: In place, one Work in option,
    the note. `live-sidebar.spec.ts` passed against it (with `LIVE_WORKSPACE=shop`).

## Follow-ups

* The CLI keeps `--project workspace` meaning the folder whenever a workspace is in play
  (finding 14's CLI half): a project named "workspace" needs its id there.

## Found while checking, fixed here

* **`thread new-like` ignored the default model and effort** (pre-existing: a CLI like ran
  on Claude's default where `thread new --like` ran on the settings' model). The daemon's
  settings-to-registry overrides now come from one list, `internal/daemon threadStarters`
  (thread.new, thread.new-like, pr.ask, pr.explain, pr.fix.findings, theme.ask), so every
  command that starts a thread takes `threads.default_model` and `threads.default_effort`
  the same way, marked as defaulted. The mock's list matches.
  `TestRegistryOverridesThreadStarters`; `TestThreadNewDefaultedModel` covers both verbs.
