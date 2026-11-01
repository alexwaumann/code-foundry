# Projects table 2: context menus and the app's menu style

PR 2 of three on the Projects page (1: the index table, #454; 3: project rename, #452). The
index rows get a right-click menu, the project and workspace pages' ⋯ menus get the same
items, and every menu in the app loses its icons and trailing "…".

## What changed

- **Row context menus** (`components/projects/RowContextMenu.tsx`): each index row (a
  `NavRow`) is wrapped in a Radix `ContextMenu` (`modal={false}`, like the sidebar's).
  Opening it puts the list's cursor on the row. The items are built only when it opens.
  As in `OverflowMenu`, keys stay inside the menu, and the picked item runs after the menu
  closes and gives the keyboard back to the list, so a dialog, the palette or an inline
  editor that the item opens keeps its focus.
- **One list per kind** (`components/projects/menus.ts`):
  - `projectMenu`: New thread, New terminal, Open in Finder | Rename, Clean up merged
    worktrees (git with a remote; count at the right, disabled at 0), Publish to GitHub or
    Initialize git | Remove project (destructive).
  - `workspaceMenu`: New thread, New terminal (see below), Open in Finder | Rename, Add
    project | Remove workspace (destructive).
  - The project page's ⋯ is the same list with New action and a separator first. The
    workspace page's ⋯ is the same list as the row's. Both pages keep their header buttons
    for New thread, Terminal and Open in Finder, so those items appear twice there. That is
    the point: the two places agree.
- **Rename in place on the index**: the row's name cell shows `ProjectNameEditor` while
  `stores/projectRename.ts` names the project. For workspaces, `WorkspaceNameEditor` shows
  while the new `stores/workspaceRename.ts` names the workspace. The workspace page used
  local state for its editor before; it now uses the store, so its ⋯ Rename and the row's
  Rename share one flag. A row or page that unmounts closes its own editor.
- **Add project on a workspace** (`stores/workspaceAddProject.ts`): shows the workspace's
  page (when it is not already shown) and opens its Projects card's Add project list. The
  `ComposerPicker` there is now controlled by that store.
- **Open in Finder** on a project: `worktree.reveal` on its main checkout (`revealProject`).
  For a folder without git, that is the folder itself.
- **Menu style, app-wide**: menu items are text. They have no icons and no trailing "…" in
  the sidebar row menu, the thread title menu (`ThreadMenuItems`), Snooze, Ember's row,
  the PR panel's ⋯ and Review menus, the thread info card's menus, the checkouts and
  workspace-thread ⋯ menus, the page picker's Add project, and the Actions menus. `OverflowItem.icon`
  is gone. Destructive items stay red through the item variant. The PR menu's spinner on
  Explain and Fix now sits at the item's right while it is busy (`Item busy`); Refresh
  already says "Refreshing…" in its hint.
- **What keeps an icon**: an icon stays only when it is the option itself, not decoration
  on a verb. That covers a user-chosen action icon (Actions menus, Details' Edit), an app's
  real icon in the thread card's Open in list (macOS's Open With does the same), a
  project's kind or the workspace mark in a picker (the page picker, Run in), GitHub owner
  kinds in the publish picker, and check marks (state). Buttons, tooltips, aria-labels and
  dialog titles outside menus are untouched (for example the leftover rows' "Remove…"
  button and the project page's Publish button).

## Decisions and gotchas

- **A workspace's New terminal**: a shell needs a thread or a registered worktree to own it
  (`terminal.new`'s `shellOwner`), and a workspace folder is neither. The shell starts in
  the folder (`workspaceFolder`: the root, else the managed folder) through `--cwd`. It is
  owned by the first registered member's main checkout (`workspaceTerminalPlace`), so it
  lands in the Projects page's bottom panel. The item is left out when the workspace has
  no folder or no registered member. This needs no daemon change.
- **Test ids**: the workspace items are `workspace-menu-*` in both menus (the page used
  `workspace-page-rename` / `-remove` before). The project items keep their ids
  (`project-menu-rename`, `project-cleanup`, `project-unregister`, …); the new ones are
  `project-menu-new-thread`, `-new-terminal`, `-reveal`. The menus are
  `project-row-menu` / `workspace-row-menu`.
- `NavRow` does not forward props, so the context menu trigger is a plain `div` around it
  (`ContextMenuTrigger asChild`). The listbox's options sit one level deeper, which ARIA
  allows (a generic wrapper).
- `NameEditor` already stops clicks and keys, so typing in a row's field neither opens the
  row's page nor moves the list's cursor.

## Tests

- `components/projects/menus.test.ts`: the items per kind and order, New action first on
  the page, disabled/destructive, what Rename, Add project, Clean up and Remove do, and
  that no label ends in an ellipsis. `stores/workspaceActions.test.ts`:
  `workspaceTerminalPlace`.
- `e2e/projects-context-menus.spec.ts`: right-clicking each project kind and a workspace,
  text-only menus, Rename in place (refused name, Escape, Enter), Remove through the
  confirm, the workspace's New terminal and Add project, and a workspace whose only member
  is unregistered (no New terminal; the page's ⋯ agrees).
- Updated: specs and unit tests that read "Remove…", "Run in…", "Rename…", "New action…",
  "Add project…", "Pick a date and time…" and "Remove worktree…" in menus, and the
  RowMenu test that asserted the Hide from sidebar icon.

## Restart

Frontend only. No daemon restart is needed.
