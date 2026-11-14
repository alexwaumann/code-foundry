# Shell 25i: one window's layout requests reach the daemon in order

## The bug

`e2e/linkedprs.spec.ts:35` failed rarely (1 of 12 with `--repeat-each=12`, once in a full run,
`shell-25g-race-chord.md` §3): after a click on a thread's sidebar PR tag the PR tab showed
#147, not #12. A user could see the same thing: the wrong pull request on top.

**The path.** `LinkedPrsBadge.tsx` `openLinked` calls `openPullRequestInPanel` once per counted
pull request, the shown one last so its tab ends active. Each goes `host.openTab` ->
`hostShell.ts` `shellOpenTab`, which builds an `open_surface` op (`focus: false`) and sent it
with `applyLayoutOp` without waiting. `LayoutService.Apply` takes one op, so a click on a tag with
two pull requests made two requests in flight at once, and they could reach the daemon (the mock
in e2e) in either order. In the daemon a no-focus open makes its tab active in its pane, so the
open that arrived last decided which tab showed.

**Reproduced deterministically.** `src/shell/openOrder.test.ts` runs the real seam over the
mock daemon's layout (`test/fakeLayout.ts`) with a wire the test controls: a request waits on it
until the test delivers it, and the test delivers the newest one first. On the old code the
tag's two opens (#147, then #12) were both on the wire, #12 arrived first, and the pane ended
`["12", "147"]` with #147 active: the e2e failure exactly. No sleep: delivery is by hand.

## The fix

`stores/layout.ts` `applyLayout` is now the window's one ordered channel to
`LayoutService.Apply`: an op is sent at once when none is on its way, else after the last one
sent has been answered (answered or refused: a settled tail, so a refusal never holds the
rest back; each caller still sees its own op's refusal). The seam (`hostShell.ts`: opens,
`close_tab`, params updates) and the slice's own `focusTab` / `focusPane` default runner send
through it. Ops sent one after another in the same window take effect in the order sent, so
the last one opened is the active tab.

Why not one commit for the whole action: `Apply` takes one op; a batch would be a proto change
(`repeated LayoutOp`), a new apply path in the daemon and the mock, and each caller would have
to build its action's ops up front, when today they are separate seam calls (`openTab` per pull
request, which also dedupes by identity against the slice). Ordering the sends gives the same
result for these actions with no daemon change. The cost: a burst's ops wait a round trip each
(local daemon, milliseconds).

`queueParams` kept its per-tab record of the params on their way (each update is computed from
the one before it), but its own promise chain is gone: the window's queue orders it.
`shellOpenTab` on an open tab the user asked to see now sends its focus before its params update
(both through the queue; before, the params waited a microtask on the tab's chain).

## The same pattern elsewhere

Places that sent several layout requests for one action without ordering them, all fixed by the
queue:

1. `LinkedPrsBadge.tsx` `openLinked`: N `open_surface` (the bug).
2. `hostShell.ts` `shellOpenTab` on an open tab with new params and the focus: `focus_tab` and
   `set_tab_params`, two requests. They commute for this tab, but each could race another op
   of the same action.
3. `hostShell.ts` `queueParams`: ordered per tab only; two tabs' updates, or an update and an
   open, raced.
4. `hostShell.ts` `shellActivateTab` / `showOpenTab` -> `stores/layout.ts` `focusTab`: sent
   straight, so "focus this tab, then open that one" could land reversed. It matters: a
   no-focus open lands behind the active tab of the focused pane and on top elsewhere, so the
   focus must move first (`openOrder.test.ts`, third case; the old code ends with #1 active, not
   #3).

Checked and left alone: `selectionBridge.ts` `run` and `terminalActions.ts` await each op before
the next; the command path (`runLayoutCommand`: `focusTabNow`, `focusPaneNow`, key presenters,
drags, resize, composer drafts) sends one command per action. The command path is a separate RPC
(CommandService), not in this queue.

## Tests

- `src/shell/openOrder.test.ts`: the tag's opens arrive in order, one on the wire at a time, #12
  active; a refused `close_tab` does not hold back the open after it; a focus then an open land in
  that order. Both ordering cases fail on the old code (#147 active; #1 active).
- `src/shell/hostShell.test.ts` unchanged and green (the focus-then-params case keeps its order).
- `e2e/linkedprs.spec.ts:35` unchanged: `--repeat-each=30`, 30 passed.
