# Shell PR 16: sidebar sections and the thread row

Sixteenth PR of the shell stack (`docs/notes/shell-plan.md`, section 4). With the shell flag on and
the shell drawing the window, the sidebar has the spec's sections (Needs you, Active, then Working,
Snoozed and Archived), the three-line thread row, the space's composer drafts, Open ▸ in the row's
menu with Move to space ▸, and rows that drag into the pane grid, onto a rail and onto a space tab.
A compose tab becomes a draft as the user types. Settings has `layout.smart_swap` and
`sidebar.needs_scope`. With the flag off (or while the shell waits for its layout) the sidebar is
exactly today's. Rebased onto PR 15 (top bar and spaces) and PR 19 (rails and full screen): the
sidebar sits under the top bar, which holds the app name and back and forward.

## What is in it

| File | Holds |
| --- | --- |
| `lib/shellSections.ts` | pure: the sections from the classic list's inputs plus each thread's space, the scope, the drafts and the collapse prefs; the keys' thread order |
| `stores/shellList.ts` | the hooks the list reads (threads' spaces, the current space's drafts, the scope setting); `sidebarThreadOrder` for cmd+1..9, thread.next/previous and cmd+shift+a |
| `stores/shellSidebar.ts` | Needs you's and Active's collapsed state, persisted (`code-foundry.shellSidebar`) |
| `components/sidebar/shell/ShellSidebarList.tsx` | the list: panels of measured rows, keyboard, cursor, context menus, footers |
| `components/sidebar/shell/ShellRows.tsx` | the thread row, a Needs you row, a draft row, the two headers and the scope button |
| `components/sidebar/shell/ShellRowMenus.tsx` | the thread row's menu (Open ▸, Move to space ▸, then the classic row's items) and a draft's (Open, Discard) |
| `shell/drafts.ts` | `composer.draft.open` / `composer.draft.discard`, run quietly |
| `shell/drag/threadDrop.ts` | a dropped row: `thread.open` into a pane, then the `tab.move` its place needs |
| `shell/drag/{targets,drop,draggable,announce,state}.ts`, `ShellDnd.tsx` | the `thread` drag source; the context now wraps the sidebar too (`ShellDndRoot` in `App.tsx`; the top bar stays outside it, found in the document) |
| `shell/spaces.ts` | `spaceDropCommands` takes a `thread` source: `thread.space.move` |
| `shell/composerDrafts.ts`, `lib/draftLabel.ts` | a compose tab's draft as the user types: start, relabel, clear; the text kept in localStorage and dropped with the draft |
| `lib/compose.ts`, `stores/compose.ts`, `Composer.tsx`, `ComposeTab.tsx`, `shell/surfaces/compose.tsx`, `Shell.tsx` | a target may carry a draft id (its own key `draft:<id>`); `draftId` and `onTextChange` on the Composer; a draft's tab named by its label |
| `Sidebar.tsx`, `SidebarMenu.tsx`, `SidebarRow.tsx`, `RowMenu.tsx` | small: the switch, `pages`, exported row parts, `lead`/`terminal`/`keepFocus` |
| `ThreadSurfaceItems.tsx`, `menuKit.ts` | the Open ▸ and Move to space ▸ items take a menu kit (a context menu's for the row) |
| `internal/store/settings` | `layout.smart_swap` (bool, true), `sidebar.needs_scope` (all, space), groups `layout` and `sidebar`, section Appearance › Panes and sidebar |
| `internal/store/layout/store.go`, `internal/daemon/stores.go` | `Options.SmartSwap`, read at every op (`core.Options.NoSmartSwap`) |
| `mock/settings.ts`, `mock/world.ts`, `mock/layoutVerbs.ts`, `mock/server.ts` | the two settings, `settings.set`, the five `composer.draft.*` verbs, `POST /__mock/shell-sidebar` |
| `e2e/shell-sidebar.spec.ts` | title wrapping, hover geometry, drags into the grid and onto a rail, typed drafts, SHOTS |

## Decisions

- **Needs you is the "prompt" group** (`lib/thread` `threadGroup`): a permission, a question, a
  plan, a woken snooze, a plugin's attention flag. Failed and interrupted threads stay in Active
  where today's attention band put them (after the pinned ones), and finished turns stay in Active
  too: the spec's Active order is "pinned, then finished, then idle", and an error is not an ask.
  A pinned thread that asks is listed under Needs you only.
- **Only the user's own threads**: a thread another thread created is `hidden` (lib/inSidebar), so
  it is in no section, as today.
- **Scope**: all spaces, or the current space. With either, a thread of the current space that asks
  is never under Active. The header shows while any thread in any space asks, so the scope button
  stays reachable when this space has none (its count is then hidden). Most recent ask first.
- **The scope button** is one pill that names the scope in force ("All spaces" with a layers icon,
  "This space" with a square) and switches it with `settings.set sidebar.needs_scope`: a command,
  global, so every window follows. It fits beside "Needs you N" at the 260px minimum width. Its
  tooltip says what a click does (not on screen).
- **Counts**: Needs you shows its count always (the inbox's number); Active only while collapsed.
  Both collapse, remembered per window (localStorage), as the footers' are.
- **Current space only** for Active, Working and Snoozed; Archived lists every space's. Each
  thread's space is `spaceOfThread` over the layout slice.
- **A separate list component**, not a generalised `SidebarList`: the classic list goes when the
  shell is the window, and its rows are fixed-height while these are measured. Keyboard, cursor,
  Ember's row, the context menu and the footers behave as the classic list's. The footers' headers
  and the Snoozed and Archived rows are the classic components.
- **The row**: line 1 the made-by glyph, the place icon, the project (or the house and "No
  project"), the pin, and on the right the status (`RowStatus`), replaced on hover by the existing
  snooze and archive controls (`HoverSlot`, so the title never moves); the title at full width,
  `line-clamp-2`; line 3 the branch with the counts and the pull request tag on the right, only
  when the thread has a branch line (`rowHasBranchLine`) or something to count. Rows are measured
  (TanStack's `measureElement`), since a title takes one or two lines.
- **A Needs you row** is line 1 (place, the ask's icon and word in its tone: "Permission",
  "Question", a plugin's name) and the title. No controls and no hover card yet (PR 17).
- **A click** is `select()` as before, which the selection bridge turns into `thread.open --focus`:
  a tab in the focused pane, or the thread's tab focused when it is open. A Needs you row of
  another space opens there by the daemon's rule.
- **Drafts** sit under the pinned threads, newest first: a pencil and "Draft" (and "· project"
  when it starts in one) on line 1, the label as the title in regular weight, "Untitled draft"
  muted and italic when it has none. A click is `composer.draft.open --focus`, Discard (on hover,
  and in its context menu) `composer.draft.discard`. The row of the focused draft is highlighted.
- **The row's menu**: Open ▸ first (`ThreadSurfaceItems` with a context menu's kit: a diff per
  checkout, its pull requests, its terminal tabs, New terminal tab), then the classic row's items
  without "New terminal here" (Open ▸ has the tab). The verbs run with the row's thread as their
  context, not the window's: end to end, Open ▸ Diff of a closed thread while a no-project thread
  was focused was refused ("not available in this context") until it did. For a closed thread the
  daemon puts the surface in the focused pane; for an open one, by the placement rules.
- **Dragging a row**: a `thread` drag source. A thread whose tab is open in the space drags as that
  tab (a move). A drop is `thread.open` into the target's
  pane (the focused one for the outer edge), then `tab.move` to the strip place, the pane edge or
  the outer edge; nothing more for a pane's middle, or when the thread replaced the space's lone
  empty composer. The strip index is adjusted for where the open put the tab. The preview is the
  same `treeAfterDrop` with a new pane and nothing leaving the tree. A rail is one target as a
  whole (PR 19), so a row dropped on it is `thread.open --pane <the rail's pane>`, whose focus
  unfolds it.
- **A row onto a space tab** moves its thread there with `thread.space.move` (its linked tabs in
  its space go along), open or not (`spaceDropCommands`). A row of another space (Needs you lists
  every space's) drags too, but only a space tab takes it: the grid shows the current space only.
  The window stays in its space, as for a tab dropped there.
- **Move to space ▸** in the row's menu is the header's `MoveToSpaceItems` with the context menu's
  kit: the spaces with their glyphs, the thread's own marked "here", New space.
- **The current space**: the list reads `currentSpaceId` and each thread's `spaceOfThread`, so a
  space switch (a space tab, ctrl+cmd+1…9, back and forward) changes Active, Working and Snoozed at
  once; Needs you with "All spaces" stays as it is.
- **Typed drafts** (`shell/composerDrafts.ts`). The user's own edit (the editor's `onChange`, so the
  first-run welcome prefill alone does not start one) in a space's empty composer starts a draft:
  the window picks the id (`d-` + 8 base32), copies the text to the compose store under
  `draft:<id>`, runs `composer.draft.start --tab --id --label`, and reads the id from a pending map
  until the layout shows the tab's `draft` param. The target's own entry is dropped once the
  daemon answers (a refusal moves the text back). The label is the first line with text, tags by
  their labels, at most 60 characters; it is sent `LABEL_MS` (500 ms) after typing pauses, only when
  it changed. Text deleted to nothing clears the draft after `CLEAR_MS` (600 ms) if still empty: the
  tab is the space's empty composer again, or closes when there is one. Sending is unchanged:
  `thread.new --compose <tab>` and the daemon turns the draft's tab into the thread's and drops it
  from the list, so its row goes.
- **A draft's text** stays where the composer's text lives (the compose store), under its own key,
  so two drafts on one project never share it. A `ComposeTarget` carries the draft id and
  `draftKey()` gives `draft:<id>`, so send, attachments and the project switch need no other change;
  switching a draft's project rewrites its text for the new projects in place (`retargetShellDraft`)
  and the tab's params follow (the daemon keeps the `draft` param). The texts of `draft:` keys are
  written to localStorage (`code-foundry.shellDrafts`) and put back at start, so a draft survives
  closing its tab and a reload; a draft the layout no longer lists (sent, discarded, cleared, from
  any window or the CLI) loses its text. Attachments are not kept across a reload (their files are
  not), as for every composer.
- **A draft's tab** is named by its label in the space's list, else "New thread".
- **The drag follows the pointer, not dnd-kit's delta.** dnd-kit adds the scroll of the source's
  scroll containers to its delta; a sidebar row whose list scrolled under the drag (a row
  re-measured) aimed somewhere the pointer was not, and in e2e the drop bar vanished with the
  pointer still. `ShellDnd` now reads the pointer from a window `pointermove` listener during a
  drag. Tab and pane drags are unchanged (their strips do not scroll).
- **No Pull Requests or Projects rows** in the shell (`SidebarMenu pages={false}`); New thread and
  the agent search row stay.
- **Settings**: `layout.smart_swap` was only an op option; the store now asks
  `Options.SmartSwap` at every op, so the setting applies live. Both fields are on Appearance ›
  Panes and sidebar, in new groups `layout` and `sidebar` (the file's tables of those names).
- **Keys**: cmd+1..9, thread.next/previous and cmd+shift+a walk the shell's order while the shell
  draws the window (`sidebarThreadOrder`).

## Visible differences from the sketches (02b, 03a, 01)

- The scope control is one pill naming the scope in force, not a two-segment "All spaces | This
  space" control (the brief's single button).
- The sidebar starts under the top bar (PR 15's rule: the bar is not aligned to the sidebar); the
  sketches have the app name in the sidebar's column.
- Active shows no count while expanded; the sketch shows none either, and Needs you shows its count.
- The pin and made-by-thread glyphs sit on line 1, not before the title (nothing narrows it).
- Drafts are not in the sketches.
- A finished thread's slot shows the green check as today's rows do; the sketch shows a time.
- Needs you rows have no hover card or popup yet (PR 17).

## Verification

- `make check` green. It failed twice first on `TestLayoutGlueTerminalGoneAndReset`
  (internal/daemon), which also fails on `origin/shell` (1 run in 3 of the glue tests under
  `-race`): it killed a free shell before creating its replacement, so a removal the glue handled
  before the new shell existed rightly closed the tab. The test now creates the new shell first,
  as `terminal.reset` does (15 of 15 runs). A vitest run while the machine was loaded also timed
  out once in `plugin/tablenode.test.tsx`, which passed on its own.
- vitest: `lib/shellSections.test.ts` (order, membership, Needs you never also under Active, own
  threads only, scope both ways and the header kept for the button, current space only, Archived
  shared, drafts below the pinned, collapsing, the keys' order), `ShellSidebarList.test.tsx` (the
  rows drawn; a Needs you row's lines and no controls; a project row's three lines and the hover
  slot in line 1; no-project rows with and without a third line; a long title clamped at full
  width; a click runs `thread.open`; a draft's open and discard from the row and its menu; the
  scope button's `settings.set` both ways; collapsing; Open ▸ first, no "New terminal here", Diff
  of a closed thread runs `view.open.diff` with that thread's context), `Sidebar.test.tsx` (the
  flag swaps the list and drops the page rows), `shell/drag/*` (a thread source everywhere, its
  preview, `threadDropPlan`, its announcements, a rail taking a thread), `persisted.test.ts` (the
  new store). After the rebase onto PR 15 and 19: `spaces.test.ts` (a row's thread onto a space
  tab, open or not, never its own space), `ShellSidebarList.test.tsx` (Move to space ▸ and its
  verb; the list following a space switch, with Needs you in either scope),
  `composerDrafts.test.ts` (the start with its own key and label, a refused start, relabelling
  after a pause and only on change, clearing after a pause unless typed into again, the text kept
  in storage and put back, dropped once the layout stops listing the draft, kept while its start
  runs), `draftLabel.test.ts`, `compose.test.ts` (a draft's key; a draft keeps its key on another
  target).
- Go: `TestSmartSwapSetting` (on: the side pane switches to b's diff; off: it stays on a's).
- e2e `shell-sidebar.spec.ts` (WebKit, mock): a title two lines tall and clipped at the row's full
  width, a short one one line; on hover the controls sit at line 1's right and the title's box does
  not change; a row dropped on a pane's edge (stored `row([s-1] [s-sb-trip])`, `thread.open` then
  `tab.move`) and into a strip before the first tab. 20 of 20 over five repeats after the pointer
  fix. The other shell specs pass with it. After the rebase: a row dropped on a rail (the pane at
  520px folds; `thread.open --pane p-l`, stored `row([prs,s-sb-trip] [s-1])`; 3 of 3); typing in a
  composer tab lists a draft named by its label (the tab too), kept through cmd+w and a reload,
  cleared when emptied; sending from a draft turns its tab into the thread's and its row goes.
- `make gui-e2e` (4 workers, flag off for the classic specs): 558 passed, 157 skipped, 2 failed,
  both also failing on `origin/shell`: `shell-spaces.spec.ts` "the top bar drags the window…" (the
  rename field loses focus; 1 run in 12 on base and on this branch) and `thread-info.spec.ts` "the
  overlay: off at narrow…" (1 run in 3 of the spec on base; 5 of 5 alone here). `skills.spec.ts`,
  which failed once in the first run, passed 5 of 5 alone on this branch and on `origin/shell`.
- End to end with `make drive DAEMON=dev` and `?shell=1` on a scratch home under /tmp and a scratch
  repository under the home folder (both removed after), threads on Sonnet 5.5 medium: a
  supervised thread asked to `touch hello.txt` moved from Active to Needs you ("Permission"), and
  back to Active once `thread respond --decision allow` answered it. A draft made with `composer
  new` and `composer draft start` was listed under Active, stayed after `tab close`, reopened from
  its row in the focused pane, and its row's Discard closed its tab and removed it. Open ▸ Diff on
  the closed thread's row opened its diff in the focused pane, linked ("Diff of ● Ask before ls").
  `settings get layout.smart_swap` printed true; both settings show on the Settings page. After
  the rebase, on a fresh dev home: text typed in a composer tab started a draft (the daemon took
  the window's id), its row appeared, it survived `tab close` and a reload with its text, and
  deleting the text cleared it back to the empty composer.

## Gotchas

- The grid's outer drop band is 10px inside its edge: a pane at the grid's left with its first tab
  near that edge puts "a little into the first tab" on the band. Aim 30px into the strip.
- dnd-kit's `DragMoveEvent.delta` is scroll-adjusted (see Decisions).
- A fresh home with no projects prefills the home composer with the welcome prompt: typing there
  starts a draft labelled with the prompt's first line.
- Module state in `composerDrafts.ts` (pending ids, timers) outlives a vitest test: call
  `resetComposerDrafts()` in `beforeEach`.
- `useState(rowCache)` cannot infer a generic's type argument; `keyedRowCache<R>()` is the generic
  one, `rowCache` stays the classic list's.
- A component file must export only components (fast refresh lint), so the row parts are exported
  from `SidebarRow.tsx` and nothing else was.

## For later PRs

- **PR 17 (the inbox)**: the hover card goes on a Needs you row in `ShellThreadRowView` (today it
  returns the bare row for `section === "needs"`, where live rows get `ThreadTooltip`); the popup
  opens from the title in `NeedsLines` (`ShellRows.tsx`); the collapsed-sidebar control's count is
  the Needs you section's (`buildShellSections(...).main` header `count`, or the same filter as
  `waitsOnUser` over every space). cmd+shift+a already walks the shell's order.
- **Spaces**: a click on a Needs you row of another space opens the thread there by the daemon's
  rule (`thread.open --focus` switches the window to it).
- **Drafts**: an attachments-only draft (no text) does not start a draft; nor does a dictated
  insert that does not go through the editor's onChange. A draft's attachments are lost on a
  reload, as every composer's are.
- **Cutover (PR 20/21)**: delete the classic `SidebarList`, `SidebarMenu`'s `pages`, `RowMenu`'s
  `terminal` prop and the classic branch of `sidebarThreadOrder`.
