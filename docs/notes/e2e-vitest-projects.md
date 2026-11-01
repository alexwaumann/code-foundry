# e2e → vitest: projects pages and dialogs

Second step of the plan in docs/notes/e2e-unit-duplicates.md: write the component tests that
were missing for the Projects view, then drop the Playwright tests they make redundant. Area:
the index, a project's page, Worktrees without threads and its remove confirm, the workspace
page and New workspace, the Add Project dialog and the Publish dialog.

## What moved

Five component test files, 95 tests, against a faked daemon:

* `src/components/projects/ProjectsIndex.test.tsx` (19): rows by activity, kinds, status
  sentences, pills, setup links, Default branch and its failing-checks link, the filter and
  `/`, the keyboard, the page picker and crumb, the empty install, both row context menus
  (items per kind, text only, cursor), rename in place, Remove project and Remove workspace
  through the confirm.
* `src/components/projects/ProjectPage.test.tsx` (15): header, checkouts table, row and header
  menus, Details, the kind variants, Refresh (fetch then refresh, disabled meanwhile), a failed
  refresh, Clean up merged worktrees, Worktrees without threads (reasons, actions, Resume, the
  remove dialog with its loss list and the daemon's force stage), rename from the page.
* `src/components/projects/WorkspacePage.test.tsx` (22): the header and its menu, rename,
  Remove workspace, the Projects card (Start here, Add project, Remove, the folder row,
  unregistered members), the Threads table and its menu, Instructions and skills (Write and Edit
  instructions, the steer toast), the keyboard, and the New workspace dialog.
* `src/components/addproject/AddProjectDialog.test.tsx` (22): the tabs, Local folder (Enter,
  Tab completion, clicks, the button, refusals), the folder-of-repos choice, GitHub (lookup,
  search, clone progress, a failed clone, an existing destination), New (name rules, create,
  publish, owners and visibilities, a refused publish, cancel deleting), and the Publish dialog.

The fakes:

* `src/test/daemonFakes.ts`: `invokeCommand` records every invocation (name, args, context,
  confirmed: what the mock's `invocations()` gives e2e) and runs a per-command handler;
  `needsConfirm` builds a real `ConnectError` with a `ConfirmationRequired` detail, so the
  confirm dialog, the remove-worktree presenter and the second stage all run unmocked. GitHub
  and worktree-detail reads are faked too.
* `src/test/projectsWorld.ts`: the mock's five projects, threads and leftovers as view models,
  seeded straight into the stores, plus helpers for workspaces, terminals and store updates.
* `src/test/addProjectFakes.ts`: the mock's folder tree (path completion, Register,
  InspectFolder), its GitHub repositories (lookup, search, clone with progress) and publish owners.

A test whose e2e version checked what the daemon does after a command (a rename shows, a
removed row goes, cleanup removes the merged worktrees, a created project or workspace opens)
gives the fake a handler that makes that change in the store, the way the daemon's event would.

## e2e removed (47 of 69) and kept (22)

Removed: every test in projects-context-menus.spec.ts and addproject-workspace.spec.ts (both
files went), the page rename in project-rename.spec.ts, 10 of projects.spec.ts, 11 of
workspace-page.spec.ts, 6 of create.spec.ts, 8 of addproject.spec.ts.

Kept, each for something only the browser or the whole app shows (their GUI logic now has unit
tests too, so the split PR can trim them to that part):

* projects.spec.ts: the index after Initialize git (the kind arrives from the daemon); the
  column narrowing and the narrow page (real width); the keyboard and the project page (a
  checkout opens its Changes tab in the page's panel); kind variants (git init again); Refresh
  (a failed refresh pushed by the daemon); each page's own side panel, the sidebar row, reload
  and history chords; scroll memory; worktrees to tidy (a CLI terminal.new); Worktrees without
  threads and Remove… (Show diff opens the Changes tab, Resume unarchives over the stream).
* workspace-page.spec.ts: synthetic (files the daemon re-reads after a turn, the Settings
  route), rooted (the File tab, root-missing from the daemon), Start here (hover-only CSS), the
  Threads table (Changes tab, thread pane, tooltip), Write instructions (the daemon's focus
  intent selects the new thread), an unregistered member (the Changes tab).
* create.spec.ts and addproject.spec.ts: the palette and the New thread picker entry points,
  and the Local folder chevron's hover opacity.
* project-rename.spec.ts: a rename from the CLI reaching the open page.

## Rules that belong in Go, not here

Assertions on the mock's own state were not moved (the GUI part, "shows the message", was).
Most of the daemon rules behind them already have Go tests: the folder-of-repos scan
(`internal/store/project/inspect_test.go`), add-workspace naming "product 2" and partial
failures (`internal/command/commands_project_add_workspace*_test.go`), project.create's
AlreadyExists and publish refusals (`internal/api/project_create_test.go`,
`project_github_test.go`), cleanup verdicts (`internal/store/project/cleanup_test.go`), the
uncommitted-work force stage (`internal/command/commands_uncommitted_test.go`), the default
primary fallback (`internal/store/workspace/fix_test.go`). One worth checking: Register of a
folder inside a registered project answering that project (addproject.spec.ts asserted it on
the mock; no Go test names it).

## Gotchas

* The mock and the daemon disagree on where the default primary goes when its project leaves
  a synthetic workspace: the mock picks the workspace's folder, the daemon the first member
  left (`internal/store/workspace/store_test.go`). The removed e2e test asserted the mock's
  answer; the unit test only checks that the folder row shows once the folder starts threads.
* `bun check -b` (the typecheck in `make check`) is stricter than `tsc -p .`: it rejected a
  loop over three resources with different value types and an unguarded optional chain.
* Radix menus open in jsdom on `pointerDown` with `button: 0`; context menus on `contextMenu`.
  A picked item runs in `onCloseAutoFocus`, so tests wait a tick after the click.
  `openAddProject` and `openPublishDialog` open on a microtask, so the same tick applies.
* NavRows have role `option`, so a picker's options are queried inside its dialog.
* The Local folder listing is debounced: tests wait for an entry before clicking it.
* Sonner's `toast(...)` (the default export) cannot be spied on; the cancel test mounts a
  `Toaster` and finds "Deleted taken" instead.
* The mock's `GET /__mock/github/calls`, `/__mock/projects/calls` and `/__mock/workspaces` have
  no e2e callers left. They stay for now.
