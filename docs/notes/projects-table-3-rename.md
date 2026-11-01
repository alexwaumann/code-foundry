# Projects table 3: project rename

The third of three PRs on the Projects page (1: the index table, 2: context menus). A
project's name was its folder's basename, set at registration and never changed. Now
`project.rename` sets it.

## What shipped

- `ProjectService.Rename(id, name)` and `project.Store.Rename`
  (`internal/store/project/rename.go`): writes `projects.name`, swaps the project's
  metadata slot and republishes the snapshot (`ProjectUpdated`), so the GUI, the CLI,
  thread checkouts and the composer read the new name. Renaming to the current name is a
  no-op.
- `project.rename <project> <name>` (`internal/command/commands_project_rename.go`). The
  project arg is the usual ref (id, the one project with that name, a path inside it, or
  the active project in the GUI), resolved before the rename, so the old name works as
  the ref. It is in the palette.
- GUI: `NameEditor` (`components/projects/NameEditor.tsx`) is the old
  `WorkspaceNameEditor` with the store and command passed in. `WorkspaceNameEditor` and
  the new `ProjectNameEditor` are thin wrappers; the workspace editor's tests run
  unchanged against the wrapper. The project page header shows the editor in place of the
  picker while `stores/projectRename.ts` `renamingProjectId` is the page's project.
  `startProjectRename(id)` opens it from anywhere; PR 2's index-row Rename calls it and
  renders the same editor in the row. The page's ⋯ menu has Rename (no icon, no ellipsis)
  after New action…. `projectMenu` adds it only when given a `rename` callback, so the
  index row's menu (PR 1's file) has no Rename that would do nothing there.
- Mock: `mock/projectRename.ts` (the command and the RPC, with the same rules);
  `e2e/project-rename.spec.ts`.

## Name rules (`project.CheckName`, mirrored in `src/lib/projectName.ts`)

Trimmed and NFC-normalised, like workspace names; one line of at most 100 bytes. Then
the refusals that keep refs unambiguous. Project refs resolve an id first, then a name
only when exactly one project has it, then a path, and `--projects` is a comma list:

- another project's name, whatever the case: FailedPrecondition. Registration still
  allows two folders with the same basename (as before), and refs to such a name stay
  ambiguous until one of them is renamed. Renaming one of the pair to the shared name is
  refused as well.
- another project's id (InvalidArgument): the id would always win.
- `/`, `,`, or exactly `~` (InvalidArgument): those read as paths and lists.
- `workspace` in any case (InvalidArgument): a project with that name takes the
  primary keyword's place in workspaces and `thread new --project`.

## Gotchas

- Worktree paths read the name for projects without a GitHub origin
  (`_local/<name>`). `worktreeKey` now takes the folder (`filepath.Base(m.Path)`), which
  equals the old name for every project registered so far, so nothing moves. Without that
  change a rename would have moved new worktrees and broken the reuse of existing ones
  (a thread's recreate compares paths).
- The metadata slot had two writers, Register and the reconcile job; Rename is a third.
  A reconcile that read the old slot would have stored the old name back, so reconcile
  takes the name from the current slot under `g.mu` (`renamedLocked`). Renames are
  serialised by `renameMu`, so two cannot both pass the uniqueness check with the same
  name.
- The mock's tsconfig has no `@/` alias, so `lib/projectName.ts` (which the mock imports)
  inlines the `workspace` keyword instead of importing `lib/workspaceCard.ts`.
- `e2e/projects.spec.ts:51` (the index's activity order) fails on main as well, at the
  time of writing. Not touched here; PR 1 rewrites that test.

## Restart

The daemon must be restarted for the new command and RPC: an old daemon answers
`project.rename` with "unknown command" and `ProjectService.Rename` with Unimplemented.
