# Sidebar: stable order and a collapsible Working section

Decided 2026-10-11 (Alex). Frontend only. Design record: the static sketch
`/tmp/working-header/index.html` (`?v=1..3`, PNGs in
`~/.t3/userdata/attachments/working-header/v1.png` … `v3.png`); the shipped header is `?v=2`.
Supersedes the "Order, headers, keys" part of `thread-list.md` (rows, tooltip and toolbar
are unchanged).

## Order

`buildRows` (`src/lib/tree.ts`), newest first (creation time) inside every group, exactly as
before; there is no sorting by status-change time, so a thread moves only when it changes
group:

1. **Pinned**, any status (a pinned working thread stays at the top, never under Working).
2. **Needs attention**: prompts (attention tier "prompt": permission, question, plan, trust,
   notification, Claude API error at the prompt, other dialogs), then error / interrupted
   threads (status `error`). No header.
3. **Done**: unseen finished turns (tier "done"). No header.
4. **Idle**: everything else that is not working: idle, unknown, closing, plain
   disconnected (and a disconnected `busy` from an older daemon). No header.
5. **Working**: busy and starting threads, under the one labelled thread group, **Working**,
   with a count.
6. **Terminals** (loose terminals), under their header, as before.

The classification is `threadGroup(session)` (`src/lib/session.ts`, table-tested):
attention tier first (prompt / done), then status `error`, then `closing` or `disconnected`
are idle, then `starting` or `busy` are working, else idle. Attention and error win over the
process state on purpose: a thread that waits on the user never hides in a collapsed Working
section, so cmd+shift+a and the attention count never point at a hidden row.

`data-section` on thread rows: `pinned`, `attention` (prompts and errors), `done`, `idle`,
`working` (was `pinned`, `attention`, `threads`). The Working header row carries
`data-section="working"` too.

## List key and memoization

* `ListSession.attention` became `ListSession.group: ThreadGroup`
  (`"prompt" | "error" | "done" | "idle" | "working"`); `useSessionListKeys`,
  `decodeSessionListKeys` (`isThreadGroup`, unknown values decode as idle) and
  `getListInputs` carry it. The structure key per thread is id + attached terminal + pin +
  group, so busy/idle now rebuilds the list (the thread moves in or out of Working); a
  different dialog, a new detail, a ticking time or a name still re-render only that row.
* `rowCache` now compares rows field by field (`sameRow`) instead of key + section, because
  the Working header's `count` and `collapsed` change while its key and section do not. Every
  thread and terminal row is still reused when only its neighbours moved.
* `getListInputs` also returns `options: { workingCollapsed }` (the UI store), passed to
  `leafOrder` / `sessionOrder`, so cmd+1..9 and cmd+shift+a see exactly the rendered list.

## Working header

* Sketch variants (all with the real rows, dark theme vars from `index.css`, expanded with
  hover and collapsed):
  * `v1` T3 Code's own shelf header (from the T3 Code app bundle: a full-width
    `<button aria-expanded>`, sentence case `text-xs font-medium` muted label "Working (3)",
    a hairline rule filling the row, `ChevronDown` on the right rotating when open; T3 shows
    the count only while collapsed).
  * `v2` the Terminals header's type (11px, medium, uppercase, `tracking-wider`, muted), the
    count as a muted number after the label, chevron on the right. **Chosen**: it keeps the
    T3 shape (label + count + right chevron, the whole row a button) and reads as a sibling of
    TERMINALS right below it, with the label on the same left edge as the rows and TERMINALS.
  * `v3` chevron on the left and the count in a small pill: the chevron pushes the label off
    the TERMINALS / row text edge, and the pill is heavier than anything else in the list.
* Built as `WorkingHeader` in `SidebarRow.tsx`: the row stays `role="presentation"` with
  `data-row-kind="header"` (the listbox cursor never lands on it), and inside it a
  `<button type="button" aria-expanded>` 22px tall at the bottom of the 26px header row (same
  height as Terminals, `HEADER_HEIGHT`), `rounded-md`, `px-2`, `hover:bg-sidebar-accent/50`
  like a row's hover, a focus-visible ring. Its text and accessible name are "Working 2"
  (a space text node between label and count, which flex layout does not render).
  `ChevronDown` when open, `ChevronRight` when collapsed, 12px, `aria-hidden`.
* **Gutter rule**: the button spans the row's full width, so its hover background sits 8px
  from the window edge and 8px from the content pane, exactly like the rows (e2e checks the
  header and a thread row have the same x and width). No inner inset.
* Shown only when the Working group is non-empty (pinned working threads do not count).
* Click toggles `useUiStore.workingCollapsed`. `onMouseDown` prevents default so a mouse
  click does not move focus off the list or the terminal; the button is still in the tab
  order and Space / Enter toggle it.
* No command and no keybinding: collapsing is a view preference like the sidebar's width,
  not a user action on daemon state (the `ViewAction`s in `keys/bindings.ts` are for
  chords; none was asked for).

## Collapsed state

* `workingCollapsed` is persisted with the other sidebar prefs in the `code-foundry.ui`
  localStorage entry (`partialize`), default `false` (expanded). No version bump: `merge`
  takes a saved boolean and falls back to the default for a missing or bad value.
* Collapsed, the Working rows are not in the row list at all (Alex: hide), even the selected
  thread; the header with its count is the only signal. Selection is left alone, so the main
  pane keeps showing a hidden selected thread. Arrows, Home/End and cmd+1..9 skip the hidden
  rows because they are absent; a keyboard cursor left on a hidden row starts over from the
  first or last row on the next arrow key.

## Mock and e2e

* The default mock world now has rows that move on their own: s-1 flips busy/idle every 4 s
  and s-5 settles from starting after 8 s, both in and out of Working, and every row below
  them moves with them. New controls `POST /__mock/session/hold?id=…` and
  `/__mock/session/release?id=…` (`MockSession.held`): a held thread is left alone by the
  clock; controls and input still change it.
* **e2e's `resetMock()` holds s-1 (busy) and s-5 (starting)**, so every spec starts from
  `DEFAULT_ORDER` (`e2e/fixtures.ts`): s-2, s-6, s-4, s-3, Working (s-5, s-1), Terminals.
  Holding only in the specs that pin positions was tried first; hover and right-click specs
  on default rows then raced the moves (a measured rect went stale). The one spec that
  needs the clock (`sessions.spec`: s-5 settles into connected) calls
  `releaseSessions("s-5")`. `pnpm run mock` for development is unchanged (nothing held).
* A new thread from the composer starts under Working and settles into Idle, so the
  compose / sessions specs poll for it to be the first `data-section="idle"` row.
* `zoom-popovers.spec` (row context menu at 125%): the first right-click uses s-2 (s-1 is
  now low in the list with no room below), the "lowest row" is the lowest one inside the
  list's viewport (virtualized rows below it count as visible to Playwright), and the
  pointer leaves the list before the second right-click (see gotchas).

## Gotchas

* **`window.top`.** The first sketch rendered blank: a top-level `const top` in a classic
  script collides with the non-configurable `window.top`.
* **Header text in specs.** `rowKeys` reads a header's `textContent`, which is "Working 2"
  only thanks to the space node; without it the label and count run together.
* **rowCache by key + section was not enough** once a header carried data (see above).
* **Right-click during a skip-delay tooltip (Chromium).** In `zoom-popovers.spec`, a
  right-click on a row that landed while that row's tooltip opened at once (Radix's skip
  delay, because the previous row's tooltip was open) showed no context menu in 2 of 12
  Chromium runs; moving the pointer off the list first made it 24/24 (WebKit 48/48 for the
  file). The spec now does that. Not investigated in the app itself: it predates this change
  (the tooltip is from `thread-list.md`) and may also happen to a user who right-clicks right
  after hovering another row. Worth a look if Alex sees a missing menu.
* **Locked screen.** The Mac's screen was locked during the run (`CGSSessionScreenIsLocked =
  1`, the same as in `tooltip-status-reason.md`): `screencapture` returned only the wallpaper
  and `osascript` had no assistive access, so the Wails window could not be captured or
  clicked (see Verification).

## Verification

* `make check` green: gofmt, vet, staticcheck, `go test ./...`, frontend typecheck, lint,
  1559 vitest tests (80 files, after rebasing on #55). New or changed unit tests: `lib/session.test.ts`
  (`threadGroup` table, `isThreadGroup`), `lib/tree.test.ts` (full order with every group,
  pinned working at the top, errors after prompts, starting under Working, closing idle,
  collapsed removes rows but keeps the header and count, header only when non-empty,
  leaf/session order collapsed and not, `rowCache` reuse and header re-creation),
  `keys/bindings.test.ts` (cmd+1..6 over all groups, collapsed skips the Working rows,
  cmd+shift+a unchanged), `stores/ui.test.ts` (collapsed state saved, loaded, default and
  bad value).
* `make gui-e2e` (final run, rebased on main with #55): 483 passed, 20 skipped (live and
  screenshot specs), 1 failed: `workspaces.spec.ts:143` in Chromium, which presses cmd+n
  then cmd+1 back to back and lost the race for the project picker (cmd+1 went to the
  sidebar); it passed 20/20 on rerun (10 per browser) and is unrelated to this change.
  Earlier full runs on this branch: 480 passed / 2 failed (zoom-popovers, before its fix),
  then 481 passed / 1 failed (zoom-popovers' tooltip race, fixed as above).
* New e2e in `sidebar.spec.ts`: the Working section (header text "Working 2", count,
  `aria-expanded`, presentation row, same x and width as a thread row; collapsing hides
  s-5 and s-1 including the selected s-1 while the main pane keeps its terminal; cmd+5
  becomes the first terminal and ↓ from s-3 lands on t-logs; collapsed survives a reload and
  is in localStorage; expanding restores the order and cmd+5; Space toggles from the
  keyboard) and the count following threads (a new busy thread joins, pinning it moves it to
  the top and out of the count, s-1 idle and s-5 closed remove the header). Updated: the
  status-kinds full order with `data-section`, the flat-list and pin specs, `app.spec`
  (order, keyboard walk, cmd+7/8), `compose.spec` / `sessions.spec` (new thread settles into
  Idle), `zoom-popovers.spec`.
* `make gui-build` green.
* **Live** (scratch daemon `CODE_FOUNDRY_HOME=/tmp/cf-working` started from this branch's
  `bin/code-foundry`, scratch repo `~/tmp/cf-working-repo`, haiku / medium): a pinned idle
  thread, a supervised thread at "Needs input · Do you want to proceed?", an unseen
  "Finished 2 min ago" turn, an idle thread, and two threads on long tool-less generations
  (numbers in words, poems) busy throughout the capture. The sidebar read pinned, prompt,
  finished, idle, then "Working 2" with the two busy threads, in dark and light; clicking the
  header collapsed it to the header alone, and it stayed collapsed after a reload. Daemon
  log: no warnings or errors. Screenshots: `docs/notes/sidebar-working-section/`
  (`dark-expanded.png`, `dark-collapsed.png`, `light-expanded.png`, `light-collapsed.png`;
  copies in `~/.t3/userdata/attachments/sidebar-working-section/`).
* **What the screenshots are**: this branch's frontend served by Vite and loaded in
  Playwright WebKit (WKWebView's engine) against that live daemon (the dev-only
  `?daemon=&token=` override), not captures of the Wails window. The Wails app built by
  `make gui-build` was launched against the same home (`code-foundry gui`), but the session
  could not screenshot or click it (the screen was locked), so the
  window chrome (traffic lights) is absent in the PNGs.
* Not verified live: an error / interrupted thread in the attention group and a starting
  thread under Working (mock e2e only), keyboard toggling of the header in the Wails window,
  and the cmd+N skip in the real app (mock e2e only).
* Cleaned up: threads removed, GUI, daemon and Vite stopped, `/tmp/cf-working`,
  `~/tmp/cf-working-repo` and `~/.claude/projects/-Users-alex-tmp-cf-working-repo` removed.

## Daemon restart

None needed (frontend only). The mock gained hold / release controls (test-only).
