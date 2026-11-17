# Plugin surfaces in a pane's "+" menu

A pane's "+" listed This thread ▸, New thread, Terminal, Pull Requests and Projects. Plugin
surfaces were reachable only from the palette (and a thread's from its show command). This step
lists them in the menu, in the agreed layout ("flat, under a label").

## What it does

- After Projects: a separator, a quiet "Plugins" label (the "This thread" label's style), then
  one row per plugin surface of no thread (scope global, project or worktree): the manifest's
  icon and title, the plugin's display name muted at the right end. A pick runs the surface's
  show command with `--pane`, so the tab opens in this pane.
- A thread's surface (scope thread or pr) is listed in the thread's surfaces instead
  (`ThreadSurfaceItems`), after its diffs and pull requests, run with that thread as its context.
  `ThreadSurfaceItems` also draws the thread header's Open ▸ and the sidebar row's Open ▸, so
  they list a thread's plugin surfaces too (without a pane: placed by the rules). One already
  open in the space is marked "open" after the plugin's name and focused where it is, as Diff and
  PR rows are.
- Only surfaces whose show command is available are listed: the daemon evaluates the when
  clause, the GUI follows its command list. No label and no separator when none is. A pane of
  terminals with no room for another kind of tab lists none, like the other non-terminal items.

## Decisions

- **The show command takes `--pane`.** It is the one way to open a surface (every user action is
  a command). With `--pane` and a layout, any surface opens through the layout's `open_surface`
  in that pane: linked to the thread for a thread's surface, unlinked for the others (the same
  identity the window gives a surface it opens for a page or the composer). Without `--pane`
  nothing changed: a thread's surface is placed by the rules, the others go to the windows as a
  ShowView. `plugin.TabOpener.OpenTab` gained the pane.
- **Availability for a thread that is not the window's.** The commands store is listed for the
  window's context. The "+" of a pane whose thread is not the focused one (and a sidebar row's
  menu) asks the daemon for that thread's command list once (`listCommands` with the thread's
  context), and again after a plugin availability epoch; only when some plugin has a thread's
  surface at all.
- **Settings-placement surfaces** are listed like the others when their show command is
  available. The GUI does not read placements yet; the palette lists them the same way.

## Tests

- Go: `internal/store/plugin/show_pane_test.go`, a thread's and a global surface's show with
  `--pane` open in that pane, the second call finding the open tab.
- vitest: `components/shell/plusPlugins.test.tsx`, the menu's contents and the verb and args of
  each pick, the empty case, the terminals-only pane, the open mark and the thread list fetched
  for a pane that is not the focused one.
- e2e: `e2e/plus-plugins.spec.ts`, a pick through the mock daemon's layout lands as a tab in that
  pane (and SHOTS for the PR).
- The mock's test-watcher plugin has a global surface, "Test runs", for the menu to list; the
  mock's show commands take `--pane` like the daemon's.

## Gotchas

- Run end to end on a scratch daemon, `plugin dev` refuses a folder outside the home directory,
  and the daemon's socket path must stay under 104 bytes, so its home cannot sit deep in a temp
  folder.
- A SHOTS spec that opens one menu after another waits for the first to leave the DOM: Radix keeps
  a closing menu mounted for its animation, and two `pane-plus-menu`s fail a strict locator.
