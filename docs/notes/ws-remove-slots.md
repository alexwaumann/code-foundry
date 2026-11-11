# Removing the stream slots and the plugin live cap

PR 5 of six. WebKit's six connections per origin were why the GUI rationed its streams. #593 moved
every long-lived stream to the tunnel, and sockets do not count against that limit, so the ration
only caused harm: a core view reconnected on a tab switch, and a third plugin node sat paused.

## What went

- `api/streamSlots.ts`, every `slot:` option and claim, priorities and preemption. `holdEmberBoard`,
  `holdDictation`, `startThreadWatch` and `TerminalHost` lost their priority arguments.
- The plugin budget in `live.ts` (`INLINE_LIVE_MAX`, `want`/`drop`/`take`, `useLiveSlot`), `LivePaused`
  with its Paused, Attach and "Waiting for a connection" states, and `ui.MaxLiveNodes`.
- **`LeavingNode` and `useLeavingViewTab`, which the brief did not name.** A node let go of its stream
  while a tab or row choice was in flight, because with six streams open the act hung behind them
  (`docs/notes/plugins-12-renderer-defects.md`, defect 1a). An act no longer waits for a stream, so
  all this did was blank the node and reopen its stream when the act failed. It had a second job,
  though: it showed the act was under way. The detail still dims, and now so do a tabs node's panel
  and a view's body while a tab act is out (below).

## What stayed

- `useOnScreen`. CLAUDE.md asks for it: nothing off screen holds a stream. With the repeat plate
  below, it is what bounds them.
- A terminal node showing "Shown in the bottom panel": that avoids two views of one terminal.
- `MaxDepth`, `MaxElements` and the other view limits, and the 32 live threads and 16 terminals a
  plugin may own. These look tied to the cap but guard the view's size and the plugin's use of real
  processes. They are not stream limits.
- No degrade-to-panel behaviour existed for the cap. Columns and master-detail collapse for width.
- `OPEN_SOCKETS_WARNING` (150) in `wsFetch.ts`: a log line that caps nothing. One view now holds at
  most 48 node streams, so two side by side stay under it and it still finds a leak.
- The stall workarounds, for PR 6. The daemon's fetch routes.

## Does anything need a bound?

Yes, for drawing, though not for sockets: see "Repeats and first mount" after this section, which
changes what these walls can be. This table is from before it, when a repeated terminal id was
another xterm, and it is why the bound went in.

Measured in real WebKit against `daemon --dev` on a scratch home, through Vite. A scratch plugin drew
grids of thread and terminal nodes at the smallest legal size (160 x 120 px), with the panel expanded
and Ember on. The page's `openSocketCount()` and the daemon's `tunnel open` minus `tunnel closed`
agreed in every row, and `lsof` agreed once the unary connections are added. No `tunnel refused`, no
slow subscriber.

| Window | Live nodes | Sockets | Settled | Longest freeze | Ping p50 | Steady WebContent CPU |
| --- | --- | --- | --- | --- | --- | --- |
| 2560x1400 | 16 | 20 | 2.5 s | 1.0 s | 2 ms | 9% |
| 2560x1400 | 60 | 64 | 9 s | 6.9 s | 2 ms | 14% |
| 3840x2160 | 100 | 104 | 37 s | 26.5 s | 2 ms | 33% |
| 3840x2160 | 150 | 154 | 100 s | 67 s | 3 ms | 66% |

"Settled" drops the 2 s of polling that confirms it. All rows are a dev build, where StrictMode mounts
each effect twice, so production should do better. That was not measured.

- **Sockets need no bound.** They follow the screen, not the view: the default panel at 2560x1400 drew
  48 nodes and held 22 live, 26 sockets. Two plugins' surfaces side by side in a split panel, 40 nodes
  all live, held 45, with ping at 4 ms. A second group shares the same screen, so it adds no room.
  `MaxElements` stops a gridded view at about 195 nodes.
- **The ceiling is 198 sockets and failing there is mild.** 196 real streams opened beside the app's
  two. The rest failed with `Insufficient resources`, a plain `TypeError` to `runStream`, so they back
  off and retry. Open streams carried on and ping stayed at 2-5 ms. So one view at the legal maximum
  on a 4K window is about the only way there, and only that view's last nodes would suffer.
- **The real cost is drawing, and a socket bound would not touch it.** A cap on live nodes would, and
  so does the plate below, which caps them per id. Time grows faster than the node count, and the page
  is frozen meanwhile. The sample of the WebContent main thread shows style and layout, and each
  terminal node was its own xterm. A wall of 188 nodes in a dev build on 3840x2160 had opened no node
  stream after about 4.5 minutes, when it was stopped. On production React a 190-node wall finished in
  45 s, frozen nearly all of it.
- **WebKit keeps 16 WebGL contexts per page.** At 28 terminal nodes 12 were on WebGL and 16 on xterm's
  DOM renderer, and all drew correctly. That is the existing fallback, but a wall can now reach it, and
  the oldest context goes, which may be the bottom panel's shell. It repaints in DOM and keeps working.

## Repeats and first mount

A review found the walls above were not "a plugin drawing a hundred live nodes on purpose": a plugin
owns at most 16 terminals, so any wall past 16 repeats ids, and that was the whole cost. Legal use was
fine: 16 distinct terminals with 60k lines each froze 0.8 s, 32 threads 0.3 s. One plugin could still
make the page unusable with 96 nodes re-keyed every 3 s, and only `plugin disable` from a terminal
got out.

**A repeat is a plate.** `useRepeated` in `live.ts` finds the first node in the document naming a
thread or terminal in a view. It keeps the id, and a later node draws "Shown above." with no xterm,
conversation, stream, title bar or set height. The view still renders rather than being refused, so
nothing changes for a plugin that repeats an id by mistake.

- Nodes register once drawn, so a first node in a closed tab or a hidden master-detail side does not
  hide the terminal. Document order, not mount order: "above" stays true when a plugin adds an
  earlier repeat, at the cost of one remount.
- Scoped to the view's watch. Two surfaces keep their own views, as they did, so the bound is 16 and
  32 per view, not per plugin.
- The plate has no title bar: dropping it saved about 0.5 s at 150 nodes, and the first node has the
  buttons.
- "Shown in the bottom panel" wins over the plate, since then no node here shows the terminal.
- Thread nodes get the same plate. Repeats there share one stream, so sockets cost nothing, but each
  draws the conversation: 102 live nodes of one thread with 1,200 items froze 1.8 s, 4.7 s in all.
- Nothing else is live: every other node kind holds no stream.

**A node waits for layout.** A grid inside columns opened 60 streams and 60 xterms and then closed 36.
`useElementWidth` measures in a layout effect, children first, so the grid read its width while the
columns around it were still stacked: the full 1200 px, six columns. The columns then went side by
side, and the grid sat in a quarter of that with six columns of 38 px, until its ResizeObserver's state
landed after the frame. A wall that short was all on screen, and that frame's IntersectionObserver
said so. A plain grid never measures the wrong width.

`useOnScreen` now needs a node to stay on screen for `SETTLE_FRAMES` (4) before it counts; leaving is
at once. Each nesting level settles a frame after the one around it and `ui.MaxDepth` is 4. It counts
frames rather than time because an observer's report comes with a frame, and a page this busy has few.
A node a scroll passes opens nothing either. `flushSync` in the ResizeObserver could fix the wrong
frame too, but a grid changing height there would resize its columns, a shallower element, in the same
delivery, and that reports `ResizeObserver loop completed` on the window. Not tried.

Production build, `daemon --dev`, real WebKit. Before is the reviewer's run or this one's on the head
before the fix, on a lighter machine load than the table above.

| Wall | Before | After |
| --- | --- | --- |
| 60 nodes, 16 ids, grids in 4 columns, 1512x982 | 60 opened, 36 closed, 6.8 s | 7 opened, 0 closed, 0.4 s |
| 150 nodes, 16 ids, grids in 4 columns, 2560x1400 | 96 live, 29.5 s | 16 live, 1.4 s |
| 60 nodes, 16 ids, plain grids, 2560x1400 | 48 live, 4.1 s | 16 live, 0.9 s |
| 150 nodes, 16 ids, plain grids, 2560x1400 | not run | 16 live, 1.2 s |
| 96 nodes re-keyed every 3 s, 2560x1400, pings answered | 6 of 25 in 40 s | 78 of 78 |
| 150 nodes, one thread with 1,200 items, 3840x2160 | 102 live, 1.8 s | 1 live, 0.12 s |
| Legal: 16 distinct terminals, 2560x1400 | 16 live, 1.0 s | 16 live, 0.8 s, no plate |
| Legal: 16 distinct terminals in 4 columns, 1512x700 | not run | 16 opened, 0 closed, 1.0 s |
| Legal: 32 distinct threads in 4 columns, 1512x982 | not run | 16 opened, 0 closed, 0.16 s |

The last bound has a test now: `e2e/plugin-streams.spec.ts` draws grids in columns and asserts the peak
of live nodes, that scrolling closes a node's stream, and that `Attach` streams equal live nodes. It
fails with `useOnScreen` forced true and with the frames taken out (peak 24 against 16).

**A tab act shows it is under way.** With `LeavingNode` gone, the old tab's terminal stayed live under the
new tab's name, taking keys, with no cue. A tabs node's panel and a view's body now dim with `aria-busy`
until the plugin's next view, as a master-detail's detail always did. The nodes stay live, since an
act that fails should change nothing. Keys still reach the old terminal meanwhile.

## The SDK

`MaxLiveNodes` goes outright, with no deprecated stub:

- It was never on the wire or in `Validate`: an untyped constant, compiled into whatever read it. A
  plugin built on an older SDK cannot tell. Built on v0.3.0 and reading it, one ran on this daemon and
  GUI showing `sdk cap 2` with 6 of 6 nodes live.
- Only a rebuild on the new SDK can notice, as `undefined: ui.MaxLiveNodes`, and the fix is deleting the
  reference. A stub would keep a number that no longer means anything, and invite a plugin to size its
  views by it, to save one line for two authors who are being told anyway.
- GitHub code search finds it in no repository of this account but this one. That covers what the
  search can see, so not a private plugin elsewhere.

Removing an exported name is a breaking change to the Go API, so it does not belong in a patch: `go get
-u=patch` should not fail. On v0.x that is a minor, so the tag is `pluginsdk/v0.4.0`. The app's own
version is unaffected: no commit here uses `!` or a breaking-change footer, which
`scripts/next-version.sh` reads as a major.

The tag is not part of this PR. `PLUGINSDK_TAG` is `git tag --points-at HEAD`, read when a release is
built, and the skill's `{{cf.sdkPin}}` then says `pluginsdk@v0.4.0`. Without a tag on that exact commit
it pins the commit's SHA instead. Releases run on every push to main, so a tag made after the merge
misses the tip built from that merge. Nothing breaks: the SHA is the same code, and v0.3.0 was tagged
the same way. For the skill to name v0.4.0, tag the merge commit, then promote with that commit still
at the head of main, or anything later pins a SHA.

## Old daemons and windows

Real v0.21.5 daemon, its own scratch home, this GUI:

- The dialog opened from the ping's version, and the status row said `syncing events…`.
- Calls answered in 3 ms. Streams failed with 401 on their upgrade and held no socket.
- With Events and one thread failing, 5 attempts in 20 s: each stream backs off on its own, with no
  hot loop. Without slots a page tries more streams at once, each on that same backoff.
- A thread showed `Cannot load the conversation`, as it did on the slots.

So nothing on those daemons depended on a slot. A slot only ever delayed a stream that was going to fail.

A window older than this PR on a new daemon still has its slots and cap, which are the page's own: the
daemon changed nothing here. **No daemon restart is needed for the GUI's change**, though the plugin
skill's text ships in the daemon, so an old daemon keeps telling authors about the cap until it restarts.

## Tests removed

All for behaviour that is gone:

- `api/streamSlots.test.ts`: the cap, ordering, preemption, `runStream` with slots.
- `components/plugin/live.test.ts`: the budget reducers. It tested nothing else.
- `renderer.test.tsx`: at most two live with Attach, no Attach while streams wait, waiting for a
  connection, and "adds no stream" for a shared thread, which only read the budget's holders.
  `stores/thread.test.ts` still covers that sharing.
- `layoutprobe.test.tsx`: Attach pausing the oldest. `layoutfuzz.test.tsx`: the budget invariants and
  the Attach poke.
- `masterdetail.test.tsx`, `renderer.test.tsx` and `e2e/plugin-streams.spec.ts`: letting go while leaving.
  Each became the opposite assertion, that a node stays live.

`e2e/plugin-streams.spec.ts` now asserts at least six streams with every node live and acts completing.
`TestLayoutNumbersMatchTheGUI` lost its one `INLINE_LIVE_MAX` row. `layoutprobe.test.tsx` repeated a
thread id by accident, so its third thread has its own id now.

`api/endpoint.test.ts` lists every server-streaming RPC from the generated code and asserts each takes
the socket, and that only `endpoint.ts` imports connect-web. A new service is covered the day it lands.

## Verified end to end

`daemon --dev` on a scratch home, real WebKit: 13 streams at once (Events, the board, the thread, the
surface, four thread nodes, four terminal nodes, a bottom shell), all live.

- 20 switches between two bottom shells: exactly 20 `Attach` opens and 20 `client closed`, nothing else.
- 20 switches between two threads: no new `EventService/Watch` or `WatchBoard`. The thread, its panel
  and its shell reopen, since panels belong to a thread. `no request` lines there are StrictMode's
  mounts leaving at once.
- An act took 11 ms with all of it open.

## Gotcha

`make gui-e2e` failed once on `thread-info.spec.ts:122`, showing `Debug daemon` where it expects `Dev`.
That is older than this PR and has nothing to do with streams: the mock's `reset()` forgot its runs but
not their records, so `server-rollup.spec.ts`'s run reached any `thread-info` test later on that worker.
Run in that order it failed every time. `reset()` now clears the records.

## Not verified

- The built Wails app and WKWebView. All of this ran in headless WebKit.
- Production-build timings, above.
- Thread nodes with real history. These threads were empty, so a large snapshot's cost per node is not
  in the table. Terminals printed a line a second.
- Relaunching in the Wails app. A reload with a 96-node wall open came back at home with the tab
  closed and no freeze, so a relaunch should be a way out too.
- The overlay, a dictation session and a real clone: only their `slot:` lines changed. Unit tests pass.

## Open question

Hiding the window closes no stream, and on return every thread stream reconnects at once
(`stream.ts`, `thread.ts`). That is old behaviour, now without a ration: 33 watches took 0.29 s, so
nothing changed here. Worth a look if a user holds far more threads than that.

Settled in PR 6: showing the window reopens no stream (`docs/notes/ws-stall-workarounds.md`).
