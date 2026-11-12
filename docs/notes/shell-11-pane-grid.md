# Shell PR 11: the pane grid with tab strips and focus, behind the shell flag

Eleventh PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on
(`localStorage["code-foundry.shell"]="1"` or `?shell=1`), the window's content area is the current
space's pane grid; with it off nothing changes. The sidebar is still the classic one.

## What is in it

| File | Holds |
| --- | --- |
| `components/shell/Shell.tsx` | the root: waits for the layout snapshot, falls back to the classic window after 5 s with one toast (an older daemon), starts the selection bridge |
| `components/shell/PaneGrid.tsx` | the current space's tree laid out with `frameRects` (rails off), panes absolutely placed, gutters, the drag preview, `reportViewport`, the frame into `shellView` |
| `components/shell/PaneView.tsx` | one pane: strip, then only the active tab's body under `key={tab.id}`; focus by press or keyboard Tab; focus requests |
| `components/shell/PaneTabStrip.tsx` | the strip: tabs named by their surface, `fitTabs` on measured natural widths, close by × or middle click, arrow keys between tabs |
| `components/shell/Gutter.tsx` | a 12px gap that drags (pointer capture); `fixed` gutters draw nothing |
| `components/shell/EmptySpace.tsx`, `ComposeTab.tsx` | the home composer of a space with no pane; a compose tab's composer |
| `shell/surfaces/*` | the shell's surface registry: `thread`, `compose`, `prs`, `projects`, and `file`, `diff`, `pullrequest`, `mcp`, `gallery`, `ember.board` and `plugin.*` wrapping the side panel's `SurfaceSpec.render`; unknown kinds draw a placeholder |
| `shell/hostShell.ts`, `shell/host.ts` | the seam's shell half and its dispatch |
| `shell/kinds.ts`, `shell/domIds.ts`, `shell/paneContext.ts` | kind names between layout and panel; DOM ids; the pane a surface is in |
| `shell/composerTab.ts` | the composer tab a send comes from, for `thread.new --compose` |
| `shell/commands.ts` | the layout verbs run quietly, their `LayoutResult` JSON, optimistic focus through a command, `afterRev` |
| `shell/resize.ts` | the gutter drag's arithmetic (pure) |
| `shell/keys.ts` | the interim key table |
| `stores/selectionBridge.ts` | the selection from the focused tab; `select()` to the layout |
| `stores/shellView.ts` | window-only state: mode, the drawn frame, focus requests |
| `mock/layoutVerbs.ts` | the mock's command-level layout verbs |
| `e2e/shell-grid.spec.ts` | gutter drag, focus by press and keys, stream counts, a composer tab's send, SHOTS |

## Decisions

- **All surface kinds are in.** Every kind of `internal/layout/testdata/kinds.json` but `terminal`
  (PR 13) has a surface; `registry.test.ts` pins that. Wrapping the side panel's specs was cheap
  enough that nothing was cut into a follow-up.
- **Every action is a layout verb.** A tab click is `tab.focus`, a press in a pane `pane.focus`, ×
  `tab.close`, a gutter drag `pane.resize`, a sidebar click `thread.open`, New thread
  `composer.new`. Focus stays optimistic: the slice's `focusTab`/`focusPane` now take a runner, and
  `shell/commands.ts` passes one that invokes the command and answers the `rev` from its JSON.
  A composer's send passes `thread.new --compose <tab>` (PR 6), so the thread's tab takes the
  composer's place in the daemon's own commit (`shell/composerTab.ts`: the focused tab when it is a
  composer); the mock's `thread.new` does the same. Three routes have no verb yet and apply the op
  through `LayoutService` directly: a send from a "New thread on this branch" composer
  (`thread.new-like` takes no `--compose`, so the bridge applies `open_thread` with `compose`), and
  opening Pull Requests or Projects (`open_surface`; `view.open.*` is PR 7). The seam's own operations (a surface's
  `setTabParams`, `openTab`) are not user actions and also go straight to `LayoutService`.
- **The selection bridge** writes `ui.selection` from the current space's focused tab (thread and
  linked tabs: the thread; `prs`; `projects` with its `project`/`workspace` params; `compose`; an
  unlinked tab: `none`; no pane: home). `ui.select()` goes through a route (`setSelectRoute`): it
  sets the selection at once, runs the action, and does not mirror the layout over it until the
  action settles, then mirrors again (a refusal puts back what the window shows). `select()` has a
  new `sent` option: `compose.ts`'s send passes it when the daemon did not already put the thread
  in the composer's place (a like send), so the bridge does; a sidebar click with a composer focused
  opens beside it (the spec's "stays when focus moves away"). Back and forward set the selection as before, then route it. A New thread pick
  sets the focused empty composer's params to what was picked (`new_thread` focuses an existing
  empty composer without changing them).
- **The Projects tab's page is in its params**, not the selection: `ProjectsPageAt` takes the
  location; `ProjectsPage` (classic) is a wrapper. A page change in the Projects tab is
  `set_tab_params` on it.
- **One window-wide focus request, one taker.** `promptFocusSeq`/`contentFocusSeq` are window-wide;
  with two thread panes on screen both composers would race. `useServesFocusRequests()` (true
  outside the shell) lets only the focused pane's thread composer serve them, and the four pages
  that focused their root on mount (Pull Requests, Projects index, project and workspace pages) now
  only do so in the focused pane. A pane takes the layout focus on a pointer press, or on focus-in
  only after a keyboard input (a surface focusing itself on mount does not move the layout focus).
- **Keyboard into a pane** on a focus request (direction keys, a close): a thread's prompt (bumping
  `promptFocusSeq`, served by the focused pane), the composer's (`focusComposer`), else the page's
  `[data-focus-root]`, else the pane body.
- **Interim key table** (`shell/keys.ts`), ahead of the registry's bindings while the shell draws,
  outside dialogs: `cmd+w` (`tab.close` of the focused tab), `cmd+shift+w` (`pane.close`),
  `cmd+shift+[`/`]` (tab previous/next, computed locally, optimistic through `tab.focus`),
  `ctrl+cmd+h/j/k/l` and arrows (`pane.focus.<dir> --to`, the neighbour from the drawn frame), and
  the same with shift (`pane.move.<dir> --to`, which exists since PR 4). `keys.test.ts` reads the
  spec's table from `shell-model.md` and checks every entry names a row verbatim and covers its
  chords. Each verb is invoked with explicit ids, not the daemon's stored focus.
- **Gutter drag**: the two kids beside the gutter trade length, each held at its minimum
  (`minimumOf`), the split's other kids keep theirs; sizes are the pair's share scaled by the drawn
  lengths. The preview stays until the commit's event arrives (`afterRev`), so panes never jump back.
- **Grid layout reads only the active kinds.** The grid re-lays out on the tree or a pane's active
  tab kind (the minimums), not on every tab change. Rails are off (PR 19).
- **Tab fitting**: a hidden row of the tabs at natural width is measured (ResizeObserver, so a
  rename re-fits) and `fitTabs` decides; a `short` tab truncates, an `icon` one hides its label
  (`sr-only`) and its ×. The tooltip is `Tip whenTruncated`, so it opens only for a cut-off or hidden
  name.
- **Thread header**: `ThreadPane` keeps its header (crumb, title menu, thread info toggle). The tab
  above shows the same name; the sketches have that header too, and PR 12 owns it. The side panel
  and bottom panel toggles hide inside a shell pane (`PanelToggle`, `BottomToggle`), since the shell
  draws neither panel. The Pull Requests and Projects pages keep their headers: they hold the
  pages' controls and freshness.
- **The strip's free space drags the window** (`--wails-draggable: drag`) until the top bar does
  (PR 15). The pane in the window's top left corner pads its strip past the traffic lights when the
  sidebar is hidden.
- **Mock**: `mock/layoutVerbs.ts` adds `thread.open`, `thread.close`, `tab.focus/move/close/next/
  previous`, `pane.focus`, `pane.focus.<dir>`, `pane.move.<dir>`, `pane.split`, `pane.close`,
  `pane.resize`, `space.new`, `space.switch` and `composer.new`, each running Go's op through
  `world.layout.apply` and answering Go's `LayoutResult` JSON. Direction verbs without `--to` use
  the geometry's `neighbour` on the plain frame (Go uses MRU, then the longest edge). Not added:
  `space.rename/move/remove`, `thread.space.move` (the mock's `move_thread` is unimplemented),
  `tab.list`, `space.list`, `layout.show`, `composer.draft.*`. The seeds' diff tabs now name the
  seed threads' real checkouts, so a seeded Diff tab shows changes.

## Visible differences from the sketches (01, 09)

- No top bar: no space tabs, history buttons or app name above the panes; the classic sidebar band
  keeps them (PR 15). Panes start a shell gap below the window top, as the classic content pane.
- No "+" at the end of a strip and no full-screen button at its right (PR 12, PR 19).
- No "Diff of ● thread" row under a linked tab's strip (PR 12).
- The thread header is today's: project crumb › title menu, and the thread info toggle; the sketch's
  branch chip and three-dot menu are PR 12's.
- The sidebar is the classic one (no Needs you / Active sections, Pull Requests and Projects rows
  still there; PR 16).
- No terminal tabs (PR 13).
- The active tab's tint is the side panel's, lighter in panes without the focus; the sketch shows no
  focus mark beyond the strip.

## Verification

- `make check` green.
- vitest: `PaneTabStrip.test.tsx` (order, names from the thread, rename, click, ×, middle click,
  fitting three ways), `PaneView.test.tsx` (which body mounts for each kind, only the active one,
  unknown kind, position, focus by press), `selectionBridge.test.ts` (each tab kind's selection,
  every route, the bridge mirroring and routing, no layout), `keys.test.ts` (against the spec's
  table), `hostShell.test.ts` (places, identity, ids, open, params, subscribe), `resize.test.ts`,
  `registry.test.ts` (kinds.json), `composerTab.test.ts`, `mock/layoutVerbs.test.ts`.
- e2e `shell-grid.spec.ts` (WebKit, mock): a gutter drag previews, stores the sizes, keeps the
  tiling and the panes where they were dropped, also down a column; focus by a press and by
  `ctrl+cmd+h/j/k/l` and an arrow, with the keyboard following (into a thread's prompt); two panes
  with two threads hold two `WatchThread`s, switching a pane to its hidden thread tab keeps two, and
  closing a pane leaves one. Sending from a composer tab runs `thread.new --compose <tab>` and the
  thread's tab takes the composer's place, active, in the focused pane.
- `make gui-e2e` with the flag off: the existing suite unaffected (numbers in the PR).
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp (removed
  after): two threads made with `thread new --no-project`, opened from the sidebar (the second
  joined the focused pane), `pane split --edge right` from the CLI showed at once as two panes,
  a gutter drag in the window stored `row [0.37 0.63]` (the left pane held at the thread's 360px
  minimum), and a reload drew the same widths with the same focused pane. `layout show` printed
  `laid out in 996x776`: the viewport the grid reported.

## Gotchas

- `playwright cli mousedown` and `mousemove` as separate CLI calls do not drag a gutter; one
  `run-code` with `page.mouse` does.
- oxlint's `no-unnecessary-condition` and tsc's `noUncheckedIndexedAccess` disagree on `arr[i]?.x`
  inside an `every` callback; `arr.at(i)?.x` satisfies both.
- A file under `src/shell/surfaces` that defines a component and exports a non-component breaks
  React fast refresh's lint rule: components live in `components/shell`.
- `host.ts` must not import the surface registry (a surface's spec reads `tabChanges` from
  `host.ts` at module load): the kind mapping is `shell/kinds.ts`, which imports nothing that
  imports a surface.

## For later PRs

- **PR 12 (linked tabs)**: the row under the strip ("Diff of ● thread") goes in `PaneView` between
  the strip and the body, from `ShellSurface` (add `linkedRow`); the "+" menu after the last tab in
  `PaneTabStrip` (its free space then stops dragging the window only where the menu sits); the thread
  header replaces `ThreadPane`'s; the attention mark on a tab opened behind uses `SurfaceSpec.waiting`.
  `thread.new-like` could take `--compose` as `thread.new` does, and the bridge's direct
  `open_thread` would go.
- **PR 13 (terminals)**: add `shell/surfaces/terminal.tsx` (and drop `terminal` from `LATER` in
  `registry.test.ts` and from `NOT_PANEL` in `hostShell.ts` if it should join a place); the quick
  terminal mounts inside the thread surface only while its tab is active; `cmd+t`, `cmd+shift+t`,
  `cmd+j`, `cmd+shift+j` join `shell/keys.ts` with a row each in `keys.test.ts`'s `WANT`.
- **PR 14 (drag)**: tabs drag from `ShellTab` (the wrapper div), a pane from the strip's free space;
  `stores/shellView.frame` has the rectangles for hit-testing.
- **PR 15 (top bar)**: the top bar replaces the strip's window drag and the traffic-light inset;
  `focusHistory` replaces the bridge's routing of `view.back`/`view.forward`; `ctrl+cmd+1…9` join the
  key table. The grid already follows `currentSpaceId`.
- **PR 16 (sidebar)**: rows already open threads through `select()` and the bridge; the Pull
  Requests and Projects rows route to `open_surface` until `view.open.*` (PR 7) replaces those two
  direct ops in `selectionBridge.ts`.
- **PR 19 (rails, full screen)**: swap `frameRects` for `shellFrame` with the space's focus and
  MRU in `PaneGrid` (the grid then needs every tab's kind and thread, not only the active kinds);
  `expandTabs` in the seam becomes full screen.
- **Cutover (PR 20)**: the selection bridge and the `sent` option stay until the 75 readers of the
  selection move; `shell/keys.ts` goes once the chords are in `Command.Keybindings`.
