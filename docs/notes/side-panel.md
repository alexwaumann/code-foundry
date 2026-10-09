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
| `components/panel/keys.ts` | `panelKeyAction`, a pure function: cmd+w closes the active tab (or hides an empty panel), and a bare letter opens an enabled surface; `isPanelChord` (the keys a surface's `onKey` never sees) |
| `components/panel/reveal.ts` | `revealTab`: scrolls the tab strip (only the strip) so the active tab is fully visible |
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

Review fixes (after `2a3c984`, 21 findings): `make check` green (37 vitest files / 493
tests, plus the Go suite). `make gui-e2e` passes 184/184 (92 per engine), with
`e2e/pr-panel.spec.ts` at 14 tests per engine. New unit tests: `Markdown.test.tsx`,
`Avatar.test.tsx`, `stores/prPanel.test.ts` (refresh, failed refresh, reviewer busy
until the re-read, failed request, revert without a number, inner state pruning),
`surfaces/pullrequest.test.tsx` (availability follows a worktree's branch switch), plus
cases in `model.test.ts`, `panel/keys.test.ts`, `SidePanel.test.tsx` and
`validate.test.ts`. New e2e: 280px (header and tab bar `scrollWidth <= clientWidth`,
logins, popups inside the panel, tab reveal), quiet and failed Refresh, inner state
after close and reopen, virtualized lists. The close-and-reopen and the 420px Timeline
bar e2e were checked to fail with their fix reverted. Screenshots (WebKit, dark unless
named, 1400x900, mock daemon): `/tmp/cf-shots/chunk3b-summary-280.png`,
`chunk3b-timeline-280.png`, `chunk3b-summary.png` (420px), `chunk3b-light-summary.png`.
Not run in the real Wails window.

### Pieces

| File | Role |
|---|---|
| `surfaces/pullrequest.ts` | The spec: availability, `watches`, `warm`, `onKey` (shift+cmd+c), `render`, `openDefault` |
| `surfaces/pullrequestTarget.ts` | Pure: `selectionPullRequest` (selection → worktree → branch → branch PRs), `pickPullRequest`, `pullRequestTab`, `prRefOfTab` |
| `stores/prPanel.ts` | Inner view state per panel tab (`byTab`, pruned when a tab closes), in-flight flags, `reviewerCandidatesResource`, and the actions: `refreshPullRequest` (pr.refresh), `setReviewRequest` (pr.review.request), `revertPullRequest` (pr.revert), `copyPullRequestLink`, `openPullRequestInPanel` |
| `components/pr/PullRequestSurface.tsx` | Root: resource watch, skeleton / error / not found, header, stale banners, inner tab bar |
| `components/pr/PrSummary.tsx` | Reviewers, labels, description, checks, comments and threads |
| `components/pr/PrTimeline.tsx` | The timeline rail |
| `components/pr/ReviewerPicker.tsx`, `PrMenu.tsx` | The add-reviewer popover and the ⋯ menu |
| `components/pr/model.ts` | Pure view logic (state badge, checks headline, check tone/duration, reviewer status, `conversation`, `timeline`, `resolveLink`), table-tested in `model.test.ts` |
| `components/pr/Markdown.tsx`, `Avatar.tsx`, `tones.ts`, `keys.ts` | Markdown bodies, avatars with an initial fallback, colours per tone, the copy chord, the popup key guard and `usePanelBoundary` (popups stay inside the panel) |
| `components/pr/VirtualStack.tsx` | Variable-height list that virtualizes over 40 items against the panel body's scroll box |
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
  link; the URL comes from the tab's params, so it works before the detail loads). The
  panel's own keys (cmd+w and every surface's hotkey letter, enabled or not;
  `isPanelChord`) are never offered to a surface. cmd+shift+c is in `ReservedChords`
  (chord.go), the settings validator's `menuChords` and the mock's reserved list, so no
  command can bind a chord the panel would swallow.
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
  the inner tab, the comment and timeline orders, and folded sections. It is in memory.
  A subscription to the panel store drops the entries of tabs no panel holds, so a
  closed tab reopens on Summary, newest first.
* **Actions are commands.** Refresh runs `pr.refresh` quietly (the menu shows the
  spinner and then "Updated 0s ago"; no toast). The command's result is the detail the
  daemon just fetched (protojson of `PullRequestDetail`); `parseRefreshResult`
  (`api/gh.ts`) maps it and `resource.set` writes it, so there is no second read. A
  failure is toasted, and `runCommandForResult`'s new `onError` records it as the
  entry's error over the copy ("Could not refresh: …"), which keeps its own `lastError`.
  `refreshPullRequestDetail` (stores/gh.ts), the RPC path, was unused and is gone.
  Toggling a reviewer runs `pr.review.request`, then invalidates the detail and the
  candidates, and the row stays busy (spinner) until the candidates' re-read lands, so
  it never shows the old state, and a second click meanwhile sends nothing. Revert runs
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
  checks passed"; "No checks" when the rollup is empty. A failing or pending state with
  no count says "Checks failing" / "Checks pending" (no invented 1).
* **Comments.** Issue comments and reviews are listed together with review threads, by
  time (a thread sorts by its first comment). Thread comments are always oldest first
  inside the thread. The count (header and the Comments section) includes every thread
  comment. The Timeline leaves thread comments out, so its bar counts "N entries" (a
  history icon) instead of comments, and the numbers never disagree. Reviews show a verdict
  ("approved" green, "requested changes" red). The thread header keeps the file name
  and line visible and truncates the directory.
* **Timeline**: merged (or closed), opened, commits, issue comments and reviews, newest
  first by default, with a toggle. At the same timestamp: end state, review, comment,
  commit, opened. Unknown times go last, except the end state, which is always the
  latest event. Inline review comments stay in the summary's threads. Each entry draws
  its own piece of the rail, so the line runs from the first icon to the last one (and
  survives virtualization). A commit's avatar comes from its GitHub login only; without
  one it shows the git author name's initial (a name is not a login).
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
* **Markdown**: `react-markdown` 10.1.0 + `remark-gfm` 4.0.1 + `rehype-raw` 7.0.0 +
  `rehype-sanitize` 6.0.0 (pinned like the other dependencies). Raw HTML is parsed, then
  sanitized with GitHub's schema narrowed to markdown's own elements plus `img`,
  `details`, `summary`, `br`, `sub`, `sup` and `kbd`; script, style and event handlers
  go, and image sources must be https. The default `urlTransform` also strips unsafe
  schemes. A link whose target was stripped renders as plain text (no pointer). Links
  never navigate the webview: relative ones resolve against github.com, and they open
  through `openUrl`. The styles are a small `.cf-markdown` block in `index.css` (no
  typography plugin): task-list checkboxes hang in the gutter with a visible accent,
  and the text is selectable.
* **Avatars.** The daemon's avatar URL when it has one, else
  `https://github.com/<login>.png`. Teams and deleted accounts get an icon or "?". A
  failed load (offline, or the mock's `avatars.example.com`) falls back to the
  initial.
* **Colours** use `text-*-600` in light and `-400` in dark (`tones.ts`). Label chips tint
  the label colour at about 13% with a dot, so any GitHub colour reads in both schemes.
  Stale reviewer chips are at 70% opacity and the disabled Code tab at 55%, which still
  read in light mode.
* **Narrow panels.** The surface root is a CSS container (`@container`), and the parts
  give way by container queries rather than the window width. Header: the repo link has
  its own row (as in T3), then state, comment count and the menu; the branch row wraps
  the diffstat. Inner tab bar, measured in WebKit (tabs 208px, timeline counts 119px,
  order toggle 96px): below 480px the order toggle keeps only its icon (so the default
  420px panel shows the counts and the icon), below 400px the counts go, and below 340px
  the checks headline keeps its icon and number. Its right cluster clips rather than
  overflowing. Reviewers and Labels stack their label above the chips below 340px.
  Comment and timeline headers wrap the verdict and age under a long login.
* **Popups** (menu, reviewer picker) use the panel's `<aside>` as Radix's
  `collisionBoundary` (`usePanelBoundary`), with 8px padding and a max width from
  `--radix-popper-available-width`, so at 280px they fit inside the panel.
* **Long lists.** The Summary's conversation and the Timeline virtualize over 40 items
  (`VirtualStack`). Rows have variable heights, so it uses TanStack Virtual (as
  `RowList` does) with `measureElement`, against the panel body (`data-scroll-root`),
  offset by `scrollMargin` (the list's distance from the top of the scroll content,
  re-measured by a ResizeObserver when content above it changes size). Checks tick every
  second only while one is running (else every 30 s), and the stale banner owns its
  30 s clock, so the surface root does not re-render on it.
* **The new tab is revealed.** The tab strip scrolls a new or activated tab into view
  (`revealTab`), so the tenth pull request opened from a row is not off-screen.
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
* **ResizeObserver loop errors.** TanStack Virtual re-renders inside its size observer
  with `flushSync` by default, which resized the observed rows in the same frame
  ("ResizeObserver loop completed with undelivered notifications" in the console).
  `useFlushSync: false` fixes it. `VirtualStack`'s own observer defers to the next
  frame for the same reason.
* **A shrinking flex child overlaps.** `min-w-0` on a `whitespace-nowrap` span lets it
  shrink below its text, which then paints over its neighbour (the first try at the
  timeline counts did this at 420px). The counts are `shrink-0` and hide by container
  query instead; only truncating text gets `min-w-0`.
* e2e: the panel width persists in localStorage, so a second `page.goto` in the same
  test keeps the width set earlier. Set it explicitly (`setPanelWidth`, through the
  app's ui store).
* The mock's `pr.refresh` now answers with the detail (protojson), like the daemon.
  `POST /__mock/gh/pr-fail?command=pr.refresh` fails the next one with UNAVAILABLE.

### Deferred

* The Code tab (the diff), shown disabled.
* Check out (T3's "Check out" button and `gh pr checkout N` hint), and per-commit `+/−`
  in the timeline (the detail has no per-commit stats).
* ~~Ask a question / Explain this PR / Fix findings in a thread~~ (done in chunk 4).
* Copy PR number (in T3's menu), editing the description, adding labels, and replying.
* Org teams in the picker (the daemon lists teams only when already requested; see
  `gh-pr-detail.md`).

## Chunk 4: the menu starts pull request sessions

The three "Coming next" slots in the PR surface's ⋯ menu now start a Claude session about
the pull request through the registry commands `pr.ask`, `pr.explain` and
`pr.fix.findings` (daemon side: `pr-thread-commands.md`).

Status: `make check` green (39 vitest files / 535 tests, plus the Go suite). `make
gui-e2e` passes 200/200 (100 per engine), with `e2e/pr-panel.spec.ts` at 22 tests per
engine (after the review fixes below; first landed at 522 / 190). Screenshots (WebKit, dark, 1400x900): `/tmp/cf-shots/chunk4-menu.png` (menu with
the three actions enabled, mock daemon), `chunk4-ask.png` (composer with a two-line
question, mock daemon), `chunk4-live-explain.png` (real daemon, below). Not run in the
real Wails window.

### Pieces

| File | Role |
|---|---|
| `stores/prSessions.ts` | `PR_SESSION_COMMANDS`, `prSessionArgs` (pure), `startPrSession` (runs the command, busy flag per pull request and kind, the fix-findings toast, the success toast's Open action), `openStartedSession`, `usePrSessionsStore` |
| `components/pr/PrAskComposer.tsx` | The inline composer under the header |
| `components/pr/keys.ts` | `composerKeyAction` (pure): Enter sends, Shift+Enter newline, Escape cancels, IME composition ignored (`isComposing` or `keyCode` 229) |
| `components/pr/PrMenu.tsx` | The three items enabled; controlled open state; spinners |
| `api/gh.ts` | `parseSessionResult`: the session id in the command's result (protojson of `Session`) |
| `mock/world.ts`, `mock/prDetail.ts`, `mock/server.ts` | The mock commands answer with the session JSON; `pr-fail` and the new `pr-delay` controls |

### Decisions

* **Args.** `{ "repo-slug", number }`, plus `question` (trimmed) for `pr.ask`. No `worktree`:
  `getUiContext()` already sends the selection's worktree as `active_worktree_path`, and
  pr.ask/pr.explain read it from there (pr.fix.findings ignores it by design). Passing it
  as `worktree` would also change its meaning ("use this one as is") and skip the clone
  check. No `model`/`effort`: the daemon fills them from `sessions.default_*`.
* **Selection.** The daemon emits `FocusSession` for the new session (as `session.new`
  does), and `stores/intents.ts` already selects it with terminal focus. The GUI adds no
  second selection from the result: two paths would race the user if they clicked away
  meanwhile. `startPrSession` still parses and returns the id (tests and callers).
* **Panels.** Nothing is opened in the new session's panel. Panel state is per
  selection, so the originating selection (the Pull Requests page, a session, a worktree)
  keeps its PR tab; e2e checks both the Pull Requests page and a session.
* **Ask** opens an inline composer under the header, not a popover: a popover inside a
  280px panel left no room for a multi-line question, and the composer keeps the PR in
  view. The menu item sets the surface's local `asking` state; the menu's
  `onCloseAutoFocus` is prevented for that item so focus lands in the textarea, not back
  on the ⋯ button. Choosing Ask again while the composer is open moves focus back into it
  (the surface bumps a `focusRequest` counter the composer's focus effect depends on).
  Enter (or cmd+Enter) sends, Shift+Enter is a newline, Alt/Ctrl+Enter do nothing, Escape
  cancels and hands focus to the panel `<aside>` (panel keys keep working). A blank
  question sends nothing and the Ask button is disabled. While its pr.ask runs the textarea
  is read-only with "Starting a session…", Cancel is disabled and Escape does nothing (it
  is still kept from the panel): the session starts either way, so the composer stays with
  its spinner rather than pretending to cancel. On success the composer closes through the
  same path as Cancel, handing focus to the panel (in practice the selection has already
  moved, which unmounts it; this covers a FocusSession that never arrives); on failure the
  generic error toast shows and the text stays for a retry. The composer is local state of
  the surface, so it never comes back when the user returns.
* **Busy across surfaces.** The busy flag lives in the store per pull request and kind, so
  every surface showing the pull request sees it (in practice: send from a session's panel,
  switch to the Pull Requests page and open the same PR). The composer tells its own send
  (local `sending`) from another surface's: the Ask button shows the shared spinner, and the
  hint says "Already starting a thread for this pull request"; its text stays editable,
  Cancel works, and Enter sends nothing. Running Explain and Fix findings items are
  `aria-busy` and `aria-disabled` (still focusable, as ARIA intends; a select sends
  nothing). Ask a question is never disabled: it only opens the composer.
* **Composer at 280px.** The idle hint is "⏎ send · ⇧⏎ newline" (the long form was cut).
  The textarea starts at 3 rows, grows with its text up to 6 (`max-h-[calc(6lh+1rem+2px)]`,
  height set from `scrollHeight` in a layout effect), then scrolls.
* **Explain and Fix findings** keep the menu open (`preventDefault` on select, as Refresh
  does) with a spinner on the item (`aria-busy`) until the command answers; success closes
  it. A second click on a running item sends nothing (busy flag per pull request and
  kind). A failure leaves the menu open for a retry; the error is the generic
  `runCommandForResult` toast ("Fix Pull Request Findings failed" with the daemon's
  message, e.g. the fork's `gh pr checkout N` hint).
* **The menu reopened while it fades out stays open.** Pressing ⋯ within the menu's exit
  animation (about 150 ms after choosing any closing item, Ask or Copy link alike) opened it
  and shut it again in the same press: the fading content's dismissable layer was still
  mounted and took the press as an outside one. `onPointerDownOutside` now ignores presses
  on the ⋯ button (it toggles the menu itself). Radix still counts that press as an outside
  interaction and then skips returning focus to the button on the next close, so
  `onCloseAutoFocus` does it when the last outside press was the button. A reopen also
  clears a `keepFocus` left by an Ask whose close never ran its focus handling.
* **Fix findings toast.** "Preparing worktree for #N…" (sonner `loading`) shows only if
  the command is still running after 200 ms, so a quick answer (the fork error) does not
  flash it, and is dismissed when the command answers. Merged and closed pull requests
  keep the item enabled, as asked.
* **Success toast.** `startPrSession` shows the command's message ("Started session <id>
  for PR #N") itself (`runCommandForResult` with `quiet`) with an **Open** action when the
  result names the session. The daemon's FocusSession normally selects it first, so this is
  a confirmation; Open (`openStartedSession`) selects the session with terminal focus unless
  it is already selected, which covers an event stream that missed the FocusSession. An
  explicit Open always selects it, even if the user has moved elsewhere since: reading
  "unless the selection has already moved" as "unless it is already on the session".

### Gotchas

* **A sonner toast dismissed before it is added stays up.** Sonner's Toaster adds a toast
  on a `setTimeout(0)` but marks it deleted on a `requestAnimationFrame`; when the mock's
  fork error answered at once, the dismissal ran first, found nothing, and the toast was
  added afterwards and never left (seen in WebKit). The dismissal now goes through a
  `setTimeout(0)` queued after sonner's add (timeouts of equal delay run in order), and
  the 200 ms show delay avoids the case for quick answers. Unit test with fake timers; the
  e2e checks no "Preparing" toast is left after the instant failure.
* **WebKit's IME Enter.** WebKit fires `compositionend` before the keydown of the Enter
  that confirms a candidate, so that keydown has `isComposing === false`; its `keyCode` is
  229. `composerKeyAction` ignores both (the composer passes `e.nativeEvent.keyCode`, with
  an eslint exception for the deprecated property).
* **Playwright will not click an `aria-disabled` item** (it waits for "enabled"); the
  cross-surface e2e forces the click to check a busy item sends nothing.
* **Menu screenshots** need the fade-in to finish (`el.getAnimations({ subtree: true })`),
  or the menu is captured half transparent over the summary.
* **Playwright runs share `test-results/`.** A live run started while `make gui-e2e` was
  running cleaned that directory and failed one unrelated e2e with ENOENT on its trace.
  Run the live config with `--output <elsewhere>`, or not at the same time.
* **`session close` takes `--id`**, not a positional id (`code-foundry session close --id
  s-…`); without it it closes the active session from the context.
* The mock's `pr-fail` control now covers `pr.ask`, `pr.explain` and `pr.fix.findings`
  (fix: the fork message as `FailedPrecondition`; ask/explain: a 502 reading the pull
  request as `Unavailable`, the daemon's codes), and
  `POST /__mock/gh/pr-delay?ms=800` makes the three commands take that long, so e2e can
  see the spinner and the toast. The commands answer with the created session as JSON
  (`id`, `repoId`, `worktreePath`, `model`, `effort`), like the daemon (protojson of
  `Session`), rather than a `{sessionId}` shape.

### Tests

* `stores/prSessions.test.ts`: args per kind (no worktree/model/effort), each command and
  its id, blank question, busy guard, the preparing toast (delay, deferred dismissal,
  none for a quick answer), failure, the success toast's Open action (none without an id),
  `openStartedSession` table.
* `components/pr/PrAskComposer.test.tsx`: `composerKeyAction` table (with `keyCode` 229
  rows), Enter sends, closes and hands focus to the panel, IME Enter, the idle hint,
  Shift+Enter, blank, Escape, failure keeps the text; while sending: read-only, Cancel
  disabled, Escape and Enter ignored, closes when the session starts; another surface's
  pr.ask: shared spinner, the "Already starting" hint, nothing sent; two composers on one
  PR share the spinner; a new `focusRequest` refocuses the open composer.
* `e2e/pr-panel.spec.ts`: the menu test now checks the three items are enabled with
  their subtitles. Explain: the spinner, `pr.explain` with slug and number and no
  worktree, the new session selected with no panel, and #145 still open on the Pull
  Requests page. Ask (from session s-1): Escape cancels and leaves focus in the panel,
  Shift+Enter, Enter sends the two-line question with s-1's worktree in the context (not
  in the args), and s-1's panel keeps #145. Fix findings: the fork error toast, no stray
  "Preparing" toast, the menu open for a retry, then the spinner and the toast, the
  session selected. Review fixes: Ask from the Pull Requests page (no worktree in the
  context) with Cancel disabled and Escape ignored while it starts; a failed pr.ask (the
  toast, the text kept, the retry); choosing Ask again refocuses the composer, the menu
  reopened right after Ask stays open, focus returns to ⋯ after, ⋯ still closes it; the
  same PR on two surfaces (session s-1 and the Pull Requests page) shares Ask's spinner
  with the "Already starting" hint and Explain's `aria-busy`/`aria-disabled`, and nothing
  is sent twice; at 280px the hint fits and the field grows to 6 rows, then scrolls.
* `e2e/live-prsession.spec.ts`: opt-in live run (below).

### Live run (scratch daemon, 2026-10-09)

```
$ make build
$ CODE_FOUNDRY_HOME=/tmp/cf-c4-home.XXXX ./bin/code-foundry daemon &         # port 63592
$ git clone --depth 5 https://github.com/alexwaumann/code-foundry.git /tmp/cf-c4-clone.XXXX/code-foundry
$ code-foundry repo register --path …/code-foundry          # registered code-foundry (79b248ba670c)
$ code-foundry settings set sessions.default_model haiku
$ code-foundry settings set sessions.default_effort medium
$ VITE_DAEMON_URL=http://127.0.0.1:63592 VITE_DAEMON_TOKEN=… WAILS_VITE_PORT=9372 pnpm run dev --host 127.0.0.1 &
$ LIVE_DAEMON=1 LIVE_APP_URL=http://127.0.0.1:9372 LIVE_REPO=code-foundry LIVE_PR=1 \
  LIVE_SHOTS=/tmp/cf-shots pnpm run e2e:live e2e/live-prsession.spec.ts --output /tmp/cf-c4-live-results
session s-7e2d05ba7839
  ✓ Explain this PR starts a real Claude session with the explain prompt (4.8s)
```

The spec selects the clone's repo row, opens #1 (merged) through
`openPullRequestInPanel`, and clicks Explain this PR. The real daemon read #1, picked the
clone's main worktree (the active worktree of the repo row), started Claude Code 2.1.295
with Haiku 5.5 at medium effort (the settings defaults; no model or effort was passed),
and focused it: the new session row was selected (the whole test took 4.8 s), and
the explain prompt appeared in its terminal, pasted as one message with all its lines.
Claude was already running `gh pr view 1 … && gh pr diff 1 --stat`
(`/tmp/cf-shots/chunk4-live-explain.png`). Back on the repo row, its panel still showed
the #1 tab. A first attempt, started while `make gui-e2e` ran, passed its steps too
(session s-545d810c93f9) but failed on the shared `test-results/` directory (Gotchas). Both
sessions ended when the daemon was stopped (the `session close s-…` form I tried first is
not the CLI's; see Gotchas); no Claude process was left, nothing was pushed, and the home
and clone directories were removed.

### Open items

* The composer has no history and no attachments, and its text is lost when the selection
  changes before sending.
* No way to pick a model or effort from the menu (the settings defaults only); the
  palette's `pr.ask`/`pr.explain` prompts for them.
* Ask and Explain start in the selection's worktree when it is a clone of the slug; from
  the Pull Requests page (no worktree) the daemon picks the head's worktree or the main
  one. The menu does not say which beforehand.
* Not run in the real Wails window.

## Chunk 5: the Merge button

A Merge button on the PR header's repo row, left of the ⋯ menu (daemon side:
`gh-pr-detail.md`, "Merge").

Status: `make check` green (45 vitest files / 628 tests, plus the Go suite). `make
gui-e2e` passes 232/232 (116 per engine), with `e2e/pr-panel.spec.ts` at 25 tests per
engine; the declined-confirmation assertion was checked to fail with its fix reverted.
After the review fixes: `make check` green (45 vitest files / 632 tests, plus the Go
suite); `make gui-e2e` passes 234/234 (117 per engine, `e2e/pr-panel.spec.ts` at 26 per
engine); the new store tests for the head guard and the unknown outcome were checked to
fail with their fix reverted.
Screenshots (WebKit, dark, 1400x900, mock daemon): `/tmp/cf-shots/merge-button.png`
(#142 at 420px, dropdown open) and `/tmp/cf-shots/merge-button-280.png`. Not run in the
real Wails window, and no merge was sent to GitHub.

### Pieces

| File | Role |
|---|---|
| `components/pr/MergeButton.tsx` | The button (`pr-merge-button`) and its dropdown (`pr-merge-menu`): a "Merge into <base>" label, notes, one item per allowed method (`pr-merge-method-<m>`), and the "Delete branch after merge" checkbox item (`pr-merge-delete-branch`, its line `pr-merge-delete-branch-note`) |
| `components/pr/merge.ts` | Pure: `mergeAvailability` (visible, disabled reason, methods, notes), `branchDelete` (deletable, the line under it), `mergeArgs` (with `head-sha`), `mergeMethodHint`, labels |
| `stores/prPanel.ts` | `mergePullRequest` (pr.merge with the shown head through `runCommandForResult`, quiet; `merging` busy flag per pull request) |
| `api/gh.ts` | `mergeMethods`, `autoMergeEnabled`, `defaultBranch` on the detail view, `headSha` on the pull request view; `parseMergeResult` |
| `components/ui/dropdown-menu.tsx` | shadcn `DropdownMenuCheckboxItem` and `DropdownMenuLabel` |

### Decisions

* **When it shows, and why it is disabled.** Hidden unless the pull request is open.
  Disabled reasons, first match wins: draft (or merge state `draft`) "Draft pull requests
  cannot be merged"; no write access "Merging needs write access"; `mergeable`
  conflicting or merge state `dirty` "Resolve conflicts first"; merge state `blocked`
  "Blocked: required checks or reviews are missing". Write access comes before
  conflicts: someone without it can do nothing about them. Behind, unstable
  (non-required checks failing), has hooks, auto-merge on and mergeability not computed
  yet are allowed; behind, unstable and auto-merge get a note in the dropdown. Empty
  `mergeMethods` means unknown (a detail cached before the field), not "none allowed":
  all three are offered and the daemon refuses a disallowed one.
* **The head it shows is the head it merges.** Every merge sends
  `detail.pullRequest.headSha` as pr.merge's `head-sha`; the daemon refuses ("changed
  since it was shown; refresh and try again") if GitHub's head is another commit, and
  the detail re-reads.
* **Disabled is `aria-disabled`, not `disabled`**, so the button stays focusable and its
  `title` tooltip shows; the reason is also its accessible description. The dropdown
  refuses to open while disabled or busy (`onOpenChange` ignores opening).
* **Branch default.** "Delete branch after merge" starts on (Alex's decision; the review
  proposed off) unless the branch cannot be deleted: a fork's ("The branch is in a
  fork"), the default branch ("origin/main is the default branch") or the base branch;
  then it is disabled and unchecked. Its line says what it deletes: "Deletes
  origin/feat/x; local branches and worktrees are untouched" (wraps; long names break
  anywhere). The choice is local to the tab's surface and stays while the dropdown is
  reopened. Toggling keeps the menu open. The item has `pl-9`, so the box sits 12px
  from the menu's edge (4px menu padding + 8px) and 12px from its label; the e2e
  measures both.
* **Running.** Choosing a method closes the menu, then runs pr.merge; the daemon's
  confirmation ("Merge #142 into main with squash? Branch origin/feat/sidebar is deleted
  afterwards.") goes through the ConfirmDialog. The button shows a spinner and is
  `aria-busy` from the confirmation until the answer, and a second run meanwhile sends
  nothing. Success toasts the daemon's message, split at "; " into title and description
  ("Merged #142 (e2e0142)", "deleted origin/feat/sidebar"). Either way the detail is
  invalidated (the daemon also sends the event), so a refusal like a moved head shows
  GitHub's state; the refusal itself is the generic "Merge Pull Request failed" toast.
* **Style.** `bg-primary` (near white in dark, near black in light), 28px high like the
  ⋯ button. Below 340px (container query) the label is screen-reader only and the
  icon and chevron stay (under 48px wide). The dropdown is 18rem, inside the panel
  through `usePanelBoundary`.

### Gotchas

* **The menu came back after a declined confirmation.** Selecting a method set the busy
  flag in the same event, so the controlled `open` (`open && !blocked`) was already false
  when Radix closed the menu; Radix's `useControllableState` then skips `onOpenChange`,
  the local `open` stayed true, and the menu reopened once the merge ended (and the next
  click toggled it shut). The item now calls `setOpen(false)` itself.
* Playwright will not click an `aria-disabled` button; the draft check forces the click
  to prove it opens nothing.
* The mock's `pr-fail?command=pr.merge` fails the next merge like a moved head, and
  `pr-delay` now also delays pr.merge (for the spinner).
* A Radix checkbox item's box is a `span.flex` too: measure the label from
  `pr-merge-delete-branch-note`'s parent, and after the menu's open animation.

### Open items

* Not run against a real daemon with GitHub (no merge may be sent). The new detail query
  fields (`mergeCommitAllowed`, `squashMergeAllowed`, `rebaseMergeAllowed`,
  `autoMergeRequest`) and the head-moved message were not checked against GitHub.
* No commit message editing (GitHub's squash title/body), no "merge when ready" (enabling
  auto-merge), no admin bypass of branch protection.
* Deleting the branch does not check for other open pull requests based on it.
* No mock control pushes to a fixture's head, so the GUI's "changed since it was shown"
  refusal is covered by unit tests (store, API, mock contract), not an e2e.

### Review fixes (2026-10-09)

The merge review's findings (daemon side: `gh-pr-detail.md`, "Merge review fixes"). In
the GUI: pr.merge sends the shown head (`head-sha`); empty `mergeMethods` offers all
three instead of disabling the button (`merge.test.ts`, with `has_hooks`); the delete
item names `origin/<branch>`, says local branches and worktrees are untouched, stays on
by default, and is disabled for the default and base branch (`branchDelete` table); more
space between its box and label. The mock now matches the daemon for forks, the default
and base branch, `head-sha`, and repeats; new fixture #146 (open, from a fork) and the
e2e "#146 from a fork: the branch cannot be deleted, and a merge asking anyway keeps it"
(runs pr.merge with `delete-branch` on, as the CLI can: no delete sentence in the
confirmation, "kept patch-1: it is in a fork"). Screenshots: `/tmp/cf-shots/merge-button.png`
(420px) and `/tmp/cf-shots/merge-button-280.png`.

