# Add Project stays put when a page opens it

`project.add` without a path (a page's `cf.run("project.add", {})`, or the CLI) opens the
Add Project dialog through `ShowView "project.add"` (docs/notes/page-verbs.md). Adding a
project there used to move the window to the Projects page with the new worktree shown,
as the dialog does from the palette. A user's first-run welcome page asked for a project
that way, and the window jumped away from the thread and its panel.

## What changed

- `openAddProject(tab, { stay: true })` records `stay` in the addProject store. Only
  `showView("project.add")` passes it; every in-app entry (palette, keybinding, the
  composer's Add a project row, the Start page, the Projects page) opens without it, and
  each open resets it.
- `selectAddedProject` and `showAddedWorkspace` do nothing when `stay` is set: no
  Projects page, no worktree or workspace card. The dialog closes as before (toast
  included). The project shows wherever projects are listed; a welcome page reading the
  `project` bridge source updates itself.

## Decisions

- **The check lives in the two show helpers, not in the tabs.** Local folder, GitHub (clone
  and add existing) and New all call `finishAddProject()` and then one of the helpers, so
  the flag covers every tab without touching them. `finishAddProject` leaves `stay`
  alone, so the helpers still see it right after the dialog closes.
- **A workspace added from the Local folder tab stays put too.** The welcome page case is
  the same whether the folder becomes a project or a workspace.
- No daemon change: the intent already tells the GUI who asked.

## Verification

- Vitest `stores/addProject.test.ts`: with `stay`, a local add (existing project or one
  arriving later on the event stream) never calls `showWorktreeOnProjectsPage`, and a
  workspace never calls `showWorkspaceCard`; without it, both still do. `views.test.ts`:
  ShowView `project.add` sets `stay`.
- Playwright `e2e/page-verbs.spec.ts`: with a thread selected, the intent opens the
  dialog, a Local folder add registers the project, and the thread stays selected and
  shown (no Projects page, no worktree surface). It fails with the option removed.
