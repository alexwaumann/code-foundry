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
| `surfaces/files.ts`, `diff.ts`, `pullrequest.ts` | One spec per file. Files and Diff are `"disabled"` for now (`Placeholder.tsx` is their body); Pull request is real since chunk 3 (below) |
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
* The Pull request surface is the worked example (chunk 3 below). It added two optional
  spec hooks: `warm` (keep what `available` reads loaded while the panel shows) and
  `onKey` (chords for the active tab).
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

## Chunk 3: the Pull request surface

Status: `make check` green (33 vitest files / 453 tests, plus the Go suite). `make
gui-e2e` passes 176/176 (88 per engine), including `e2e/pr-panel.spec.ts` (10 tests per
engine) and the reworked row test in `e2e/prs.spec.ts`. Screenshots (WebKit, 1400x900,
mock daemon): `/tmp/cf-shots/chunk3-summary.png`, `chunk3-timeline.png`,
`chunk3-reviewers.png`, `chunk3-menu.png` (on #138), `chunk3-light-summary.png`. Not run
in the real Wails window or against a real daemon (the daemon side was exercised end to
end in chunk 2, `gh-pr-detail.md`).

### Pieces

| File | Role |
|---|---|
| `surfaces/pullrequest.ts` | The spec: availability, `watches`, `warm`, `onKey` (shift+cmd+c), `render`, `openDefault` |
| `surfaces/pullrequestTarget.ts` | Pure: `selectionPullRequest` (selection → worktree → branch → branch PRs), `pickPullRequest`, `pullRequestTab`, `prRefOfTab` |
| `stores/prPanel.ts` | Inner view state per panel tab (`byTab`), in-flight flags, `reviewerCandidatesResource`, and the actions: `refreshPullRequest` (pr.refresh), `setReviewRequest` (pr.review.request), `revertPullRequest` (pr.revert), `copyPullRequestLink`, `openPullRequestInPanel` |
| `components/pr/PullRequestSurface.tsx` | Root: resource watch, skeleton / error / not found, header, stale banners, inner tab bar |
| `components/pr/PrSummary.tsx` | Reviewers, labels, description, checks, comments and threads |
| `components/pr/PrTimeline.tsx` | The timeline rail |
| `components/pr/ReviewerPicker.tsx`, `PrMenu.tsx` | The add-reviewer popover and the ⋯ menu |
| `components/pr/model.ts` | Pure view logic (state badge, checks headline, check tone/duration, reviewer status, `conversation`, `timeline`, `resolveLink`), table-tested in `model.test.ts` |
| `components/pr/Markdown.tsx`, `Avatar.tsx`, `tones.ts`, `keys.ts` | Markdown bodies, avatars with an initial fallback, colours per tone, the copy chord and popup key guard |
| `components/ui/popover.tsx`, `dropdown-menu.tsx` | shadcn primitives over `radix-ui` (already a dependency) |

Component tree:

```
PullRequestSurface (tab body; watches pullRequestDetailResource)
├─ Skeleton | Centered (not found / error)
├─ Header: repo link #N · comment count · StateBadge · PrMenu (⋯)
│          title · Avatar author · updated · base ← head · files +a −d
├─ Banner (stale copy: lastError) · Banner (refresh error)
├─ InnerTabBar: Summary | Timeline | Code (disabled) · ChecksHeadline or counts + OrderToggle
└─ PrSummary
   ├─ Row Reviewers: Reviewer chips · ReviewerPicker (Popover → Command → CandidateRow)
   ├─ Row Labels: LabelChip
   ├─ Section Description → Markdown
   ├─ Section Checks → CheckRow
   └─ Section Comments (+ OrderToggle) → Comment | Thread → Markdown
   or PrTimeline → Entry (merged/closed, opened, commit, comment, review)
```

### Decisions

* **Availability.** Enabled when the selection's worktree branch has a pull request in
  `branchPullRequestsResource`: a session's or terminal's worktree (through
  `deriveContext`, as commands see it), a worktree row, or a repo row's main worktree. The
  first open one wins, else the most recent. Disabled otherwise. On the Pull Requests
  page it is always disabled and `openDefault` returns null: there is no one obvious
  pull request there, and its rows open one explicitly. `watches` lists the repos,
  sessions and terminals stores and the branch resource's store.
* **`warm`** (new optional `SurfaceSpec` hook). The branch resource is only watched by
  the worktree overview, so for a session it was never loaded, and the surface would
  stay disabled. `Panel` calls every spec's `warm(ctx)` while the selection's panel is
  mounted. The PR surface's `warm` watches that branch key and follows branch changes
  (it subscribes to the stores itself). Cost: a GetBranchPullRequests per selection while
  its panel shows, plus the resource's 5-minute keep-alive, which also makes the daemon
  poll that branch (10 minutes after the last read). Nothing is fetched while the panel
  is hidden, so P right after showing the panel waits for that read.
* **`onKey`** (new optional `SurfaceSpec` hook). The active tab's surface sees chords
  before `panelKeyAction`, outside text fields. The PR surface handles shift+cmd+c (copy
  link; the URL comes from the tab's params, so it works before the detail loads). cmd+w
  is never offered to a surface.
* **Opening from rows.** On the Pull Requests page and the worktree overview (branch PR
  rows and the "merged in the last 7 days" rows), a click or Enter calls
  `openPullRequestInPanel` (`openSurface("current", pullRequestTab(...))`). The list
  keeps focus, so j/k and Enter go on, and each pull request becomes its own tab.
  cmd+click and cmd+Enter open the pull request on GitHub. `NavRow` gained
  `activateOnClick` and `onCmdClick`, and `NavItem` gained `secondary` (cmd+Enter). The
  Help overlay lists cmd+Enter and shift+cmd+c. The overview's merged rows behave like
  its branch rows, for consistency with the Pull Requests page.
* **Inner state** (`stores/prPanel.ts`) is keyed by panel key + tab id, not the tab id
  alone, because the same pull request can be a tab in two selections' panels. It holds
  the inner tab, the comment and timeline orders, and folded sections. It is in memory
  and never pruned (a few bytes per tab), like the panel store.
* **Actions are commands.** Refresh runs `pr.refresh`, then invalidates the resource.
  The daemon's cache is fresh by then, so the re-read is a cache hit. Toggling a reviewer
  runs `pr.review.request`, then invalidates the detail and the candidates. Revert runs
  `pr.revert` through `runCommandForResult` (a new variant of `runCommand` that returns
  the result; `quiet` skips the default toast). The daemon's confirmation goes through
  the existing ConfirmDialog. On success it shows a toast with the new URL and an "Open
  on GitHub" action, and opens the new pull request as a tab of the same panel.
  `parseRevertResult` (`api/gh.ts`) reads the result JSON. Open on GitHub and links
  use `openUrl` (view.open.url). Copy link uses `copyText`. The candidates are a resource
  (`reviewerCandidatesResource`, no keep-alive) watched only while the picker is open,
  so it is read on every open, and no component calls an RPC.
* **Not found.** `getPullRequestDetail` rethrows NOT_FOUND as an `Error` whose message
  starts with `not found: ` (with the ConnectError as `cause`), and `isNotFoundMessage`
  tells the surface. The resource keeps only a message, so this was the smallest way
  through.
* **Checks headline** comes from the rollup (`pullRequest.checks`), not from the
  listed checks, which can be truncated: "N failing" wins over "N pending", then "All
  checks passed"; "No checks" when the rollup is empty.
* **Comments.** Issue comments and reviews are listed together with review threads, by
  time (a thread sorts by its first comment). Thread comments are always oldest first
  inside the thread. The count includes every thread comment. Reviews show a verdict
  ("approved" green, "requested changes" red). The thread header keeps the file name
  and line visible and truncates the directory.
* **Timeline**: merged (or closed), opened, commits, issue comments and reviews, newest
  first by default, with a toggle. At the same timestamp: end state, review, comment,
  commit, opened. Unknown times go last. Inline review comments stay in the summary's
  threads.
* **Menu order** follows T3's screenshot: Refresh, then the three "Coming next" slots
  (Ask a question, Explain this PR, Fix findings in a thread; disabled, `title="Coming
  next"`), a separator, Open on GitHub and Copy link (⇧⌘C), and then a separator and
  Revert changes, but only for a merged pull request with `viewerCanUpdate`. Refresh
  keeps the menu open and shows a spinner, then "Updated Ns ago" (`useFreshness` over
  `fetchedAtMs`; the detail is not poll-covered, so `polled` is false).
* **Read-only (#140).** The add-reviewer button still opens the popover, which shows a
  disabled search field and "Asking someone to review needs write access on this
  repository." This was clearer than a dead button with a tooltip, and it matches T3's
  layout.
* **Markdown**: `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 (pinned like the other
  dependencies). `skipHtml` drops raw HTML, and the default `urlTransform` strips unsafe
  schemes. Links never navigate the webview: relative ones resolve against github.com,
  and they open through `openUrl`. Images load only from https. The styles are a small
  `.cf-markdown` block in `index.css` (no typography plugin), and the text is
  selectable.
* **Avatars.** The daemon's avatar URL when it has one, else
  `https://github.com/<login>.png`. Teams and deleted accounts get an icon or "?". A
  failed load (offline, or the mock's `avatars.example.com`) falls back to the
  initial.
* **Colours** use `text-*-600` in light and `-400` in dark (`tones.ts`). Label chips tint
  the label colour at about 13% with a dot, so any GitHub colour reads in both schemes.
* **The Pull Requests table** now uses only flexible columns (`minmax(floor, n fr)`).
  With the panel open, the old fixed maxima (repo up to 12rem, checks and review 8.5rem)
  grew before the `1fr` title got any room, which squeezed the title to nothing.

### Gotchas

* **`useNow` looped forever** (fixed in `lib/clock.ts`, test in `lib/clock.test.tsx`).
  It passed an inline subscribe function to `useSyncExternalStore`, so React resubscribed
  on every render. When the caller was the only subscriber of its period, each
  resubscribe stopped and restarted the clock with a fresh `Date.now()`, which is a new
  snapshot and another render: "Maximum update depth exceeded". The Pull Requests page
  hid it, because its `Age` cells kept the 30 s clock alive. The PR header beside a
  session page has no such neighbours. Subscribe functions are now cached per period.
  The test makes `Date.now` advance on every call, because fake timers alone freeze it
  and the bug never shows.
* React events from portalled popups (menu, picker) bubble to the panel's `onKeyDown`
  through the React tree. Without a guard, typing "p" or "f" in the menu's typeahead
  opened surfaces. `stopPlainKeys` stops keys without cmd/ctrl at the popup, and chords
  (cmd+w, shift+cmd+c) still reach the panel. The popups carry `data-region="panel"`, so
  focus inside them counts as panel focus.
* e2e: the clipboard is stubbed in `addInitScript` (`window.__copied`). Chromium needs a
  permission and WebKit a user gesture for the real API. #131, #140 and an unknown number
  are opened through the app's own `stores/prPanel.ts` module (`openPr`), because they
  are on no dashboard.
* The e2e default ports (7799/9255) can be taken by another worktree's run. Use
  `E2E_MOCK_PORT`/`E2E_VITE_PORT`.

### Deferred

* The Code tab (the diff), shown disabled.
* Check out (T3's "Check out" button and `gh pr checkout N` hint), and per-commit `+/−`
  in the timeline (the detail has no per-commit stats).
* Ask a question / Explain this PR / Fix findings in a thread (the next chunk).
* Copy PR number (in T3's menu), editing the description, adding labels, and replying.
* Org teams in the picker (the daemon lists teams only when already requested; see
  `gh-pr-detail.md`).
