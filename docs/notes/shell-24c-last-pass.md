# Shell 24c: the last hardening pass

The last pass over the window shell before its owner tests the `shell` branch: a notice the
window lacked, the text the step notes left for later, a measurement the mock could not make, a
fuzz of the grid, the files a branch review did not reach, a manual walk through the
specification on a real daemon, and the window at 90% and 200% and at 1100x720. The
specification (`shell-model.md`) did not change.

## 1. A newer build's layout says so

The daemon leaves a layout a newer build wrote untouched on disk and works on it in memory
(`shell-review-fixes-daemon.md`, 7); the window said nothing. `Layout.newer` (proto field 7)
carries `Snapshot.Newer`: what the daemon found, one line each. It is decided when the daemon
loads the layout, so only a snapshot carries it; a delta keeps what the client holds
(`stores/layout.ts newerBuild`). While it is set the shell draws one quiet line under the pane
grid (`ShellNotice.tsx NewerLayoutLine`): an info icon and "This layout was saved by a newer
version of Code Foundry. Changes to it are not saved until you update." (`role="status"`, the
caption role, muted, cut with a tooltip when the window is narrow). No dialog, no button. The
grid shrinks by the line's 24 px, so the panes still tile what is left.

Where: the first-load import's failure is a full-pane notice because the shell cannot draw
then; here the shell draws normally, so the notice is a line in the same component file, in the
shell's own box, not over the panes.

Mock: `POST /__mock/layout/newer?on=1|0` sends a snapshot with (or without) `newer`, as a
restarted daemon would. Tests: `ShellNotice.test.tsx` (the mapping, the line, a delta keeps it,
a snapshot without it takes it away), `TestLayoutCarriesWhatANewerBuildWrote` (API), the mock's
case, and `shell-grid.spec.ts` "a layout a newer build wrote" (the line under the grid, the grid
smaller, every pane inside it).

## 2. The text left for later

| Where | What it says now |
| --- | --- |
| `plugin.<n>.show.<s>`'s description (the guide topic of its plugin) | a thread or pr surface opens "as a tab linked to the thread, beside it by the app's placement rules (an open one is found, not doubled)" |
| plugin skill, `reference/manifest.md` | the same, plus: the user's focus stays unless `--focus`, which a thread passes only when the user asked; other scopes go to the windows |
| `guide layout` conventions | a plugin's show verb next to `view open`; `pane move --space` moves a pane whole in one step, its threads and their linked tabs along |
| help skill | `daemon.capabilities --group panel` lists every surface, "a plugin's too" |
| `daemon.capabilities --group panel` | plugin surfaces no longer "act on each window's selection, not a thread" (wrong since 24a) |
| pages skill, `reference/sources.md` | a page gets no command lines: left out of the `terminal` source and of `terminal.list`, `plugin.terminals`, `layout.show`, `tab.list` |
| `ARCHITECTURE.md` | the show verb's tab; a drop's `thread.open` with its place (was "then `tab.move`"); `pane.move --space` on a space tab; a page reads no command lines; `Layout.newer` and the line |
| `GETTING-STARTED.md` | "Drop a tab, a pane or a thread onto a space … a pane takes its threads along" |
| the mock's `pane.move` description | the daemon's, with the sentence about a pane moved to another space |

Budgets, before → after (bytes): the guide 10,712 → 10,712 (11,000; the conventions are in the
`layout` topic, not the short guide); topic `layout` 9,161 → 9,363 (29,000); `sources.md`
12,148 → 12,329 and `manifest.md` 15,954 → 16,181 (32 KiB each); the help body grew by a few
bytes within 5,500. Nothing was trimmed.

## 3. The pull request's Code tab across zoom and a resize

`POST /__mock/gh/pr-diff-long?number=N` ends that pull request's diff with a 1,200-line added
file (`docs/notes/long-plan.md`) whose every 100th line wraps; reset puts the short diff back.

Measured with wrap on, the scroller at 13,616 so that line 655 sits just under the wrapped 651:
at 90, 200 and 100% the top row stayed line 655, at the same offset (the scroller's top moved
from 13,616 to 13,844 at 200%, the wrapped rows above growing, and back), and so it did at
window widths 700, 1600 and 1100 and pane widths 520 and 900. The library's `CodeView` anchors
its scroll on a re-layout as `shell-gaps-b-surfaces.md` read in its code; nothing drifts, so
nothing changed. `pr-code.spec.ts` "the Code tab keeps its top row across zoom changes and a
resize of its pane, wrapped" pins it.

## 4. A fuzz of the grid

`e2e/shell-grid-fuzz.spec.ts`: two panes and two threads, a second space made without switching
to it, then seeded random steps through the pointer and the window's own commands: tab drags
(onto a strip, a pane's edge band, the grid's outer edge, a space tab), pane drags by the
strip's free space, gutter drags, middle-click closes, sidebar opens, free terminals,
`pane.split`, space tab clicks, full screen on and off, three window sizes (one folds panes to
rails) and the Pull Requests page. After every step, once the window holds the mock's rev: the
drawn panes are exactly the current tree's (or the one full screen pane), each at its frame
rectangle, the frame the grid's size, panes and gutters inside it with no overlap and covering
it; the focused pane is in the tree and is the one drawn focused; no tab id is drawn twice nor
stored twice across spaces. Every 40 steps and at the end, WatchThread streams equal the
distinct threads on screen and Attach streams the terminals on screen (hidden tabs, rails and
panes behind full screen hold none). `FUZZ_SEED=1,2,…` and `FUZZ_STEPS=n` replay; a failure
prints its seed, its step and the twelve steps before it.

The suite runs seeds 1 and 2, 150 steps each (about 25 s each, in parallel workers).

What it found: nothing in the grid. Seeds 1 to 12 at 200 steps (2,400 steps) and seed 3 at 300
held every check. Its own first version did find two things: a Needs you row's title opens the
popup (by design), a dialog the next drag cannot pass, so the fuzz opens only other rows; and
`space.new` from the window switches to the new empty space, so the run began in a single pane
for many steps, so it now passes `focus=false`. A check that panes are drawn at their frame was
proved by drawing every pane right of x=0 two px narrow: seed 1 failed at step 0, naming it.

## 5. The files the review did not reach

Fixed, each with a test that fails without the fix:

- **`commands_view_diff_pick.go`, state after an await.** The pick read the user's Diff tab,
  asked git whether the user's sides list the file (`listedIn`), then wrote the params it had
  read: a filter, a file or sides the user set while git ran were written over. It now reads the
  tab again after the comparison and starts over from what the user has (at most three times;
  a tab that keeps changing gives the call a tab of its own, which never touches the user's).
  `TestViewOpenDiffPickKeepsAChangeMadeWhileItCompares` (a filter kept; sides changed to ones
  that do not list it: the user's tab as they left it and a tab of the thread's own; sides
  changed to the call's: picked there with no second comparison). The fake comparer gained
  `During`.
- **`NeedsPopup.tsx`, focus stolen.** The popup put the keyboard on the ask as soon as the Watch
  drew it, even when the user had already clicked into a field (the prompt, the deny reason):
  the next digit typed there would answer the ask. It now does so only while the keyboard is
  still on the dialog itself.
- **`terminalActions.ts`, state after an await (two).** cmd+j's close of a quick terminal moved
  the keyboard back to the thread's pane after the user had gone to another pane while the
  command ran; it now goes through `closeQuick`, which checks the pane still has the focus.
  "Run again" wrote back the tab's params as read before the rerun (`set_tab_params` replaces
  them all), undoing a Reset that happened while the rerun waited for the prompt; it now writes
  the tab's params as they are, and leaves the line when a Reset put a new shell under the tab.

Read and not changed, or not confirmed:

- `FloatingComposer.tsx`: ⌘L is taken window-wide (capture) while a floating composer is
  mounted, even with a dialog over the window; a dialog's focus trap keeps the keyboard, so
  nothing was seen to go wrong. The expanded state is the window's, not the thread's: when the
  full screen pane's active tab changes to another thread's linked tab (cmd+shift+]), the card
  stays expanded with that thread's composer; the chip names the thread, so nothing goes to the
  wrong thread, but the keyboard is left on the body.
- `PaneRail.tsx`: with more tabs than fit, the rail's own full screen button is cut off
  (`overflow-hidden`). Not seen at real sizes.
- `PaneTabStrip.tsx`: a measure that finds no room keeps the previous fits, which can belong
  to another set of tabs for one frame. Not seen.
- `NeedsPopup.tsx`: a popup opened by cmd+shift+a on a thread whose ask is already gone never
  closes by itself (it closes when asks go from some to none). By design of that hook.

## 6. The specification on a real daemon

`make drive DAEMON=dev` on a scratch home under /tmp, a scratch git project `alpha` under the
home folder, three threads on Sonnet 5.5 at medium effort (one read its README, one wrote
`notes.md` and opened its diff, one asked red or blue with AskUserQuestion). Everything was
removed afterwards (threads, home, project, Claude's session files for that path), and the drive
was stopped by its pid.

Done and as the specification says: the first load (one empty space with the composer); the
top bar (name, sidebar, back and forward, space tabs with icon and count, "+"); the Needs you
row (project and kind of ask, then the title, no buttons), its question card (Answer… and Go
to thread, never an answer), its popup (recent messages, the ask, Go to thread), answered with
the digit and Enter, closing by itself; the "+" menu (this thread's submenu, then New thread,
Terminal, Pull Requests, Projects); one Pull Requests page per space; a closed thread's diff
remembered and restored beside it; cmd+shift+d both ways; cmd+j and the quick terminal's
directory and its Reset hint after `cd /tmp`; cmd+t placed beside the thread's linked tabs, its
tab "zsh · alpha"; cmd+shift+j's ring; cmd+w closing the thread from the space with its tabs
remembered and its terminals running; restore placed fresh with the remembered active tab;
spaces (new with its name field, ctrl+cmd+1, the count following the thread, the remove dialog
with move or archive); full screen with the top bar and sidebar staying, the floating pill, its
expanded card with the chip, Escape collapsing then leaving; smart swap of two threads' diffs;
ctrl+cmd+h and l, cmd+shift+], cmd+[ and ]; thread info as an overlay in a narrow pane; cmd+p
opening a file linked to the thread; Open ▸ Diff for a closed thread into the focused pane;
archive closing the linked tab; drafts (named tab, listed first under Active and drawn as a
draft, kept when the tab closes, back with its text from the row); a snooze's terminal back as
a fresh shell with "Last command sleep 300 Run again"; moving a thread to a space with its
linked tabs and quick terminal.

### Differences from the specification

Ranked, most important first. None is fixed here.

1. **A snooze loses the quick terminal.** "Snoozing closes them, ends its terminals and keeps
   the set, so the terminals come back as fresh shells in the same places." The linked terminal
   tabs do; the quick terminal, open before the snooze, is closed when its shell ends and does
   not come back when the thread is opened again (`SnoozeThread` leaves `Quick` alone and the
   glue closes a quick terminal whose shell is gone). A fix needs a fresh-quick record in the
   op and a fresh shell from the glue on restore.
2. **Below a thread's minimum width, its pane's composer covers the header.** At 200% in a
   1100x720 window the grid is about 280 layout px, under a thread's 360; the focused thread's
   pane never folds, so it draws narrow: the composer's footer controls stack, the composer is
   taller than the pane and its dock covers the branch chip, thread info and the menu. The
   placeholder no longer runs over the controls (7). The specification says nothing of a grid
   narrower than one thread; folding the sidebar first, or a compact footer, are options.
3. **New thread asks for a project first.** cmd+n and the sidebar's New thread open the project
   picker; the composer opens (or the space's empty composer is focused, as the specification
   says) after a pick. The specification's "New thread focuses it … otherwise opens one" has no
   picker step. It predates the shell (`thread.new`'s presenter).
4. **A closed thread's surface opened with no window open joins its remembered set**, and the
   model is told "opened tab … ; no app window is open"; it then told the user the tab "may not
   be visible yet". With a window open it goes to the focused pane, as the specification says
   for the sidebar's Open ▸. The specification does not say what a thread's own call does then.
5. **"Already open" names the asker.** `view.open.file README.md` from one thread, while another
   thread's linked tab shows that path, answers "thread <asker>'s tab … is already open". The
   identity rule (one tab per path) is the specification's; the message names the wrong thread.
6. **Moving Pull Requests from another pane's "+"** moves the space's one tab into that pane
   rather than focusing it where it is. The specification's exception covers only linked
   surfaces, so this follows its letter; noted because it differs from a linked surface.

## 7. 90%, 200% and 1100x720

At 90% the top bar, strips, linked row, rails, card, popup and quick terminal draw well. At 100%
in 1100x720 too. At 200% in 1100x720:

- **The Needs-you hover card ran off the window** (560 layout px beside the sidebar, about 270
  available). Radix's available width and height are screen px; the card's caps used them, and
  the viewport, as layout px. They are now divided by `--cf-zoom`, the minimum width too.
- **The popup's header was covered**: its thread's dock (the ask and the composer) was taller
  than the body and covered the crumb, Go to thread and Close. The body clips it; the top of the
  ask is cut instead, and it scrolls with the conversation.
- **An empty composer's placeholder wrapped past the editor over its own controls** in a narrow
  composer. It is clamped to the editor's two lines.
- Folded rails, the top bar's Needs you control and the quick terminal (overlaying the pane's
  bottom when the composer does not fit) are as specified. The thread pane narrower than its
  minimum is difference 2.

`shell-needs.spec.ts` "at 200% in a 1100x720 window the card stays in the window and the
popup's header is never covered" fails without either fix (the card's right edge at 1,572 px;
Close not under the pointer).

## Gotchas

- `playwright cli mouse-move` does not open a Radix hover card, so it does not close one either:
  a card opened by `hover` looks stuck after `mouse-move` away. Not the app's.
- `space.new` from the window switches to the new space unless `focus=false`.
- The dev daemon's thread info reads the user's own Claude MCP settings (read only).
