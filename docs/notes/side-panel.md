# Side panel ("surface panel")

A second pane right of the content pane, modeled on T3 Code's right panel. Each
selection has its own panel. Later chunks add surfaces (the Pull request surface first)
and extend this note.

## Chunk 1: the shell

Status: `make check` green (26 vitest files / 347 tests). `make gui-e2e` passes 136/136
(68 WebKit, 68 Chromium), including `e2e/panel.spec.ts` (6 tests per browser).
Screenshots (WebKit, dark, 1400x900, mock daemon): `/tmp/cf-shots/chunk1-empty-panel.png`
and `/tmp/cf-shots/chunk1-hidden.png`. Not run in the real Wails window.

### Pieces

| File | Role |
|---|---|
| `stores/panel.ts` | Per-selection state (`byKey`), pure reducers, `openSurface`/`togglePanel` API |
| `stores/ui.ts` | `panelWidth` (global, persisted in `partialize`), `PANEL_MIN` 280, `panelMax` (60% of the window), `FocusRegion` `"panel"` |
| `surfaces/types.ts`, `surfaces/registry.ts` | `SurfaceSpec` and the ordered list, with `surfaceOf`, `surfaceByHotkey`, `listedSurfaces` |
| `surfaces/files.ts`, `diff.ts`, `pullrequest.ts` | One spec per file. All three are `"disabled"` for now. `Placeholder.tsx` is their body |
| `components/panel/SidePanel.tsx` | Pane, tab strip, body via the registry, and the empty "Open a surface" list |
| `components/panel/keys.ts` | `panelKeyAction`, a pure function: cmd+w closes the active tab, and a bare letter opens an enabled surface |
| `components/panel/PanelResizeHandle.tsx` | Same pattern as the sidebar's `ResizeHandle`, mirrored. Double-click resets to 420 |
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
  selection. The command is always available. With nothing selected it does nothing.
* **Chord cmd+shift+e** was free in Go, the mock and `viewActions`. It is a registry
  keybinding, so a focused terminal yields it (`terminalYields`), and it works from the
  terminal.
* **Settings hides the panel.** While `settingsOpen` is set, `SidePanel` renders nothing.
  Closing settings brings back the underlying selection's panel unchanged. This was
  simpler than placing the settings page beside a panel that has no toggle in the
  settings header.
* **Focus.** Toggling on bumps `focusSeq`, and the panel (`tabIndex=-1`,
  `data-region="panel"`) focuses itself, so F/D/P and cmd+w work at once. The
  handled sequence number is tracked at module level, because the panel mounts on the
  same toggle that requests focus. A remount from a selection switch does not steal
  focus. Hiding the panel while it has focus, by toggle or by closing its last tab, bumps
  `terminalFocusSeq` so the terminal takes focus back.
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
  list, as in T3. Tabs: icon, truncated title, × visible on hover or when active,
  middle-click closes, and the strip scrolls horizontally with the scrollbar hidden.
* **Width bounds.** The setter clamps to [280, 60% of `window.innerWidth`]. The wrapper
  also has `min-width: 280px; max-width: 60vw`, so a window that shrinks after a drag
  never leaves the panel wider than 60%.
* **Layout.** The panel wrapper is `relative mr-2 mb-2` and not clipped. The resize handle
  sits absolutely in the 8px gap (`-left-2 w-2`). The inner `<aside>` carries the pane
  styling and `overflow-hidden`. The content pane keeps `mx-2`, so the gap is its right
  margin. With the panel hidden, the layout is the same as before.

### Extension points for later chunks

* A new surface means a file exporting a `SurfaceSpec` plus one line in
  `surfaces/registry.ts`. Add its kind to `SurfaceKind` in `stores/panel.ts`.
* `pullRequestSurface.available` should derive enabled/hidden from the selection's
  worktree branch PR. `openDefault` should return
  `makeTab("pullrequest", title, { ...params })`. `render` should mount the real view.
* To open from elsewhere (e.g. a PR row), call `openSurface("current" | key, tab)`. It
  shows the panel, adds or activates the tab, and returns false when nothing is selected.
  It does not request focus.
* `SurfaceContext` carries only `selection` and `panelKey`. Surfaces read other stores
  themselves. `available` is evaluated during render in the empty list, so it must be
  cheap and pure.

### Gotchas

* **cmd+w in the native app is the app menu's Close Window** (`ReservedChords`). The panel
  handles it in a React `onKeyDown` with `preventDefault`. That works in the browser and
  in e2e. Whether WKWebView lets the page's `preventDefault` beat the menu key equivalent
  was **not verified live**. If the window closes instead, we need a different chord or
  a menu-level hook. cmd+w is not a registry binding, so the reserved-chord check does not
  apply.
* In e2e, the settings page focuses its search box, so Escape does not close it. Click the
  heading first (as `settings.spec.ts` does).
* The Playwright e2e cannot open a real tab yet, because every surface is disabled. Tab
  open, close and neighbour activation are covered by the reducer tables in
  `stores/panel.test.ts` and `components/panel/keys.test.ts`.
