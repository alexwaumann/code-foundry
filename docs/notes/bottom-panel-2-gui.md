# Bottom panel, PR B: the GUI (2026-10-11)

A bottom terminal panel under the content pane, for a thread (`session:<id>`) and the
Projects page (`view:projects`). It builds on PR A's daemon contract
(`bottom-panel-1-daemon.md`: owner labels, `terminal.close`, `view.bottom.toggle`, the
shell reaper). PR C removes the sidebar's Terminals section and the `terminal` selection
kind; this PR leaves both alone.

Status: `make check` green (Go packages all ok; 83 vitest files / 1603 tests). `make
gui-e2e`: 518 tests (259 per browser), 20 skipped. The full run had 9 failures. Six were
`ENOENT` on trace zips, because a parallel Playwright run in the same directory wiped
`test-results/`. One was `create.spec.ts:246`, fixed here (below). Two were timing. Rerun
alone, all nine pass on both browsers except `zoom-popovers.spec.ts:74` on Chromium (a
row's context menu at 125% zoom). That one fails the same way on
`t3code/bottom-panel-1-daemon` (checked in a temporary worktree), so it predates this PR.
`e2e/bottom-panel.spec.ts`: 10 tests per browser, all green. The real app was not
screenshotted (see Screenshots).

## Pieces

| File | Role |
|---|---|
| `stores/bottomPanel.ts` | Per-key state (`byKey`: `open`, `height?`, `activeTerminalId?`), persisted as `code-foundry.bottom`; `pendingFocus` (by key) and `pendingFocusId` (by shell), not persisted. `neighbourOf`, `bottomVisible`, `focusedBottomShell`. Pure: `bottomKeyOf`, `ownerKeyOf`, `bottomTabIds` (the tab derivation), `activeTabOf`, `bottomTabTitle`, reducers `setOpen`/`setHeight`/`activate`/`openOn`. Hooks: `useCurrentBottomKey`, `useBottomOpen`, `useBottomHeight`, `useBottomTabIds` (`useShallow`), `useBottomActiveId` |
| `stores/bottomActions.ts` | What touches the daemon or other stores: `paneContext`, `newBottomTerminal` ("+", empty state), `newThreadTerminal` (row menu), `newWorktreeTerminal` (Projects rows), `markTerminalNewFromHere` (cmd+t, palette), `closeBottomTerminal` (`terminal.close --id`), `revealShell` (focusTerminal), `onNewTerminal` (new shell event), `onRemovedTerminal` (neighbour activation) |
| `lib/termlabel.ts` | `KIND_LABEL`, `REPO_LABEL`, `KIND_SHELL`, `isShellLabels` (the label contract beyond `lib/tree.ts`'s two) |
| `stores/ui.ts` | `FocusRegion` `"bottom"`, `bottomFocusSeq` (closePalette bumps it for `returnTo: "bottom"`), `BOTTOM_MIN` 120 / `BOTTOM_DEFAULT` 280 / `BOTTOM_MAX_FRACTION` 0.7, `bottomMax(column)`, `clampBottomHeight` |
| `stores/views.ts` | `toggleBottomCommand` and `showView("bottom.toggle")` |
| `keys/bindings.ts` | Presenters: `view.bottom.toggle` (window-local, like `view.panel.toggle`), and `terminal.new`, which marks the pending focus and returns false so the command still runs |
| `stores/events.ts` | The terminal handler calls `onNewTerminal` for a terminal the (loaded) store did not have |
| `stores/intents.ts` | `focusTerminal` tries `revealShell` first |
| `components/terminal/TerminalHost.tsx` | The xterm host factored out of `TerminalPane`: renderer + `AttachController` + ResizeObserver fit + overlays; `ref.focus()`; `terminalId: null` detaches; dev hook `window.__cfTerminals[name]` (`main`, `bottom`), `__cfTerminal` still the main one |
| `components/terminal/TerminalPane.tsx` | Header + `<TerminalHost name="main">`; keeps its focus effect (and the expanded side panel redirect). `BottomToggle` left of `PanelToggle` for a thread |
| `components/bottom/BottomPanel.tsx` | Always mounted (answers `bottomFocusSeq`); renders the pane, the tab strip, "+", the close button, the empty state, and one `<TerminalHost name="bottom">` |
| `components/bottom/BottomResizeHandle.tsx` | The 8px separator above the pane: pointer drag (up grows), Up/Down (Shift x4), Home/End, double-click resets |
| `components/bottom/BottomToggle.tsx` | `CommandButton` for `view.bottom.toggle` (`PanelBottom`, `aria-pressed` while open) |
| `components/bottom/keys.ts` | Pure: `bottomKeyAction` (cmd+w), `tabFocusIndex` (Left/Right/Home/End) |
| `App.tsx` | `ContentColumn` (content pane + bottom panel, measured height), `regionOf` knows `"bottom"` |
| `SessionParts.tsx`, `ProjectsPage.tsx` | `BottomToggle` left of `PanelToggle` |
| `HelpOverlay.tsx` | "⌘W Bottom panel: close the active terminal (hides an empty panel)" |
| `api/errors.ts` | `isNotFound` |
| `mock/world.ts` | `terminal.close` takes `--id` (default: the active terminal), like the daemon |

## Decisions

* **Keys.** `bottomKeyOf(sel)` is `keyOf(sel)` (stores/panel.ts) when that is
  `session:<id>` or `view:projects`, else null. The side panel and the bottom panel of a
  selection share the key string, which `revealShell` uses to leave a full-width side panel.
* **Tabs are derived.** `bottomTabIds(terminals, key)`: terminals with `kind=shell` whose
  `ownerKeyOf` is the key (`session` label → `session:<id>`, none → `view:projects`), in the
  terminals store's order. The store keeps no tab list. A stored `activeTerminalId` that is
  no longer a tab falls back to the last tab, so a closed or reaped shell needs no cleanup,
  and after a daemon restart an open panel comes back open and empty.
* **Titles.** A thread's tab: the OSC title, else the cwd's last segment (`terminalLabel`
  did not fit: it falls back to the program name). The Projects page's tab: the worktree's
  folder name, always, because shells of many worktrees share the strip. The tab's tooltip
  is the full cwd (tildified). The title alone cannot show it.
* **Layout.** `ContentColumn` (`m-2`, `min-width: 360`) holds the content pane (`flex-1`)
  and the bottom wrapper (`mt-2`, fixed height, same width). The side panel keeps the full
  height on the right. The column, not the content pane, is hidden (`display: none`) while
  the side panel is expanded. The content pane's box is otherwise unchanged, so the side
  panel and layout e2e geometry still holds. The bottom header is 36px (`h-9`). It is not
  in the title band, so it does not need to match the 44px headers, and it is `no-drag`.
* **Height.** Stored per key (absent = 280), clamped to [120, 70% of the column] when set.
  Rendering takes `min(stored, bottomMax(column))`, so it re-clamps at render, not in
  storage, like the side panel's width. The column height comes from a ResizeObserver in
  `App.tsx` and is divided by the page zoom (layout px). Pointer deltas are divided too.
* **Visibility.** The panel renders only when the key exists, its panel is open, no
  settings or usage page is up, and the side panel is not expanded. Hidden means unmounted:
  its Attach stream ends.
* **One host.** The bottom panel has one `TerminalHost` for all its tabs. A tab switch
  re-attaches the same xterm (the old stream aborts first), and so does a key switch. A
  resize refits. With no tabs, the host is `display: none` and detached, and the empty
  state shows. So the GUI holds at most two Attach streams: main and bottom.
* **Toggle.** `toggleBottomCommand` copies `togglePanelCommand`: showing it focuses the
  panel (the active xterm, else the `<aside>`), hiding it from the panel hands focus to
  the content pane, and with the palette open, `returnTo` moves. It is a no-op without a
  key, under settings or usage, and also while the side panel is expanded (an addition:
  the panel cannot show there, so a toggle would flip state nobody sees). It is
  window-local through the presenter. The CLI reaches every window through
  `ShowView "bottom.toggle"`. The X at the strip's right end is the same command.
* **cmd+w.** Handled in the `<aside>`'s capture phase (`onKeyDownCapture`). React's root
  capture listener runs before xterm's own textarea listener, so xterm never sees the
  chord, and the window-level handler does not claim it (cmd+w is reserved, not bound).
  With an active tab it runs `terminal.close --id <id>` (no confirmation). With none it
  hides the panel and focuses the content pane. A tab's × and a middle click do the
  same close.
* **terminal.close context.** Availability is evaluated on the context, and the daemon's
  `id` arg overrides `ActiveTerminalID` there, but the mock evaluates `when` on the raw
  context. So the GUI sends both: args `{ id }` and the context with `activeTerminalId` set
  to the shell. Errors: NotFound is ignored, and so is any error once the terminal is gone
  from the store. A reaped shell makes the daemon's `IsShell` false, which surfaces as
  FailedPrecondition, not NotFound.
* **New shells.** In the events handler, an `updated` event for an id the loaded store did
  not have, with `kind=shell` and not exited, opens the owner key's panel with it active
  (`openOn`), whether or not that key is selected. The reconnect's List and the Watch
  snapshot do not count (they bring known terminals, or arrive while `loaded` is false).
  Focus: see "Review fixes" (by id for the window's own runs, by key for the chord and
  palette).
* **focusTerminal.** For a known shell, `revealShell` selects the owner (the thread, or the
  Projects page), closes settings or usage, takes the owner's side panel out of full
  width, opens the bottom panel on the shell, and focuses it. An unknown id is remembered
  and revealed when it arrives as a new shell. The old path (select the terminal or its
  session) still runs for it meanwhile, and for every other terminal. Neither the daemon's
  nor (since the review fixes) the mock's `terminal.new` emits focusTerminal.
* **Projects page "+".** The page's selection context has no worktree, so `terminal.new`
  is unavailable there. "+" runs it in the active tab's worktree (`paneContext`), so it
  starts a shell beside the active one. With no tabs there is nothing to own one: no "+",
  and the empty state points at the page's rows ("Start one with New terminal on a project
  or worktree row."). cmd+t does nothing on the Projects page, as before.
* **Empty state.** "No terminals" with one row like the side panel's surface list: icon,
  the command's title, and its first keybinding as a chip (⌘T unless rebound). It is a
  plain button that runs `newBottomTerminal`. A `CommandButton` takes its availability
  from the selection's context, which is wrong on the Projects page and cannot carry a
  chip. It runs the same registry command.
* **Help.** "⌘W Bottom panel: close the active terminal (hides an empty panel)" is in the
  overlay's local list next to the side panel's. ⌘J is listed under View as "Toggle Bottom
  Panel", from the registry, the way ⌘⇧E (Toggle Side Panel) is. A second hand-written
  row would duplicate it.
* **No drag reorder**, no tab persistence beyond the active id, and no pruning of entries
  for gone threads (a few bytes each, as with the side panel).

## Gotchas

* **StrictMode remounts the new host.** The bottom panel's focus request comes in the
  commit that mounts its `TerminalHost`. In dev, StrictMode then replays the host's effects
  (dispose the renderer, create another) but not the panel's, so focus went to a removed
  textarea and ended on `<body>` without a focusout. `TerminalHost` now notes in its
  cleanup whether its renderer had focus, and the next renderer takes it. Production does
  not replay effects. The main pane never hit this, because its focus effect has no
  "handled" guard and runs again.
* **The column's ref is not attached when a child's layout effect runs** (children's
  layout effects run before the parent's ref is attached), so `BottomPanel` could not
  measure `columnRef`. It measured 0 and clamped every panel to 120. The column measures
  itself and passes `columnHeight` down.
* `e2e/panel.spec.ts` checked the content pane's own `display: none` under an expanded
  side panel. It now checks the column's.
* `e2e/create.spec.ts:246` relied on a Projects row's new terminal being selected in the
  content pane (that gave the palette the project's context). It opens in the bottom panel
  now, so the test selects it through its sidebar row. PR C, which removes that row,
  will need another way to give the palette a project context.
* Do not run a second Playwright invocation from `gui/frontend` while `make gui-e2e` runs:
  both write `test-results/`, and the first run's traces vanish (`ENOENT` failures).
* `e2e/app.spec.ts`'s focusTerminal test used `t-top`, which is now a worktree shell and
  opens on the Projects page. It uses `t-tmp` for the selection path and `t-top` for the
  bottom panel.

## Tests

* `stores/bottomPanel.test.ts`: tables for `bottomKeyOf`, `ownerKeyOf`, `bottomTabIds` (the
  derivation: store order, Claude terminal excluded, Projects = every unowned shell),
  `activeTabOf`, `bottomTabTitle`; the reducers; `toggleBottom` focus and no-key no-op;
  per-key height; `takePendingFocus` (key, once, 10s); the persist round trip (no
  `pendingFocus`).
* `stores/bottomActions.test.ts`: `onNewTerminal` (owner key, not selected, ignored kinds,
  a focus table, used once, the palette's `returnTo`), `revealShell` (thread, Projects,
  not a shell, unknown then arriving), `paneContext`/`newBottomTerminal`, and
  `closeBottomTerminal` (args and context; a table for NotFound, gone, and other errors).
* `stores/views.test.ts`: `toggleBottomCommand` (focus both ways; a no-op table: dashboard,
  PR page, loose terminal, settings, usage, expanded side panel; the Projects page's own
  key; a palette `returnTo` table; `showView("bottom.toggle")`).
* `stores/ui.test.ts`: `bottomMax`/`clampBottomHeight` tables, `closePalette` → `"bottom"`.
* `components/bottom/keys.test.ts`: `bottomKeyAction`, `tabFocusIndex` tables.
* `e2e/bottom-panel.spec.ts` (10 per browser): the header toggle and cmd+j (geometry: same
  width as the content pane, 8px gaps, 280 high, no-drag header; focus moves in and back;
  the close button; no daemon round trip); the palette returning to the bottom panel, and
  a per-thread panel; the empty state and "+" starting focused shells for the thread,
  and cmd+t from the bottom terminal; the disconnected page's toggle; cmd+w and × through
  `terminal.close --id`, the empty panel, and cmd+w hiding it; the resize handle (aria
  values, keys, a drag, per key, persisted across a reload, double-click reset); hidden on
  the dashboard, the PR page, settings, and under an expanded side panel (Attach count
  drops); the Projects page (worktree shell titled by folder, "+" in the active tab's
  worktree, a row's New terminal here lands there); new shells auto-open and activate
  without taking focus (selected or not); the Attach budget (2 with the panel open, still
  2 across tab switches, 1 when hidden) and the strip's arrow keys.
* Updated: `app.spec.ts` (focusTerminal), `buttons.spec.ts` (the palette's New Terminal
  lands in the bottom panel), `panel.spec.ts` (the column is what hides), `create.spec.ts`.

## Screenshots

WebKit against the mock daemon, 1440x900 at 2x, in `docs/notes/bottom-panel-2-gui/`:
`thread-dark.png`, `thread-light.png` (s-1 with two shells, the second active),
`projects-dark.png`, `projects-light.png` (the Projects page's panel on `t-top`),
`empty-dark.png` (a thread's empty panel). The copies in `/Users/alex/.t3/userdata/attachments/`
carry a `bottom-panel-2-` prefix. Taken before the review fixes, which change nothing
visible apart from "+" being a Tab stop.

Not the real app. The plan was `make gui-build`, then an isolated copy
(`CODE_FOUNDRY_HOME=/tmp/bp2`) with a scratch repo, a haiku thread and two shells (all set
up and working: the shells opened the thread's panel, and `ui.focus.terminal` revealed
one). But the Mac's screen was locked for the whole session
(`CGSSessionScreenIsLocked = true`, `loginwindow` in front). The WKWebView never painted,
and `screencapture -l <window id>` returned an empty window. Without Accessibility
permission, `osascript` cannot raise or read the window, so the window id came from
`CGWindowListCopyWindowInfo` (a small Swift script). That part works for next time.

## Review fixes

Status: `make check` green (Go packages all ok; 84 vitest files / 1641 tests).
`make gui-e2e` (full suite, both browsers, nothing else running): 528 tests, 508 passed,
20 skipped, 0 failed. `e2e/bottom-panel.spec.ts` is 15 tests per browser. The
`zoom-popovers.spec.ts:74` Chromium failure noted above passed in this run. It also failed
on the base branch, so it is flaky, not broken by this PR.

| Finding | Change |
|---|---|
| Expand from the bottom shell left focus on `<body>` | `expandPanelCommand` counts `"bottom"` as content (expanding hides the column): focus, or the palette's return, goes to the side panel |
| A foreign shell stole the keyboard | `onNewTerminal`: a shell this window did not start, for the panel that is showing while the keyboard (or the palette's return) is in it, only gets its tab. The tab that was active is pinned (with none remembered, the last tab is active, and the new one is last). Otherwise it still becomes active |
| The resize handle was outside the region | `data-region="bottom"` and the capture-phase cmd+w handler moved to the wrapper, which holds the handle and the `<aside>`. cmd+j, cmd+w and the palette's return work from the handle |
| Pending focus by key could focus someone else's shell | The window's own runs ("+", empty state, row menu, Projects rows) use `runCommandForResult` and read the id from the result JSON (`terminalIdFromResult`, api/terminal.ts). A shell that already arrived is activated and focused at once. Otherwise `pendingFocusId` waits for that id (10s). A failed run leaves nothing pending. The key match stays only for the `terminal.new` presenter (chord, palette, CommandButton), still capped at 10s. The mock's `terminal.new` now returns the terminal as result JSON and no longer emits focusTerminal, like the daemon |
| One unclamped frame after the side panel collapses | `useColumnHeight(ref, hidden)` measures again in its layout effect when `hidden` flips, before paint |
| A thread's terminal switch (reconnect) pulled focus out of the bottom shell | TerminalPane's focus effect skips a run caused only by `terminalId` while `ui.focus === "bottom"`. Explicit requests (`terminalFocusSeq`, `contentFocusSeq`) still focus it |
| Close Terminal in the palette hit the Claude terminal | `focusedBottomShell` (stores/bottomPanel.ts): with the keyboard (or the palette's return) in the open bottom panel, its active shell is `activeTerminalId` in `getUiContext()` (`deriveContext`'s new `focusedShell` argument). Session, repo and worktree are unchanged. An explicit selection (`getUiContext(sel)`) is not affected |
| The bottom panel could squeeze the content pane | `bottomMax` = max(120, min(70% of the column, column − 160 − 8)): the content pane keeps 160px above the gap |
| Nits | "+" and the empty state's button show exactly when `paneContext(key)` is non-null. One `bottomVisible(key, open, pageOpen, sideExpanded)` rule serves BottomPanel, `visibleBottomKey` (stores/views.ts) and `toggleBottomCommand`. A removed shell that was its panel's active tab hands that to the tab after it, else the one before (`onRemovedTerminal` from the events handler, so closes, reaps and exits all do). "+" is a Tab stop and in the strip's arrow keys. The screenshot names are fixed. CLAUDE.md says the visible terminal and the visible bottom shell are attached |

Tests added: `stores/context.test.ts` (new), and rows in `bottomPanel.test.ts`
(`neighbourOf`, `bottomVisible`, `focusedBottomShell`, `takePendingFocusId`),
`bottomActions.test.ts` (by-id focus: arrives after or before the result, another
thread, failure; foreign shells; `onRemovedTerminal`), `views.test.ts` (expand from the
bottom panel), and `ui.test.ts` (the 160px rule). e2e: a foreign shell while typing (the
keys go to the active shell), expanding the side panel from the bottom shell, switching
between two threads with open panels (two streams, focus), cmd+j from the handle, and
the Usage page.

## Not done

* PR C: the sidebar's Terminals section and the `terminal` selection kind are untouched.
  Worktree shells still list there, and clicking one opens it in the content pane.
* No drag reorder of tabs (not asked for).
