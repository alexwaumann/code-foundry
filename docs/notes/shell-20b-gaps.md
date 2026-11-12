# Shell PR 20b: four gaps found at the cutover

The cutover (`shell-20-cutover.md`) found four shell gaps. Three were e2e tests skipped by name
(`e2e/cutoverSkips.ts` `REPORTED`, now empty); the fourth showed in the migration rehearsal
(finding 4). Each is fixed at its cause here, with a unit test, and the three tests run again.

## 1. cmd+shift+a and Ember

**Cause.** In the classic window cmd+shift+a went through the sidebar's order with Ember's row
first (`jumpToAttention`: `getEmberAttentionId()` before the list). The shell's cmd+shift+a
(`openNextNeedsPopup`) went only through the Needs you list, and Ember is never in a thread
list: its row is its own, above the list. So Ember waiting on the user (its prompt, a reply not
seen yet, a worker of its board waiting on an answer) could not be reached by the key.

**Fix.** cmd+shift+a's round is Ember (while it waits) and then the Needs you list, as the
sidebar shows them from the top (`lib/needsAsk.ts nextNeedsThread(needs, from, ember)`). On Ember
it opens Ember's chat the way its row's click does (`goToNeedsThread`: the popup closes, the chat's
tab is focused or opened in the focused pane), not a popup: what Ember waits on is often a
worker's question, answered in the chat, and the popup's limited thread view is not Ember's chat.
The next press goes on to the first Needs you popup, the last one wraps back to Ember. With Ember
off or not waiting nothing changes. Ember stays out of Needs you and out of the space tabs' count
(as it was out of the dock badge): the key reaches it, the list does not list it.

Tests: `lib/needsAsk.test.ts` (Ember first, after it the list, back to it, never twice),
`keys/bindings.test.ts` (the round through the stores, Ember off), e2e `ember.spec.ts` "a worker
waiting on the user: cmd+shift+a goes to Ember first".

## 2. A plugin's flag and its surface

**Cause.** The classic row's click selected the thread and, when its line showed a plugin's
flag, opened the plugin's thread- or pr-scoped surface (`openFlagSurface`). The shell's Needs you
row is the project, the kind of ask and the title, with no buttons; its title opens the popup and
the card's and the popup's Go to thread only selected the thread. Line 1's click still ran the
flag path, but nothing on the row says so, and the card and the popup (where the spec sends the
user) never opened the surface.

**Fix.** One function, `stores/flagSurface.ts selectThreadAndFlag`: select the thread, and for a
thread whose line shows a plugin's flag, open that plugin's surface for it. The sidebar row's click
and `goToNeedsThread` (the hover card's, the popup's and the top bar popover's Go to thread) both
call it. In the shell `openFlagSurface` goes through `showPluginView` → `openTab("current", …)` →
the layout's `open_surface` with the thread and no pane, so the daemon places it as a linked
surface by the rules (a pane of its own to the right of the thread when there is room). The card's
"Open…" still opens the popup: the popup is the ask, Go to thread is the thread and its surfaces.

Tests: `stores/flagSurface.test.ts` (a flagged thread selected with its surface opened; a thread
without a flag only selected; Go to thread from an open popup closes it and opens the surface),
e2e `plugin-gaps.spec.ts`, rewritten for the shell: the row under Needs you with the plugin's name
as its ask, its card's Go to thread, the surface live in a pane to the right of the thread's.

## 3. The File tab's top line across a zoom change

**Cause.** Not the strip, the linked row or the body's height: the box's width. Measured in WebKit
at a 2400 × 1100 window, the File tab's scroller in the shell pane was 730, 1066, 405 and 945 layout
px wide at 125, 90, 200 and 100%, while `scrollTop` stayed 14000 throughout. A pane is a share of
the grid, and the grid's layout width is the window's over the zoom, so every zoom change changes
the pane's layout width (the classic side panel had a fixed CSS width, so its layout width moved by
1 px). With wrap on, line 651 (360 characters) above the view re-wraps into another number of rows
at each width, and the same `scrollTop` shows lines 704, 706, 700, 705. The library's `scrollFix`
anchors only rows it re-measures in its render window, and WebKit's own anchoring is off
(`overflow-anchor: none`, `file-edit-zoom.md`). The same drift happens on any resize of a pane by a
drag of its gutter, zoom or not.

**Fix.** `components/files/useKeepTopLine.ts` (pure part `topLine.ts`): after each scroll the File
tab notes the first line on screen and how far its row starts below the top, in layout px; after a
change of the scroller's width it scrolls that line back to the same offset each frame until it
stays for three frames (at most 600 ms), and a wheel, key, press or touch by the user ends that. The
rows are read in line order and only down to the first that shows. After the fix the top line stays
704 at every zoom of the test. Not done here: the Diff tab and the PR code tab have the same
library virtualizer and the same drift on a width change; they did not show it in a test.

Tests: `components/files/topLine.test.ts` (the line on top, a row touching the top, a hidden row,
zoom; the correction down, up, within half a pixel, the row not rendered, under a new zoom), e2e
`file-zoom-scroll.spec.ts` "in edit mode at 125% … keeps the line on top", unchanged.

## 4. A space tab's count and Needs you

**Cause.** The space tab counted `attentionIds` (stores/threads.ts), the window title's and the
dock's set: every thread with status "attention" or a flag, which includes a finished turn. Needs
you lists the "prompt" group only (`lib/shellSections.ts waitsOnUser`): a permission, a question,
a plan, a woken snooze, a plugin's attention flag. Two sets, so a finished turn counted in the tab
and was listed under Active.

**Fix.** `lib/shellSections.ts needsBySpace` counts, per space, the threads `waitsOnUser` keeps,
the same predicate `needsList` filters by; `stores/shellList.ts useNeedsBySpace` feeds it the
sidebar's own list keys and spaces, and `SpaceTabs` shows it. `shell/spaces.ts
spaceAttentionCounts` is gone. The window title and the dock badge keep `attentionIds` (a finished
turn there is the existing rule for the dock, not a shell rule).

Tests: `lib/shellSections.test.ts` (per space, the count equals `needsList`'s length with "This
space" for that space; a finished turn and a thread's thread count in neither),
`components/shell/TopBar.test.tsx` (the tabs' counts with a finished turn in Main that does not
count; the test's threads now carry real asks).

## Gotchas

- The TopBar test built its threads without a `statusReason`: the list keys (`threadGroup`) read
  it, so the space tabs now need one, as the top bar's Needs you control already did
  (`shell-17-needs-you.md`); they carry real asks.
- A ResizeObserver callback runs after layout and before the scroll events of the next frame, so
  the restore starts before any scroll event the width change causes; scroll events while it runs
  do not note a new top line.
