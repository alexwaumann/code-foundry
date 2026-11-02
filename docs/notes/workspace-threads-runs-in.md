# Workspace Threads: Runs in + split Open in

A workspace page's Threads table gets a **Runs in** column (between Thread and Changes): where
the thread's cwd is, its primary project's checkout (the project's kind icon and name) or, with
no primary, the workspace's own folder (Layers, "workspace folder"). It drops below 720px of
table (`RUNS_IN_BELOW`); the row menu still opens the same place.

The row ⋯'s **Open in Finder** is now the split item the page ⋯ has (OpenInMenuItem.tsx,
`menu="dropdown"`): a click reveals, its › lists Finder, the installed editors (real icons)
and Terminal. The target is the Runs in place: `checkoutOpenIn(primary, cwd)` (worktree.reveal,
worktree.open.editor, a terminal on the checkout) or `workspaceOpenIn(workspace, terminal)`
(workspace.reveal, workspace.open.editor, the workspace's New terminal when it has a place).

## Decisions

- One rule for the place, `lib/workspacePage.ts threadPlace`: a primary means its checkout
  (null until the checkout exists), no primary means the workspace folder. It is what the old
  Open in Finder item did, now shared by the column and the menu.
- The split item is a `kind` entry of the row's OverflowMenu (`THREAD_MENU_PARTS`), like
  workspaceMenu's; no new command (#481 added workspace.open.editor). Frontend only, no
  daemon restart.
- A checkout's Terminal goes through the worktree context (newWorktreeTerminal), not a cwd arg:
  the test asserts the context.
