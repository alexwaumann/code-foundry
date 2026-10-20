# Hidden child threads, PR 2 of 2: the GUI (2026-10-20)

PR 1 (`hidden-children-1-daemon.md`, #266) gave the daemon the setting
`threads.show_created_threads` (default off), the per-thread override
`ThreadView.inSidebar` (null follows the setting), `thread.sidebar --shown`,
`thread.new --sidebar` and the archive cascade through hidden descendants. This PR is the
GUI: a thread another thread created is its creator's to manage, so by default it is in
no sidebar list and counts nowhere the user is asked for attention; it is reached through
its creator's Threads tab, the palette and links.

## Decisions (with Alex, 2026-10-20; not up for debate)

* **One rule, reimplemented once**: `lib/inSidebar.ts` `inSidebar(thread, showCreated)`:
  no creator → shown; override set → the override; else the setting. Table-tested.
* **Sidebar**: hidden threads are in no list: main, Working, Snoozed, Archived. They stay
  in `ThreadsData.order` (the Threads tab, palette and `@thread` list them); the owned
  (plugin) mechanism is not reused. Keyboard, cmd+1..9 and cmd+shift+a walk the built
  rows, so they follow. The list reacts live to the setting and to an override.
* **Attention**: the Dock badge and alerts, the bell, the window title, cmd+shift+a and
  the start page ignore hidden threads.
* **Selection**: a hidden selected thread highlights its nearest shown ancestor (walk
  `createdBy`; none → no row), derived in a selector, no state. The pane shows the hidden
  thread as usual.
* **Focus on creation**: a focusThread for a hidden thread just created does not switch
  the view.
* **Actions**, all `thread.sidebar` through `runCommand`: the row menu's "Hide from
  sidebar" (`EyeOff`) on a thread with a creator (a listed row is shown); in the Threads
  tab, a hover "Show in sidebar" / "Hide from sidebar" (`Eye` / `EyeOff`, tooltip only)
  on each sibling and child row, and a muted "hidden" word before the status of a hidden
  row; a header `CommandButton` beside Archive for a thread with a creator.

Decided while building (flagged for review):

* **Which focusThread to skip.** The intent carries no "just created" flag (thread.new,
  thread.fork, the `pr.*` threads and `thread.focus` all send the same one), and this PR
  is frontend only. So `threadFocus` (`lib/inSidebar.ts`) skips a hidden thread created
  less than 10 s ago (`NEW_THREAD_FOCUS_MS`) and selects anything else: a
  `code-foundry thread focus` on an older hidden thread still shows it. If that reads
  wrong, a `created` bool on `UiIntent.FocusThread` would make it exact.
* **An intent may beat its thread.** The events hub runs one tap per source, so the
  focusThread can arrive before the thread list has the thread. Before, the GUI selected
  the unknown id at once; now it waits (up to `PENDING_FOCUS_MS`, 10 s, the terminal
  wait's) for the thread to arrive and decides then. A selection change, another
  window-moving intent or the timeout drops the wait; a thread that never arrives is no
  longer selected.
* **The header button and the palette toggle.** `thread.sidebar` requires `shown`, so a
  bare `CommandButton` would open the arg prompt. A presenter (`keys/bindings.ts`,
  `toggleThreadSidebar` in `stores/threadActions.ts`) sends the opposite of what the rule
  says now, and `thread.sidebar` is palette-supplied, so the palette toggles too. On the
  user's own thread (no creator) the palette still offers it and the daemon refuses with
  its own message (the header has no button there).
* **Arrow keys from the highlight.** The keyboard cursor used to survive selections made
  elsewhere (the palette, a link), so arrows moved from a stale row. Now a change of the
  highlighted row drops a cursor on another row (a row's own click or Enter sets the
  cursor first, so it stays), and a cursor whose row is gone (hidden, collapsed) falls
  back to the highlighted row.
* **The start page** counts and lists shown threads only, running ones included, so a
  hidden child does not appear there when it starts and vanish when it waits.
* **Archived children stay in the Threads tab**, marked Archived, as every archived
  thread there does (`agents-3-lineage-gui.md`); "removed from the tab" in the brief is
  read as that. Hidden archived threads are not in the Archived footer either.
* **The Threads tab's action** sits beside the row's button (a button cannot nest in
  one), absolutely placed over the age on line 2, which hides while the row is hovered
  or the action has keyboard focus. Only siblings and children get it (This thread has
  the header button; the creator row stays a plain link, as the brief lists siblings and children). The "hidden" mark is
  on any hidden row, This thread and the creator included.
* **Turning the setting on** (or showing a waiting child) while the window is not
  attended alerts like any thread entering the attention set: the user's set grew.

## What was built

* `src/lib/inSidebar.ts` (new): `inSidebar`, `sidebarAnchor` (cycle safe),
  `threadFocus`, `NEW_THREAD_FOCUS_MS`. A view without the field (`typeof` check) follows
  the setting.
* `stores/settings.ts`: `KEYS.showCreatedThreads`, `showCreatedThreadsOf(snapshot)`,
  `getShowCreatedThreads()`, `useShowCreatedThreads()` (off until a snapshot says true).
* `lib/tree.ts`: `ListThread.hidden?`; `buildSections` drops hidden threads before
  grouping, so no panel, header count or keyboard order has them.
* `stores/context.ts`: the list key gains a hidden flag; `useThreadListKeys(showCreated)`,
  `encodeThreadListKey(id, x, showCreated)`, `getListThreads(showCreated)`. Parameters,
  not imports: `settings.ts` imports `commands.ts`, which imports `context.ts`.
* `stores/threads.ts`: `attentionIds`, `runningCount`, `activeThreadIds` and
  `useAttentionCount` take `showCreated`; callers (`App.tsx`, `SidebarToolbar`,
  `StartPage`, `keys/bindings.ts`, `stores/dockAlerts.ts`) pass the setting.
  `dockAlerts` re-evaluates when the setting changes.
* `components/sidebar/Sidebar.tsx`: `useSelectedRowKey` (the anchor), the cursor rules
  above.
* `stores/intents.ts`: `focusThread` with the pending wait.
* `components/sidebar/RowMenu.tsx`, `components/thread/HeaderActions.tsx`
  (`SidebarButton`), `components/lineage/ThreadsSurface.tsx` (`SidebarToggle`, the mark),
  `stores/lineage.ts` (`useSidebarShown`).
* Mock (`mock/world.ts`, `server.ts`, `settings.ts`): `MockThread.inSidebar` (published
  when set), the setting in the schema, `thread.sidebar` (refused without a creator),
  `thread.new` `created-by` and `sidebar` (validated like the daemon), the archive
  cascade (`archiveCascade`: tree order, 8 levels, through archived hidden ones, a shown
  thread cuts its branch; unarchive does not cascade) and its confirmation text
  (`hiddenWorkingText`, the daemon's), `POST /__mock/thread/sidebar`. The lineage fixture's
  "Tidy redirect logging" is shown by its override.
* `docs/GETTING-STARTED.md`: one paragraph under "While it runs".

## Gotchas

* The lineage specs that test the lineage itself now turn the setting on first (their
  rows are created threads); the hidden-children block runs with it off.
* The default world plus the lineage has three created threads waiting (a finished
  turn, a permission prompt and an API error, which is NEEDS_ATTENTION too), so turning
  the setting on adds 3 to the bell.
* The agent session's worktree hook refuses some compound shell commands and heredocs;
  edits went through the edit tool or one-line scripts, and `git` outside the worktree is refused, so the live scratch project was a plain folder (a no-git project).

## Tests

* Unit: `lib/inSidebar.test.ts` (the rule, `threadFocus`, `sidebarAnchor`),
  `lib/tree.test.ts` (hidden threads in no section or count, footers with only hidden
  threads not rendered, keyboard order, a shown one in its place), `stores/context.test.ts`
  (key round trips with the rule, `getListThreads`), `stores/dockAlerts.test.ts` (the
  attention table with the setting and overrides; a hidden child never badges, showing it
  or the setting does), `stores/intents.test.ts` (focus table, the pending wait and its
  drops), `stores/threadActions.test.ts` (the presenter), `HeaderActions.test.tsx`,
  `RowMenu.test.tsx` (new), `surfaces/threads.test.tsx` (mark, actions, live override).
* e2e `e2e/lineage.spec.ts`, "hidden children": absent from every list and the bell with
  the setting off, present when the Settings page toggles it on, gone again when the file
  turns it off; cmd+shift+a and cmd+1..9 over shown rows only; the Threads tab's mark,
  hover action and tooltip both ways; the row menu's Hide; a hidden child (and
  grandchild) open highlights the creator, arrows move from it, the header button shows
  and hides it; `thread.new --created-by` does not take the view, with `--sidebar` it
  does; archiving the creator asks with the daemon's text, archives the hidden ones (the
  grandchild too) and keeps the shown one.

## Verification

* `make check` green; `make gui-e2e` green (478 passed after the rebase onto #267, 26 skipped live specs, 4 WebKit
  workers, no flakes on the run).
* Live (2026-10-20, `make gui-build`, the built GUI with `CODE_FOUNDRY_HOME=/tmp/cf-hidden2`
  and this branch's `bin/code-foundry`, a plain scratch folder `~/cf-scratch-hidden2`
  registered as a project, threads on `claude-haiku-5-5[1m]` at medium):
  * The parent "Split the README work" (started from the CLI, so the GUI focused it) had
    its Claude run `code-foundry thread new` twice. Neither child appeared in the sidebar,
    the view stayed on the parent (both focus intents skipped), and the bell stayed empty
    with both children finished. The parent's Threads tab listed them with "hidden".
  * Hovering a child in the tab showed the eye with its "Show in sidebar" tooltip; a click
    added "List README headings" to the sidebar (↳, "Finished 5 min ago") and the bell
    went to 1; the tab's mark went away.
  * Opening the hidden "Count README words" from the tab: the pane showed it with the
    header's eye beside Archive, and the parent's row was the highlighted one. The header
    button showed it (its own row then highlighted) and hid it again.
  * The row menu's "Hide from sidebar" (after Archive) on "List README headings" took its
    row out.
  * Settings › General › Threads showed "Show threads created by other threads" (off).
    A child created from the shell with `--created-by` while it was off did not appear and
    did not take the view; switching it on listed that child at once (bell 1), the two with
    an explicit hidden override stayed hidden; off again removed it.
  * With one child shown again and another hidden child (supervised) waiting on a Write
    permission, Archive in the parent's header asked: "Archive thread Split the README
    work? 1 hidden child thread is still working; archiving ends its turn and archives it
    too. To keep it, ask Split the README work to hand it over (code-foundry thread sidebar
    --shown=true) or show it in the sidebar first." After OK the daemon logged three
    cascaded archives and the root (`cascaded=3 cascade_failed=0`); the shown child stayed
    in the sidebar, the Archived footer counted only the parent, the start page said "1
    waiting on you". The archive took ~10 s: one hidden child had a background shell, so
    its Claude only stopped at the close grace (a WARN, existing behaviour); a second click
    on Archive in that window got a second confirmation for the thread being archived.
  * Screenshots (dark and light) in the PR body. Theme put back to `system`; the side
    panel was the archived parent's (reset by the archive); Archived stayed collapsed.
    The GUI and the isolated daemon were stopped and `/tmp/cf-hidden2`, the scratch folder
    and its `~/.claude/projects` entry deleted.
* Not verified live: cmd+1..9 / cmd+shift+a and the arrow keys (no keyboard events could
  be sent to the window here; mock e2e), the Dock badge itself (the bell, which counts the
  same set, was checked).

Daemon restart needed: no (frontend only; needs the #266 daemon).
