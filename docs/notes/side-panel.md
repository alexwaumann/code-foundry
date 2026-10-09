# Side panel ("surface panel")

A second pane right of the content pane, modeled on T3 Code's right panel. Each
selection has its own panel. Later chunks add surfaces (the Pull request surface first)
and extend this note.

## Chunk 1: the shell

Status: `make check` green (26 vitest files / 347 tests). `make gui-e2e` passes 136/136
(68 WebKit, 68 Chromium), including `e2e/panel.spec.ts` (6 tests per browser).

Review fixes (after `ae93059`): `make check` green (29 vitest files / 369 tests).
`make gui-e2e` passes 156/156, with `e2e/panel.spec.ts` at 16 tests per browser. Each new
e2e was checked to fail with its fix reverted. Covered: cmd+w quitting the app; the panel
ignoring the sidebar; drag after a shrink; focus after the palette and after hiding on
terminal-less pages; toggling under Settings; the unkeyed tab body; non-reactive
availability; tab and separator keyboard access; the mock's command description. Not
run in the real Wails window: the menu change is verified by reading Wails' role code
(`roles.go`: on darwin the `FileMenu` role is just Close Window, and the `WindowMenu` role
has no close item).
Screenshots (WebKit, dark, 1400x900, mock daemon): `/tmp/cf-shots/chunk1-empty-panel.png`
and `/tmp/cf-shots/chunk1-hidden.png`. Not run in the real Wails window.

### Pieces

| File | Role |
|---|---|
| `stores/panel.ts` | Per-selection state (`byKey`), pure reducers, `openSurface`/`togglePanel` API |
| `stores/ui.ts` | `panelWidth` (global, persisted in `partialize`), `PANEL_MIN` 280, `panelMax(window, sidebar)`, `windowWidth`, `FocusRegion` `"panel"`, `panelFocusSeq`, `contentFocusSeq` |
| `stores/views.ts` | `togglePanelCommand` (view.panel.toggle): settings guard and focus moves |
| `surfaces/types.ts`, `surfaces/registry.ts` | `SurfaceSpec` and the ordered list, with `surfaceOf`, `surfaceByHotkey`, `useAvailability` |
| `surfaces/files.ts`, `diff.ts`, `pullrequest.ts` | One spec per file. All three are `"disabled"` for now. `Placeholder.tsx` is their body |
| `components/panel/SidePanel.tsx` | Pane, tab strip, body via the registry, and the empty "Open a surface" list |
| `components/panel/keys.ts` | `panelKeyAction`, a pure function: cmd+w closes the active tab (or hides an empty panel), and a bare letter opens an enabled surface |
| `components/panel/PanelResizeHandle.tsx` | Same pattern as the sidebar's `ResizeHandle`, mirrored. Double-click resets to 420. Focusable, arrow keys resize |
| `components/panel/PanelToggle.tsx` | `CommandButton` for `view.panel.toggle`, `aria-pressed` while open |
| `internal/command/commands_view.go` | `view.panel.toggle` (cmd+shift+e), emits `UiIntent.ShowView{name: "panel.toggle"}` |

### Decisions

* **Keys.** `keyOf(selection)` gives `session:<id>`, `terminal:<id>`, `repo:<id>`,
  `worktree:<repoId>:<path>`, and `view:<name>`. `none` gives null: no panel, and toggle is
  a no-op. Tab ids are `kind` plus sorted, URI-encoded params
  (`pullrequest?number=12`), so opening the same thing twice activates the existing tab.
  `openTab` on an existing id refreshes its title.
* **Only the width persists**, in the ui store, as asked. Open state and tabs live in
  memory and reset on reload. Panel state for deleted sessions is never pruned. That is
  harmless at this size (a few bytes per key).
* **Toggle command.** I chose a ShowView name over a new intent: no proto change, and it
  matches `view.settings`/`view.help`. The GUI handles it locally through a presenter in
  `keys/bindings.ts` (no round trip, no toast). The CLI reaches every window through
  `showView("panel.toggle")` in `stores/views.ts`, which toggles that window's current
  selection. The command is always available. With nothing selected, or while the
  settings page is up, it does nothing.
* **Chord cmd+shift+e** was free in Go, the mock and `viewActions`. It is a registry
  keybinding, so a focused terminal yields it (`terminalYields`), and it works from the
  terminal.
* **Settings hides the panel.** While `settingsOpen` is set, `SidePanel` renders nothing.
  Closing settings brings back the underlying selection's panel unchanged. This was
  simpler than placing the settings page beside a panel that has no toggle in the
  settings header. `togglePanelCommand` is a no-op while settings is open (chord, palette
  and CLI alike), so it cannot flip state the user cannot see or leave a focus request
  pending.
* **Focus.** Three counters in the ui store, each answered by whoever shows that region:
  `panelFocusSeq` (the panel), `contentFocusSeq` (the content pane), and the older
  `terminalFocusSeq`/`sidebarFocusSeq`. They live in the ui store, not the panel store,
  so `closePalette` can bump them without an import cycle (`panel.ts` imports `ui.ts`).
  * Toggling on bumps `panelFocusSeq` after the open state changes. `SidePanel`, which
    stays mounted, handles it and focuses the `<aside>` (`tabIndex=-1`,
    `data-region="panel"`), so F/D/P and cmd+w work at once. The handled number is a ref
    in that always-mounted component. A request while no panel shows is dropped, and a
    panel mounted later by a selection switch does not steal focus.
  * Hiding the panel while it has focus (toggle, cmd+w on an empty panel, closing the
    last tab) calls `focusContent()`. `TerminalPane` answers `contentFocusSeq` by focusing
    xterm. Otherwise `ContentPane` (App.tsx) focuses the page's `[data-focus-root]`: the
    PR list, the overview list, the disconnected/missing session section, or the
    welcome section. j/k keep working on pages without a terminal.
  * The palette. While it is open, focus is `"palette"`, so `togglePanelCommand` reads
    and rewrites `palette.returnTo` instead: `"panel"` when the panel opens, and
    `"content"` when the panel it came from hides. `closePalette` now handles
    `returnTo` `"panel"` (bumps `panelFocusSeq`) and `"content"` (bumps
    `contentFocusSeq`). Dismissing the palette that was opened from the panel returns
    to the panel.
* **Toggle button placement.** It goes in each pane header, at the right end, never in
  the title strip (`phase3-ui-panes.md`: keep controls out of the drag band). The
  headers are the terminal/session header (`HeaderActions`), the worktree/repo overview
  header, and the Pull Requests header. The disconnected-session page has no header, so
  the button sits absolutely at its top-right. The welcome dashboard (`none`) has none.
* **Hotkey chips** show in the empty surface list, as in T3. This is a deliberate exception
  to "chords only in the palette and help" (`phase3-ui-buttons.md`). The letters are
  panel-local, not registry chords, the same as `A` on the Pull Requests page. The Help
  overlay lists "⌘W Side panel: close the active tab".
* **Tab strip** renders only when there are tabs. The empty state is just the centred
  list, as in T3. Tabs: icon, truncated title, × visible on hover, keyboard focus, or
  when active, middle-click closes, and the strip scrolls horizontally with the scrollbar
  hidden. Each tab is a wrapper (`role="presentation"`, `data-tab-id`) holding a
  `<button role="tab">` and a sibling close button, so no button is nested in another.
  Roving tabindex: only the active tab and its × are in the Tab order. Left/Right (and
  Home/End) move focus between tabs without activating. Enter/Space activates (native
  button click). The body is `role="tabpanel"`, labelled by the active tab.
* **Width bounds.** `panelMax(window, sidebar) = min(60% of window, window - sidebar (0
  if hidden) - 24px gaps - 360px CONTENT_MIN)`. The setter clamps the stored width to
  [280, max(280, panelMax)]. The ui store tracks `windowWidth` (resize listener in
  `startApp`). A resize re-clamps the stored width, so it can shrink but never grows back
  on its own. The panel renders at `min(stored, panelMax)`. That covers a sidebar
  widened after the panel was sized, which does not re-clamp, so dragging the sidebar back
  and forth does not eat the user's width.
* **No room hides the panel.** When `panelMax < 280` (e.g. 1000px window, 520px sidebar),
  `SidePanel` renders nothing, but the panel stays open in the panel store, and the
  toggle stays pressed. It comes back as soon as there is room (hide the sidebar, widen
  the window). Shrinking below 280 would leave a useless sliver, and xterm on the other
  side would be squeezed to a handful of columns. The content pane has `min-width: 360px`.
  The window has `MinWidth: 900` (gui/main.go), which is just over a 520px sidebar plus a
  360px content pane.
* **Resize handle.** A drag starts from the wrapper's rendered width, not the stored one,
  so it acts at once when the room shrank. `lostpointercapture` ends a drag. The
  separator is focusable, with `aria-valuenow/min/max`. Left widens by 16px (Shift: 64px),
  Right narrows, Home/End go to min/max.
* **Layout.** The panel wrapper is `relative mr-2 mb-2` and not clipped. The resize handle
  sits absolutely in the 8px gap (`-left-2 w-2`). The inner `<aside>` carries the pane
  styling and `overflow-hidden`. The content pane keeps `mx-2`, so the gap is its right
  margin. With the panel hidden, the layout is the same as before.

### Extension points for later chunks

* A new surface means a file exporting a `SurfaceSpec` plus one line in
  `surfaces/registry.ts`. `SurfaceKind` is a plain string, so no store file changes.
* `pullRequestSurface.available` should derive enabled/hidden from the selection's
  worktree branch PR. `openDefault` should return
  `makeTab("pullrequest", title, { ...params })`. `render` should mount the real view.
* To open from elsewhere (e.g. a PR row), call `openSurface("current" | key, tab)`. It
  shows the panel, adds or activates the tab, and returns false when nothing is selected.
  It does not request focus.
* `SurfaceContext` carries only `selection` and `panelKey`. Surfaces read other stores
  themselves with `getState()` in `available`, and list those stores in `watches`.
  Each empty-list row calls `useAvailability(spec, ctx)` (registry.ts), a
  `useSyncExternalStore` over the watched stores whose snapshot is `available(ctx)`. A
  string snapshot means the row re-renders only when the answer changes. Key and click
  handlers call `available` directly, so there is one definition. `available` must stay
  cheap and pure. It runs on every change of a watched store. A hook-per-spec
  (`useAvailable`) was the alternative. I rejected it because it needs a second,
  non-hook copy for the key handler, and the two would drift apart.
* The tab body is mounted under `key={tab.id}`, so two tabs of one kind (two PRs) never
  share component state.

### Gotchas

* **cmd+w and the app menu.** Wails' `FileMenu` role binds Close Window to cmd+w. With
  `ApplicationShouldTerminateAfterLastWindowClosed`, any cmd+w the page left unhandled
  (no panel focus, an empty panel, a text field) closed the only window and quit the
  app. `appMenu` (gui/app.go) now builds the File menu by hand. Its Close Window has no
  key equivalent. The red traffic light still closes the window. cmd+w stays in
  `ReservedChords` (and the settings validator's `menuChords`), now as the side panel's
  chord, so no command can bind it. In the panel, cmd+w is handled in text fields too,
  and on an empty panel it hides the panel, so it is always handled while the panel has
  focus. Outside the panel cmd+w now does nothing.
* In e2e, the settings page focuses its search box, so Escape does not close it. Click the
  heading first (as `settings.spec.ts` does).
* Every surface is still disabled, so e2e injects tabs through the app's own store
  instance. `page.evaluate('import("/src/stores/panel.ts").then(m => m.openSurface("current", m.makeTab("files", "Files")))')`
  reaches the module Vite serves to the app (`injectTab` in `e2e/panel.spec.ts`).
* A capture-phase window listener cannot read `defaultPrevented` at dispatch time, and a
  bubbling one never sees the event, because the panel stops propagation. The e2e reads
  it in a `setTimeout` from a capture listener (`recordCmdW`).
* WebKit does not focus a `<button>` on click. The click focuses the nearest focusable
  ancestor, which is the `<aside>`, so "had focus" checks see `"panel"` in both engines.
