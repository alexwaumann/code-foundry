# Plugins 12: renderer defects from the showcase pass (2026-10-18)

The showcase plugin's GUI pass (`alexwaumann/code-foundry-plugin-showcase`, screenshots
on `cf/plugins-showcase-shots` under `docs/notes/plugins-showcase/`) found seventeen
renderer defects. This branch (on `cf/plugins-7-registry`) fixes them; frontend only,
plus one sentence in the plugin skill.

## The stream budget (defect 1)

The daemon speaks HTTP/1.1, so WebKit keeps at most 6 connections to it and a server
stream holds one for its life. The event stream, the content pane's `WatchThread` and the
panel's `WatchSurface` are three; two thread nodes and a terminal node made six, and every
unary call (acts included) queued behind them forever. Three layers now:

| Layer | Where | Rule |
|---|---|---|
| On screen | `components/plugin/live.ts` `useOnScreen`, `useLeavingViewTab` | A thread or terminal node attaches only while it is within 160 px of the panel's visible box (IntersectionObserver on `[data-scroll-root]`) and its view tab is not being left (a tab act in flight: the old view stays drawn until the plugin's next view, but its streams let go at once). |
| Inline budget | `live.ts` `useInlineLiveStore`, `want` / `drop` / `take` | At most `INLINE_LIVE_MAX` (2) inline live nodes across every surface. A node beyond it shows "Paused" and **Attach**, which takes the oldest holder's slot (that one waits instead and gets a slot back when one frees). A thread node for the thread the content pane shows costs nothing (it shares that Watch). |
| Per origin | `api/streamSlots.ts`, `runStream`'s `slot` option | Every `runStream` attempt (events, WatchThread, WatchSurface, Attach) and the clone stream claims a slot first; never more than `MAX_OPEN_STREAMS` (5) are granted, so one connection always stays free for calls. Priorities: `core` (event stream, content pane thread, surface, bottom shell) and `inline` (nodes). A core claim with no room preempts the newest inline holder, which reconnects and waits ("connecting", not an error); waiters are served core first. A node whose stream waits says "Waiting for a connection" (muted) instead of hanging. |

`startThreadWatch(id, priority)` counts core holders per thread: a shared Watch is core
while the content pane holds it (`resettleStreamSlots` lifts a waiting one). The bottom
panel's shell is core, so moving a terminal there with two inline threads live pauses the
newest thread (the e2e checks it). `test/setup.ts` resets the slots after each test.

The skill's primitives (`reference/primitives.md`, thread and terminal) now says each node
holds a live stream, only on screen, 2 at once: put one in a view or let the user pick.

## The other defects

| # | Fix |
|---|---|
| 2 | A submit the plugin takes no longer drops the form's drafts. `pluginSurfaces.submitted` records the version acted on; the first newer view settles it: drafts go when that view shows the form without errors (form, field, fieldset or a fieldset's field) or not at all, and stay beside the plugin's errors otherwise (`settleSubmits`, `formHasErrors`). A new `resetToken` still drops them. |
| 3 | The single dropdown is always controlled (`value=""` shows the placeholder), so a reset clears it and React's controlled/uncontrolled warning is gone. |
| 4 | A `multiple` select without a style (the SDK's default is dropdown) is a dropdown: a trigger like the single one (placeholder, else the chosen labels and a count) over a Popover checklist; `style: list` keeps the checkboxes. |
| 5 | `codeActions.css` scopes to `:is(.cf-thread, .cf-plugin-md)`; the markdown node carries `cf-plugin-md` and imports the CSS. |
| 6 | View tabs that overflow get an edge fade (mask) and chevrons on the hidden side; the active tab scrolls into view clear of the fade (`components/plugin/scroll.ts`). |
| 7 | The header sub-line clamps to two lines (tooltip when cut). |
| 8 | A labelled plugin button is `max-w-full`, its label truncates, with a tooltip only when cut. |
| 9 | The terminal node's title bar drops labels (buttons with an icon, and Open in bottom panel) below a 400 px node width (`useNarrowerThan`). |
| 10 | A chip without a status has no glyph. |
| 11 | Skipped is a dash; pending stays the hollow ring (slightly stronger). Both read in both themes. |
| 12 | Pairs: label column `fit-content(40%)`, labels wrap. |
| 13 | `AttachController` holds output, resizes and exit that arrive while a snapshot is still being parsed (xterm parses large writes over later frames while `resize()` applies at once) and fits only after the snapshot is on the grid (`TerminalRenderer.write(data, parsed)`). A newer snapshot drops what an older one held. |
| 14 | An archived plugin thread is read-only with an "Archived · read-only" line. |
| 15 | Required fields carry a muted `*` after the label from the first paint, and `aria-required`. There was no existing required convention in the app (only "(optional)" placeholders). |
| 16 | Clickable rows and chips have `aria-pressed`; a selected row that is not clickable has `aria-current`. |
| 17 | No filled buttons (Attach is ghost), amber only on the plugin's attention style, radius scale only; `src/design/guards.test.ts` green. |

## Tests

* Unit: `api/streamSlots.test.ts` (cap, ordering, preemption, runStream with slots),
  `components/plugin/live.test.ts` (budget reducers), `scroll.test.ts`,
  `renderer.test.tsx` (one or more per defect: required marks, controlled dropdown,
  multi dropdown, chips, glyphs, aria, long labels, pairs, sub-line, archived, budget and
  Attach, shared thread, leaving tab, waiting notice), `stores/pluginSurfaces.test.ts`
  (`settleSubmits`, `formHasErrors`), `terminal/attach.test.ts` (held output, superseded
  snapshot). `registry.test.tsx`: the demo's `tags` is now a multi dropdown.
* e2e: `e2e/plugin-streams.spec.ts` on the mock's new hello demo "stress" tab
  (`POST /__mock/plugin/demotab?tab=stress`: two thread nodes and the clock terminal):
  two go live, the third offers Attach, at most 5 streams open, Click acts complete, Attach
  swaps, a tab switch completes; moving the terminal to the bottom panel pauses the newest
  inline thread with the connection notice and acts still complete. With the old limits
  (3 inline, 6 streams) the act in this spec hangs in both browsers.
  `e2e/plugins.spec.ts` opens the tags dropdown and checks the required mark.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cfp12`)

```
make build
CODE_FOUNDRY_HOME=~/.cfp12 ./bin/code-foundry daemon --dev &      # without CLAUDE* vars
code-foundry settings set threads.default_model 'claude-haiku-5-5[1m]'
code-foundry plugin install alexwaumann/code-foundry-plugin-showcase@v0.1.1 --enable --yes
code-foundry thread new --no-project --name showcase-test --created-by=
```

Before (the base commit's frontend, exported) and after, both in Playwright WebKit against
that daemon, dark and light, 420 and 280: the Owned tab's "Both (stress)" view shows the
helper live, the narrator paused with Attach and the ticker live; the profile form keeps
`admin` beside "admin is reserved" after Save (before: emptied); the ticker moved to the
bottom panel replays in order (before: `278, 282, …`). Contact sheets are on
`cf/plugins-12-shots`. No messages were sent to the plugin's threads; no secrets were
stored; the daemon was stopped and `~/.cfp12` removed afterwards.

## Gotchas

* `--include=*.tsx` in zsh globs: quote it.
* A clip screenshot of a section taller than the viewport is overlapped by the sticky
  header: shoot with a tall viewport.
* `getBoundingClientRect` is zoomed and `scrollLeft` is not; the tab strip is `relative`
  so a tab's `offsetLeft` is in its own content.
* `TestCLISettings`-style timing flakes: `surfaces/mcp.test.tsx` "Reconnect…" failed once
  under a loaded full run and passed alone (not touched here).
