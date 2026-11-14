# The window shell: what was built

The summary of the shell build: what the shell is, the step notes in order, where the build
departs from its plan, and what is deliberately left out. The specification is
`docs/notes/shell-model.md`; the architecture is `docs/ARCHITECTURE.md` §7 (commands and keys),
§8 (the window) and §14 (layout). The build plan, `shell-plan.md`, was removed before the merge to
`main`, as the specification said; it is in git history (its last version is on the `shell`
branch before PR 23).

## The shell in a page

The window is a top bar, a sidebar and the current space's pane grid. A **space** is a named
layout with its own threads; the top bar holds the space tabs, back and forward, and "+". A
space is a tree of **panes**, each a strip of **tabs**; a tab shows a surface: a thread, the
composer (or a draft), a diff, a file, a pull request, a terminal, MCP, a gallery, Ember's
board, a plugin's surface, the Pull Requests page or the Projects page. A **linked** tab
belongs to a thread (a row under the strip names it and links back); placement puts it beside
its thread by six rules, smart swap switches panes to the focused thread's tabs, and closing a
thread's tab remembers its linked tabs so they come back with it. Each thread has a **quick
terminal** under its conversation (cmd+j). A small window folds panes to rails; any pane can
go full screen, with the thread's composer floating over a linked tab. The sidebar's **Needs
you** lists the threads that wait on the user, with a hover card and a popup to answer.

The daemon holds the layout (`internal/layout`, pure; `internal/store/layout`, one writer;
`LayoutService`; the `layout` event source; `internal/daemon/layout.go`, the glue to threads
and terminals), so a key, the palette, the CLI and a thread's model run the same ops through
the same commands (`layout`, `space`, `pane`, `tab`, `composer`, `view.open`, `terminal`). The
GUI renders the published layout and keeps only what depends on the drawn frame. A first
window imports the classic window's stored panels once. The side panel, the bottom panel,
their stores and their verbs are gone.

## The step notes, in order

1. `shell-1-layout-model.md`: the pure model, tree and space ops, decode and repair, plain
   rectangles, the identity table and the shared JSON cases.
2. `shell-2-placement.md`: placement rules 1 to 6, a thread's tab and its remembered set,
   close and restore, move, archive, snooze, smart swap.
3. `shell-2b-drafts.md`: the empty composer and drafts as two kinds of compose tab.
4. `shell-3-layout-store.md`: the SQLite store, `LayoutService`, the `layout` event source.
5. `shell-4-commands.md`: the space, pane, tab, thread and composer verbs; `KeepFocus` for
   calls from a thread; the viewport.
6. `shell-5-terminal.md`: free shells, the quick slot, `terminal.reset` and `rerun`, live
   directory, foreground and last command.
7. `shell-6-lifecycle.md`: thread and terminal events reach the layout (the glue,
   `ShellsGoing`), `terminal.quick`, `terminal.cycle`.
8. `shell-7-view-open.md`: `view.open.*` place linked tabs; the `view.panel.<item>` aliases.
9. `shell-8-host-seam.md`: surfaces reach their tabs through `shell/host.ts`.
10. `shell-9-geometry.md`: minimums, rails, tab fitting, neighbours (pure).
11. `shell-10-layout-slice.md`: the layout slice, its API mapping, the mock's layout.
12. `shell-11-pane-grid.md`: the pane grid, strips, focus, the selection bridge (behind a flag).
13. `shell-12-linked-tabs.md`: the row under the strip, the pane's "+", the thread header.
14. `shell-13-terminals.md`: terminal tabs and the quick terminal.
15. `shell-14-drag.md`: dragging tabs and panes; `shell-14b-outer-edge-size.md`: an outer-edge
    drop takes its kind's size.
16. `shell-15-spaces.md`: the top bar, spaces, the focus history.
17. `shell-16-sidebar.md`: the sidebar's sections and rows, drafts as the user types, rows that
    drag.
18. `shell-17-needs-you.md`: the hover card, the popup, the top bar control, the ask strip.
19. `shell-18-legacy-import.md`: the daemon half of the first-load import.
20. `shell-19-rails-fullscreen.md`: rails and full screen with the floating composer.
21. `shell-20-cutover.md`: the shell is the window; the key table; the GUI half of the import;
    a migration rehearsal. `shell-20b-gaps.md`: four gaps it found.
22. `shell-21-remove-classic.md`: the classic window, its panels and stores removed; 199 e2e
    tests rewritten or deleted; 24 gaps found.
23. `shell-gaps-a-focus.md`, `shell-gaps-b-surfaces.md`, `shell-gaps-c-identity.md`: those gaps
    fixed (focus and the command context; surfaces in panes; tab identity in the host seam).
24. `shell-22-retire-verbs.md`: the panel verbs and the legacy view intents retired; a file
    request lives in its tab's params; the diff pick moved to the daemon.
25. This note (PR 23): the architecture, the guide, the skills and comments.
26. `shell-24a-import-moves.md`: import and move hardening before the merge.
27. `shell-review-fixes-daemon.md`: the daemon's findings of a review of the whole branch
    (a removed space keeps its threads' terminals, archived threads open in the current space,
    a snooze keeps other spaces' terminal tabs, drafts are the user's, a page's reset of a
    command line asks, the glue catches up on dropped events, a newer build's layout is not
    written over, a sidebar drop is one command).
28. `shell-24c-last-pass.md`: the last pass before testing: the newer build's line, the text left
    for later, the Code tab measured, a seeded fuzz of the grid, fixes from the files the review
    did not reach, the specification walked on a real daemon (its differences, ranked), and 200%
    zoom.
29. `shell-24d-spec-differences.md`: four of the last pass's differences and a stuck window: the
    quick terminal back after a snooze, the header over a too-narrow thread pane's composer, what a
    thread is told when it opens a surface of a closed thread and whose tab is already open, and a
    daemon without the layout service (a "dev" one) noticed by the window, with Restart Now.
30. `shell-25a-test-feedback.md`: the owner's test feedback: thread info per thread (with
    `thread.info` and the setting `layout.thread_info`), wider edge drop zones, the focused pane's
    accent border, one button for the floating composer's chip, one fold rule for widths and
    heights (a column folds whole), woken threads out of Needs you, the collapsed sidebar's control
    after back and forward, and amber draft rows.
31. `shell-25b-audits.md`: audits of the direction keys (the pane focused last wins, on the frame
    as drawn now, moves queued), the drop highlight (a pane's middle and a rail replayed as the
    daemon's op leaves them; Go-generated `neighbour.json` and `drops.json` shared with the GUI)
    and full screen's Escape typed in a prompt.
32. `shell-25c-keys-drafts.md`: the owner's second round: cmd+shift+t reopens the last closed tab
    or pane (`tab.reopen`, a per-space history in the layout), cmd+t opens a free home terminal
    where no thread is focused, Needs you lists only actionable asks, draft rows take a thread
    row's lines, and a thread's unsent composer text survives a restart.
33. `shell-25d-collapse.md`: any pane collapses to a rail on demand (`pane.collapse`,
    cmd+shift+m, a strip button), kept per pane in the daemon's layout; a divider stops at the
    minimum from what is drawn and says with its cursor which ways it can still move.

## Where the build departs from the plan

- **The first space starts empty.** The plan's import opened the thread last viewed; the
  specification dropped that (no "last viewed" exists), so the import opens nothing and every
  thread's old panels become its remembered set (18).
- **Placement may join a pane that holds a thread tab**, and a thread's own tab opens in the
  focused pane; terminals follow the same rules as every surface (no "below", no family rule)
  (2, against the toy).
- **Rule 5 never shrinks a new pane**: it opens at its kind's size or not at all (2).
- **Smart swap runs on any focus gain**, not only on `focus_tab` and `open_thread` (2).
- **`State.DefaultSpace`** is stored, not "the first space by position" (1, 3).
- **Commands call the store**, not the service; `KeepFocus` applies to every op called from a
  thread, not only those with a `focus` flag (4).
- **No `view.open.prs` or `view.open.projects`**: `view.pullrequests` and `view.projects` are
  those verbs (7). `view.thread-diff` and `pane.fullscreen`, `tab.rename` and `tab.auto-name`
  were added for the keys (7, 13, 19, 20).
- **An outer-edge drop takes its kind's default share**, raised to its floor; a drop on a
  pane's edge splits it in half (14b).
- **Running terminals at first load**: only terminals alive at import time come over; an
  update's daemon restart has already ended the old daemon's (20). The specification's
  wording says so.
- **A diff's identity reads its asker**: a thread that frames a diff gets its own tab, and a
  call that frames nothing shows the user's tab with the file picked by the daemon (gaps C, 22).
- **A file request lives in the tab's params** (`asker`, `askId`), written by the daemon; the
  window's half of the item verbs (`threadPanelIntent.ts`) is gone (22).
- **The interim key table** (`shell/keys.ts`) and the shell flag existed only until the cutover;
  the key table is the commands' `Keybindings` (20, 21).
- **Plugin surfaces' width**: no longer the side panel's 420 px; a surface is as wide as its
  pane, at least 300 px (the default pane minimum), about 400 px beside a thread in a 1440 px
  window, the whole grid in full screen. The plugin skill says so (this PR).

## Not in this change

From the specification: thread colours, drawers inside a thread pane, panes that follow focus,
replacing a tab on a sidebar click, a file browser surface, content search across files, and
the surface contract for plugins beyond the identity rule.

Left by the step notes, de-duplicated:

- **The `view.panel.<item>` aliases** go one stable release after the shell ships (`openAlias`,
  `withAliases`, the mock's `alias`), with a `refactor(command)!` (7, 22).
- **The capabilities group is still named `panel`** (`daemon.capabilities --group panel`): a
  rename changes its JSON and the skills that name it; left as is.
- **`open_surface`'s `behind`** has no caller since 22: keep it if a user-side open should ever
  wait behind an editor, else remove it with its op cases (22).
- **An item verb's `--focus`** moves the layout's focus; only a file request moves the keyboard
  (22).
- **Viewport per window**: placement uses the newest report of a visible window (6); nothing
  stores it across restarts.
- **Terminals across a daemon restart**: none survives, and the sweep closes their tabs;
  bringing them back as fresh shells, as after a snooze, is a possible follow-up (6).
- **A free shell with no tab** (started through `TerminalService.Create`) is never ended by the
  layout; only its exit removes it (6). The "+" menu's Terminal lists such terminals (12).
- **An old window on a new daemon** runs the new chords (cmd+j becomes `terminal.quick`), which
  can make a space "arranged" before the import, so the first load is not one empty space;
  say so in the update notes or treat such a tab as automatic (20, finding 2).
- **A thread snoozed in the classic window** comes back with no tabs (20, finding 3).
- **`SHELL_SINCE`** is re-derived at the merge to `main` from the version the merge produces
  (20).
- **Escape in a full-screened thread's own prompt** does not leave full screen; a rail could
  take a whole pane's drag (19).
- **The Needs-you popup** shows the whole conversation, virtualised; a cap could come if a long
  thread opens slowly there. An optimistic leave of the row after Allow or Deny (17).
- **The mock daemon** ports no smart swap, no placement rules 2 to 6 and no restore; it does not
  close a thread's quick terminal when its shell goes and always focuses a new terminal tab
  (10, 21).
- **`SurfaceSpec.available`, `warm`, `openDefault`, `hotkey`** look unused since the side
  panel's surface list went (21).
- **The pull request's Code tab** keeps its own scroll anchoring across a width change (the
  library's; measured in 24c); the File and Diff tabs use `useKeepTopLine` (gaps B).
- **A provisional (italic) thread name** shows plainly in its tab and header; the
  stale-plugin-environment dot went with the classic title (21).
- **Some e2e titles** still name the bottom or side panel (kept so the cutover's table maps)
  (21).
- **The hello example plugin's corpora** (`internal/store/plugin/testdata/hello-demo`) keep the
  old intro texts this PR changed in `plugins/examples/hello`; they are fuzz seeds, not goldens.

## This PR (23)

- `docs/ARCHITECTURE.md`: the packages, `LayoutService` and the `layout` source, the terminal
  store's additions, the command families and the key table (§7), the window (§8: top bar,
  pane grid, the layout slice, geometry, surfaces and the host seam, focus, drag, full screen,
  terminals, the first draw, the sidebar, pages and the composer as tabs), the stream rule
  with what counts as off screen, and a new §14 for the layout. The side and bottom panel
  descriptions are gone. `CLAUDE.md`: `text-brand` is the top bar's app name.
- `docs/GETTING-STARTED.md`: a "The window" section (panes, tabs, spaces, full screen, the
  quick terminal and terminal tabs), Needs you under "While it runs", no side panel. Its
  section list test (`components/help/guide.test.ts`) gains the section.
- Skills: the welcome tutorial says "a tab beside this conversation" (the prompt in
  `stores/welcome.ts`, the help skill, `code-foundry-pages/reference/welcome.md`, the page's
  demo sentence). The prompt's wording is measured (`welcome-page.md`), so it was run again:
  a daemon from this branch on a scratch home under the home folder (removed after), a
  no-project thread on Sonnet 5.5 at medium effort sent the new prompt; it ran
  `view.open.page <path> --title Welcome` (`layout show`: a File tab "Welcome" linked to the
  thread) and replied with exactly the new line, no inline card, in 8.7 s. A first try with
  the home under /tmp failed for an unrelated reason: a page outside the home folder has no
  bridge, so the thread asked how to show it. The plugin skill and its references describe a surface as a tab as wide as
  its pane (300 px at least, the body padded 16 px a side, 12 under 340), with "Open in a tab"
  for an owned terminal and the acting tab's context for acts and command buttons.
  Budgets, before → after (bytes): help body 5,286 → 5,296 (5,500); plugin description 406 →
  402 (420), body 5,044 → 5,033 (5,500); `ui-layout.md` 17,811 → 17,994, `primitives.md`
  18,897 → 19,063, the other references within a few dozen bytes (32 KiB each). Nothing was
  trimmed: every change fit.
- Comments that described the side or bottom panel as present, and every comment citing
  `shell-plan.md`, now name the shell or a step note; comments about the classic window as
  history stay. Text a user sees that was wrong: the action dialog ("opens as a terminal
  tab"), the hello example plugin's intro lines, the mock's copies of daemon descriptions.
