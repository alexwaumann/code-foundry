# Archived threads, PR 2 of 2: the sidebar

Decided 2026-10-13 (Alex). Frontend only (plus the Playwright mock daemon); stacked on PR 1
(`archive-threads-1-daemon.md`: `SessionView.archivedAtMs`, `session.archive`,
`archiveSession(id, archived)`, confirmation only mid-turn).

## Decisions (with Alex, not up for debate)

* **Stacked panels.** The main thread list (pinned → attention → done → idle, unchanged)
  scrolls on its own and takes the remaining height. Under it, pinned to the bottom
  whatever the main list's scroll:
  * **Working** (busy + starting, unpinned): header "Working" + count, collapsible,
    expanded by default (`workingCollapsed`, as before), up to ~40% of the sidebar body,
    then its rows scroll inside it. Not rendered with no working thread.
  * **Archived** (`archivedAtMs !== null`, whatever the status or pin): header "Archived"
    + count, collapsed by default (`archivedCollapsed`, new, persisted next to
    `workingCollapsed`), up to ~30% of the body. Not rendered with no archived thread.
    Most recently archived first (the only group not in creation order). An archived
    thread appears nowhere else, even if (defensively) pinned.
* **Archived rows are one line**: the name, then right-aligned a short archive age
  (`shortAge`: `0m`…`59m`, `1h`…`23h`, then `Nd`; rounded down), 11px muted tabular-nums.
  Same tooltip, selection, cursor ring and context menu as other rows; height `rowHeight`
  (no second line).
* **Keyboard**: arrows, Home/End, cmd+1..9 and cmd+shift+a walk one order: main list →
  Working → Archived, skipping headers and the rows of collapsed sections. Moving the
  cursor into a footer scrolls that footer's own rows.
* **Actions**: "Archive" / "Unarchive" in the row menu after Pin (lucide `Archive` /
  `ArchiveRestore`), via `archiveSession(id, !archived)`; a `session.archive`
  `CommandButton` in the thread header after `session.close` (`Archive` icon, tooltip
  "Archive Thread"; `ArchiveRestore` and "Unarchive Thread" while archived; run without
  args the command toggles). Confirmation comes from the daemon through runCommand.
* **Selection**: an archived thread may stay selected (the pane shows it disconnected
  with its Reconnect card); nothing beyond what a collapsed Working already does.

## What was built

* `lib/tree.ts`: `ListSession.archivedAtMs`, section `"archived"`, `FooterSection`,
  `ListOptions.archivedCollapsed`, and `buildSections(sessions, opts)` returning
  `{ main, working, archived }` (each footer its header row then its rows; empty when it
  has no threads). `buildRows` is their concatenation, so `sessionOrder`, `nextAfter`,
  cmd+N and `rowCache` work unchanged. In the pure functions an absent option means
  expanded for both footers; the UI store holds the defaults.
* `stores/context.ts`: the list key per thread is now id + pin + group + archive time
  (`encodeSessionListKey`, exported for tests); `getListSessions` / `getListOptions`
  carry `archivedAtMs` and `archivedCollapsed`. Archive time only changes on archive and
  unarchive, so the list still does not rebuild on names or status text.
* `stores/ui.ts`: `archivedCollapsed` (default `true`), `toggleArchivedCollapsed`, saved in
  `code-foundry.ui` by `partialize`, loaded by `merge` (a bad value falls back). No
  version bump.
* `components/sidebar/Sidebar.tsx`: `SidebarList` is one `role="listbox"`
  (`data-testid="thread-list"`, focus, `aria-activedescendant`, keyboard and context menu
  as before) holding three `PanelRows`, each its own scroll container and TanStack
  virtualizer: `sidebar-main` (`flex-1 min-h-0`), then the footers `sidebar-working` /
  `sidebar-archived`, each a fixed 26px header (`SidebarRow` header rendering) above
  `sidebar-<section>-rows`, sized to `min(rows' total height, cap)`. The cap is
  `floor(bodyHeight * 0.4 | 0.3) - 26` (header included in the share), with `bodyHeight`
  the `sidebar-body` element measured by a ResizeObserver (layout px, divided by the page
  zoom like `useColumnHeight` in App.tsx); before the first measurement there is no cap.
  The cursor math uses the one concatenated `rows`; `moveCursor` asks the panel the row
  is in to `scrollToIndex` its local index (`useImperativeHandle` per panel).
* `components/sidebar/SidebarRow.tsx`: `WorkingHeader` became `SectionHeader` (test ids
  `<section>-header`, `-label`, `-count`; `data-row-kind="header"`, `data-section`,
  `data-row-key="h:<section>"`, `role="presentation"` as before); `ArchivedLabel` /
  `ArchivedAge` render the single line (rename works in it too). The age subscribes to
  the shared `useNow(30_000)` clock only while an archived row is mounted (Archived
  expanded and the row in the virtual window).
* `RowMenu.tsx`, `thread/HeaderActions.tsx`: the actions above.
* `stores/archiveCleanup.ts` (`startArchiveCleanup`, started in `App.tsx`'s
  `startApp`): see below.
* `stores/sessions.ts`: `attentionIds` skips archived threads (see below).
* Mock: `MockSession.archivedAt`, `session.archive` (toggle or explicit; archiving closes
  like the daemon, busy becomes ERROR "interrupted", removes the thread's shells, unpins,
  keeps the first stamp; reconnect and pin(true) clear it), `CmdDef.confirmIf` mirroring
  `Command.ConfirmIf` (asked only when archiving a thread that is starting, connected and
  busy, or at a `permission:` / `question:` prompt), `POST
  /__mock/session/archive?id=…[&archived=false]` (what the CLI with `--yes` does), and an
  archived thread `s-7` ("Spike a canvas sidebar", archived 90 min ago, a finished turn)
  in the default world. `DEFAULT_ORDER` ends with `h:archived`.

## Choices made here

* **Three virtualizers, not a virtualized main list plus plain footers.** Working is
  small, but Archived only grows (archiving is how threads leave the list without being
  removed), so it would be the one unvirtualized list in the sidebar. One `PanelRows`
  component serves all three; a footer's height is known from the fixed row sizes
  (`getTotalSize`), so sizing it to `min(total, cap)` needs no measuring of its own.
* **Pixel caps from a measured body, not CSS `max-height: 40%`.** A percentage would
  resolve against the listbox (body minus toolbar, nav and status bar), not the body as
  asked, and depends on flexbox's definite-size rules for a `flex-1` parent; the measured
  height also makes the caps assertable in e2e.
* **Panel reset reacts to the sessions store, not to `archiveSession`.** A subscription
  fires for every `archivedAtMs` null → set transition on a thread the window already
  knew, so an archive from the CLI, the palette, another window or the header button
  closes the panels exactly like the row menu. It resets `session:<id>` in the panel store
  to `emptyEntry` (tabs gone, closed, its stored width too) and in the bottom store to
  `emptyBottom` (closed; the daemon already removed the shells), only for keys that have an
  entry. Not a transition: the first snapshot (threads archived while the window was
  closed keep their stored entries), unarchiving, a re-archive, and panels opened on an
  archived thread afterwards. Table-tested in `archiveCleanup.test.ts`.
* **Archived threads do not count as attention.** Archiving a finished turn leaves its
  status "attention / finished" on the daemon (PR 1), so without this the bell, the window
  title, the start page and cmd+shift+a would keep counting (and jumping to) a thread in a
  collapsed section the user put away. Not in Alex's brief; easy to revert in
  `attentionIds` if he disagrees.
* **Archived rows are not dimmed.** Every archived thread is disconnected, so the offline
  50% dimming would apply to the whole section; the section header already says what they
  are, and only the age is muted.
* **No command or keybinding for collapsing Archived**: Working has none either
  (`sidebar-working-section.md`), so it is the header click (and Space / Enter on the
  header button) only, and no Go change.
* **Text**: exactly "Working" and "Archived" (uppercase by CSS, as before).

## Gotchas

* The listbox is no longer the scroll container. Focus and `aria-activedescendant` stay
  on it (the cursor ring is `group-focus` on it), but PageUp/PageDown no longer scroll the
  main list natively, since the focused element does not scroll. Arrows, Home and End
  scroll the right panel.
* Specs that read rows in DOM order (`rowKeys`) still see one order, because the panels
  are in that order inside `thread-list`; the archived header shows as `# Archived 1`.
* Two Playwright runs at once in the same checkout share `test-results/`; a second run
  cleaned it under the first one, failing an unrelated test on a missing trace file
  (`browserContext.close: ENOENT`). Run one at a time (or with `--output`).

## Verification

* `make check` green: gofmt, vet, staticcheck, `go test ./...`, typecheck, lint, 2122
  vitest tests in 109 files. New or changed unit tests: `lib/tree.test.ts`
  (`buildSections`: split, archived-only-under-Archived even when pinned or waiting, most
  recently archived first with ties newest-created first, collapsed footers keep header
  and count, footers only when non-empty, one order across all three; `rowCache` moves
  only an archived row), `lib/session.test.ts` (`shortAge` table), `stores/ui.test.ts`
  (`archivedCollapsed` default, toggle, save, load, bad value), `stores/context.test.ts`
  (list key round trip with the archive time, `getListSessions` / `getListOptions`),
  `stores/sessions.test.ts` (an archived waiting thread is not attention),
  `stores/archiveCleanup.test.ts` (`newlyArchived` table; the subscription resets only the
  newly archived thread's side and bottom entries, never on unarchive, a later re-open or
  a thread without entries), `SidebarRow.test.tsx` (archived single line, unnamed id,
  header labels and counts), `HeaderActions.test.tsx` (order with `session.archive`; the
  button's title and icon follow the archive state).
* `make gui-e2e`: 673 passed, 28 skipped (live specs), 1 failed:
  `panel.spec.ts:851` in Chromium (dragging a tab, then a plain click on another tab did
  not activate it). Rerun alone it passed 15 of 16 (`--repeat-each 8`, both browsers;
  the one failure the same step) and then 20 of 20; it is the panel tab strip's drag sensor, which
  this change does not touch, but I did not check whether it also flakes on main. The
  earlier full run on this branch (before the spec updates) failed only the expected
  order assertions (`app`, `sessions`, `sidebar` specs), all green on rerun after the
  updates (118/118 for `app`, `sessions`, `sidebar`, `archive`, `composer-skills`,
  `zoom-popovers`).
* New `e2e/archive.spec.ts` (10 tests over both browsers): collapsed by default with
  "Archived 1", below Working; expanded single-line rows with "1h", 15px shorter than a
  thread row, same x as the main rows, the row tooltip; expanded survives a reload and is
  in localStorage; unarchive (CLI-style mock control) removes the section; Space toggles
  it. Row menu Archive (no confirmation for an idle thread, invocation args) moves s-3 out
  of the main list and first under Archived ("0m"); Unarchive brings it back idle.
  Archiving busy s-1 from the header button opens the daemon's confirmation; after OK it
  stays selected with the Reconnect card, its side and bottom panels are gone and its
  panel entry is empty; the header button turns into Unarchive; a CLI-style archive of
  another selected thread closes its side panel too. Keyboard order main → Working →
  Archived, cmd+7 on the archived row, collapsed sections skipped by ArrowUp, End and
  cmd+N. With 30 idle and 12 busy extra threads: the main list scrolls, the Working and
  Archived headers stay in the viewport and in place whether it is at the top or the
  bottom, Working is at most 40% of the body and scrolls its rows, End scrolls Working
  to its last row, Home scrolls the main list back.

* `make gui-build` green.
* **Live** (2026-10-13; isolated `CODE_FOUNDRY_HOME=/tmp/cf-archive-ui`, the built GUI
  starting this branch's daemon, scratch repo `~/cf-scratch-archive-ui`, haiku / low):
  six short threads (four "Finished", two closed and dimmed), one that ended "Error ·
  error" (a 1500-number generation that hit Claude's limit; unrelated), two long
  generations under Working, and two threads archived from the CLI
  (`code-foundry session archive --id …`), which moved into the collapsed "Archived 2"
  footer at once. Expanded: single-line rows "Spike a canvas sidebar 1m", "Old
  bottom-panel experi… 1m". The bell read 7 (six finished + the error; the archived
  finished thread not counted). When a Working thread finished, it moved up into the main
  list and the footers shrank under it. Daemon log: no warnings or errors.
* Screenshots (the Wails window, by PID, dark and light via `settings set
  appearance.theme`, put back to `system`):
  `~/.t3/userdata/attachments/archive-sidebar-dark.png`, `archive-sidebar-light.png`
  (copies in `/tmp`).

  ```
  make build && make gui-build
  CODE_FOUNDRY_HOME=/tmp/cf-archive-ui CODE_FOUNDRY_BIN=$PWD/bin/code-foundry "./gui/bin/Code Foundry" &
  code-foundry repo add ~/cf-scratch-archive-ui; code-foundry session.new --repo … --model haiku --effort low …
  code-foundry session archive --id <id>
  osascript -e 'tell application "System Events" to set frontmost of (first process whose unix id is <pid>) to true'
  osascript -e 'tell application "System Events" to get {position, size} of window 1 of (first process whose unix id is <pid>)'
  screencapture -x -R x,y,w,h out.png
  ```

  `click at` through System Events is refused here (-25208, no assistive access), but a
  CGEvent click from a small compiled Swift helper (post `leftMouseDown` / `Up` at screen
  points to `cghidEventTap`) worked, which is how the Archived header was expanded. The
  window shares the installed app's WebKit localStorage, so Archived was collapsed again
  before quitting (Working was not touched). Everything removed afterwards: threads,
  `/tmp/cf-archive-ui`, the scratch repo and its `~/.claude/projects` directory.
* Not verified live: the row menu's Archive / Unarchive, the header button and its
  confirmation dialog, the side / bottom panel reset, keyboard order across footers and
  the caps with a long Working list (all mock e2e only); the main list scrolling under
  the footers in the real window (the window was tall enough for every row).

## Daemon restart

Yes, for PR 1: it added `SessionService.Archive` and migration 0017. Against an older
daemon `archivedAt` is never set (no Archived section) and `session.archive` is not
listed, so the menu item fails with the daemon's unknown-command error and the header
button hides.
