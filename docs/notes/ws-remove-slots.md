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
  all this did was blank the node and reopen its stream when the act failed. The detail still dims.

## What stayed

- `useOnScreen`. CLAUDE.md asks for it: nothing off screen holds a stream. It is also what bounds them.
- A terminal node showing "Shown in the bottom panel": that avoids two views of one terminal.
- `MaxDepth`, `MaxElements` and the other view limits, and the 32 live threads and 16 terminals a
  plugin may own. These look tied to the cap but guard the view's size and the plugin's use of real
  processes. They are not stream limits.
- No degrade-to-panel behaviour existed for the cap. Columns and master-detail collapse for width.
- `OPEN_SOCKETS_WARNING` (150) in `wsFetch.ts`: a log line that caps nothing. A legal wall can now
  cross it (below), which reads as a leak when it is not. Left as it is, since it still finds one.
- The stall workarounds, for PR 6. The daemon's fetch routes.

## Does anything need a bound?

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
- **The real cost is drawing, and a socket bound would not touch it.** Time grows faster than the node
  count, and the page is frozen meanwhile. The sample of the WebContent main thread shows style and
  layout. Each terminal node is its own xterm, which is the likely cause, though nothing here pins it
  down. A wall of 188 nodes on 3840x2160 had opened no node stream after about 4.5 minutes, when it was
  stopped. Whether it would have finished is not known. That needs a plugin drawing a hundred or more
  live nodes on purpose, so no bound went in on a guess. If one ever shows up, stagger the mounts.
- **WebKit keeps 16 WebGL contexts per page.** At 28 terminal nodes 12 were on WebGL and 16 on xterm's
  DOM renderer, and all drew correctly. That is the existing fallback, but a wall can now reach it, and
  the oldest context goes, which may be the bottom panel's shell. It repaints in DOM and keeps working.

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
`TestLayoutNumbersMatchTheGUI` lost its one `INLINE_LIVE_MAX` row.

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
- Relaunching with a very large wall open: the tab reopens, so it would likely freeze again, and
  `plugin disable` from a terminal should be the way out.
- The overlay, a dictation session and a real clone: only their `slot:` lines changed. Unit tests pass.
