# Shell 24d: differences from the specification, and a window that waited for ever

Four differences the last pass ranked (`shell-24c-last-pass.md`, "Differences from the
specification" 1, 2, 4 and 5) and a window that waited for ever on a locally built daemon. The
specification gained three sentences: an open quick terminal comes back after a snooze, a thread
pane narrower than a thread's minimum keeps its header on top, and what a thread's own call for a
closed thread's surface does (and is told).

## 1. The quick terminal across a snooze

"Snoozing closes them, ends its terminals and keeps the set, so the terminals come back as fresh
shells in the same places." The quick terminal is not a tab, so the set never held it: the snooze
ended its shell, the glue drew it closed, and it did not come back.

What "comes back" means for it, read from how the linked terminal tabs are treated: the slot is
its place (the thread's pane, its height kept), so an *open* quick terminal comes back open, over
a fresh shell in the thread's checkout, with the old shell's command and "Run again" (the same
line a restored terminal tab shows; never rerun by itself). A quick terminal that was closed at
the snooze stays closed: there is nothing to put back, and the next cmd+j starts a shell as always.

- Layout: `Quick` gained `Fresh` (a snooze ended it while open; it is drawn closed meanwhile) and
  `Ran`. `snooze_thread` takes `quick_ran` (the glue reads it from the quick shell before the
  shells go, as it does for the tabs). `open_thread` turns a fresh quick terminal open and reports
  the thread in `Result.FreshQuick`; the glue starts a quick shell for it (`freshQuick`), unless one
  is running already (`terminal.quick` started it meanwhile), and draws it closed when the thread
  has no checkout. `catchUp` does the same for a dropped commit. `set_quick` settles a fresh mark
  either way, keeps `Ran`, and drops it only with `forget_ran` (Run again ran, or ×).
- Proto: `QuickTerminal.ran`, `SnoozeThreadOp.quick_ran`, `SetQuickOp.forget_ran`,
  `ApplyLayoutResponse.fresh_quick_thread_id`.
- Window: the quick terminal shows the restored line (`RanLine`, now given its two actions) under
  its header; Run again types the command in its shell (`terminal.rerun`) and then forgets the line,
  unless a Reset put another shell there meanwhile. A page does not read the line (`layoutFor`
  clears it, as it does a tab's), and `layout show` says "quick terminal comes back open as a fresh
  shell (ran …)".
- The mock keeps `ran` through `set_quick` and drops it on `forget_ran`; it does not port the
  snooze (Go's rules).

Tests: `TestQuickTerminalAcrossASnooze` (layout), `TestLayoutGlueSnoozeBringsTheQuickTerminalBack`
(the glue, in the thread store's order, and a shell started meanwhile kept),
`TestLayoutQuickTerminalAcrossASnooze` (API), `TestLayoutShowThreads`, `TestCommandLinesByCaller`,
`QuickTerminal.test.tsx`, `terminalActions.test.ts`.

## 2. The header over a too-narrow thread pane

At 200% in a 1100x720 window the grid is under a thread's 360 layout px; the focused thread's pane
never folds, so the composer's footer stacks and its dock (absolute, bottom 0) grows taller than
the conversation's box and rises over the header. The box (`thread-pane-body`) now clips: the
header stays on top and usable, and the top of the dock is cut instead. This is the choice the
last pass made for the Needs-you popup. In the measured case what is cut is the one-line ask strip
above the composer; the ask stays reachable from its Needs-you row, the row's card and its popup.
A compact footer for a narrow composer, which would keep the strip, is left for a later change.

`e2e/shell-narrow-thread.spec.ts` checks that the dock is taller than the box (the case at hand),
that the title bar, thread info and the menu are each under the pointer where they are drawn, and
that the menu opens. It fails without the clip (the title bar is covered).

## 3. What a thread is told when it opens a closed thread's surface

The last pass saw the surface join the thread's remembered set. Read against the code that is
true only before any window has loaded the layout: the first-load import folds a space's linked
tabs into their threads' sets when no thread tab arranges that space. Once a window has loaded
it, the item verbs put a closed thread's surface in the focused pane of the thread's space, as the
user's Open ▸ does (rule "focused"), and with the user's focus kept the tab waits behind the tab
shown there; a dozen tests pin that. So the behaviour stayed, and the message now says what
happened in each case (`PanelResult` gained `thread_not_open`, `behind`, `other_space`,
`joins_set`):

- "thread X's tab is not open, so tab T opened in pane P, the focused pane of its space[ (S, not
  the space the user is in)][, behind the tab shown there]"
- before the first load: "thread X's tab is not open, and no app window has loaded the layout yet:
  tab T joins the thread's set of tabs when one does, and shows beside the thread when the thread
  is opened"

The second is decided from the snapshot (`LegacyImported`) and the space (no thread tab in it);
the store's list of thread tabs an old window opened is not visible to the command, so a space
holding only such tabs is read as arranged (the message then names the focused pane, which the
import empties). `layouttest.Fake.MarkImported` gives the panel tests the steady state.

Tests: `TestViewOpenForAThreadWhoseTabIsNotOpen` (behind, another space, before the first load,
and the import then really folding the tab into the set).

Not changed: a plugin surface's show command (`plugin.<n>.show.<s>`) still says "opened … as tab
T in pane P" for a closed thread; its store cannot see the layout.

## 4. "Already open" names the tab's thread

A file is one per path, so the open tab used may be another thread's, or of none. The message
names the thread the tab belongs to ("tab T (of no thread)" for none), and `tab_thread` carries
it. `TestViewOpenAlreadyOpenNamesItsThread`.

## 5. A daemon with no layout service

The layout comes only as the event stream's layout source. A daemon from before the shell streams
everything else and simply never sends one: nothing fails, so the window said "Waiting for the
daemon to send this window's layout…" for ever. `predatesShell` catches a released daemon by its
version, but a locally built one reports "dev", which compares as nothing.

How a missing service surfaces, read in the code: the window's calls go through the WebSocket
tunnel, which hands each request to the daemon's mux (`internal/wstunnel` `ServeHTTP` → `Next`);
an unregistered service path is the mux's plain 404, and connect-web reads an HTTP 404 as
`Unimplemented` (what `api/errors.ts isOutdatedDaemon` already relies on). The e2e test runs it
over the real tunnel: the mock's `POST /__mock/layout/service?off=1` answers the service's paths
with Go's 404 text and leaves the layout out of the stream.

So once the window has waited (`LAYOUT_WAIT_MS`), it asks for the layout itself
(`shell/layoutService.ts probeLayoutService`, `LayoutService.Get`), and again after each further
wait. Unimplemented: the waiting text becomes "The running daemon is older than this window", with
Restart Now. An answer: the layout is applied as the snapshot it is. Any other failure: it waits
and asks again.

Restart Now, decided by reading what a restart runs: `app.restart` stops the daemon after telling
the window's host, which relaunches the app; the new window's connect starts the daemon binary the
app ships with (`gui/daemon.go daemonBinary`: `$CODE_FOUNDRY_BIN`, the sibling of the GUI, then
`../bin`), not the old process's. So the restart does bring up the new build for a "dev" daemon
too; only the trigger was missing. The update dialog was not reused for it: on "dev" against
"dev" its copy reads "Code Foundry dev is partly applied: the app is on dev but the daemon is still
on dev", and outside the app (no host version) it shows "Updates are off for this build" with no
restart. The notice's button runs `app.restart` through the daemon's own confirmation (it names
what a restart cuts off), falling back to `daemon.restart` and the host's Relaunch for a daemon
older than `app.restart`, as the dialog does. In a browser window nothing starts the daemon
again; the notice is for the app.

Tests: `layoutService.test.ts` (Unimplemented, other failures, an answer; the restart, declined,
the fallback, a failure), `ShellNotice.test.tsx`, `Shell.test.tsx` (asked after the wait and each
further wait, never once the layout is in or the service is known missing),
`e2e/shell-old-daemon.spec.ts`.

## Still different from the specification

- New thread asks for a project first (the last pass's 3): not in this change.
- Pull Requests from another pane's "+" moves the space's one tab (the last pass's 6): it follows
  the specification's letter.
- Item 2 cuts the top of an over-tall dock, which in the measured case is the ask strip.

## Gotchas

- In a pane this short the ask is drawn as one line on the composer (`ask-strip`), not the
  full ask: an e2e wait for `thread-permission` there never ends.
- The panel tests' fake layout was un-imported, so after this change their closed-thread messages
  would have been the first-load ones; the default fixture now marks it imported.
