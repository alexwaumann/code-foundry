# Thread fold 4: a finished turn folds only when pinned; everything folded on return

Every finished turn folded the moment it ended. When the user was scrolled up reading the
work, the rows vanished under them and the list jumped. Alex signed off on this behaviour.
Frontend only.

## Behaviour

* **Pinned-only auto-fold.** A turn folds as it ends only if the timeline is pinned at the
  bottom at that moment. Scrolled up, the turn stays open: its header changes in place
  from "Working · …" to "Worked for …" (chevron open), and the work stays where it was.
* **Fold on re-pin.** The open turns fold once the list is pinned again: Jump to bottom,
  the user's scroll reaching the bottom, or a fold that leaves the kept place past the new
  bottom. That layout change happens while pinned, so the bottom stays in view. A click on
  the header still toggles the turn, and that choice beats the deferral.
* **Folded on return.** When the thread's Timeline unmounts (another thread, a page, the
  pane closing), its deferred turns, the user's fold choices and its rows' expanded state
  are cleared. The next visit shows every finished turn folded and every row closed, and
  the list is pinned at the bottom as before. A turn still running on return is open.

## Decisions

* **The store holds it** (`stores/thread.ts`): `deferred[threadId][turnEndId] = true`, next
  to `folds` and `expanded`. `deferTurnFolds`, `foldDeferredTurns` (a no-op when there are
  none, so it can run on every scroll event at the bottom), `forgetTurnView` (clears all
  three for a thread) and `useDeferredTurns`.
* **Keyed by the turn_end id, not the turn key.** The turn_end is what arrives, so the
  watcher needs no `buildTurns`. `buildRows` takes `deferred(turnEndId)` in
  `TimelineOptions`: `fold(turn) ?? (deferred(end) ? false : defaultFolded)`. It is
  optional, so the e2e helper in `live-stall.spec.ts` that calls `buildRows` is unchanged.
* **No flash: the decision lands in the store update that brings the turn_end.**
  `watchTurnEnds(threadId, onEnd)` subscribes to the zustand store. When the log's `order`
  changes (an item was added; text deltas keep it) it reports turn_end ids it has not seen
  yet. The Timeline subscribes in a layout effect, and in the callback calls
  `deferTurnFolds` if `pinned.current` is false. Zustand calls listeners synchronously
  inside `setState`, and React renders a `useSyncExternalStore` update later (a microtask
  for a concurrent root), so the first render that has the turn_end already has the
  deferral. Deciding in render was the alternative, but it would read `pinned.current`
  during render, which `react-hooks` 7 forbids. A layout-effect fix-up would render folded
  first and run the anchor logic twice.
* **Baseline.** The ends already in the log when the Timeline mounts are not new, and
  neither are those in the first snapshot when the log was absent (the thread opening).
  A resync snapshot that brings a turn_end missed while scrolled up does defer it.
* **`pin()`** in Timeline.tsx replaces every `pinned.current = true` (scroll at the bottom,
  Jump to bottom, the kept header past the new bottom, the anchor past the new bottom): it
  pins and calls `foldDeferredTurns`. A fold from inside the rows layout effect re-renders
  before paint.
* **Leaving clears in a `useEffect` cleanup** keyed on `threadId` (the Timeline is already
  `key={threadId}`). Under StrictMode in dev, the mount-time cleanup also runs, which is
  harmless because the thread's choices were already cleared when it was left.
* **Anchor logic kept.** The fallback that finds the nearest surviving row before the
  anchor no longer runs for a turn that ends while scrolled up, since nothing folds then.
  It still covers rows whose key changes, e.g. a lone Read merging into a group. The
  comments now say so.

## Tests

* `threadTimeline.test.ts`: a deferred turn has a finished, open header and its work; a
  header click still folds it; without the deferral it folds; a running turn is not
  affected.
* `thread.test.ts`: `watchTurnEnds` reports a new turn_end once, from inside the update
  that brings it (the log already has it). It ignores deltas, other items, the ends
  already there, a resync with the same ends, other threads, the first snapshot, and
  anything after unsubscribing. Also covered: `deferTurnFolds` and `foldDeferredTurns`
  (no-op without deferrals), and `forgetTurnView` (other threads untouched, no-op when
  empty).
* No Timeline component test: jsdom has no layout, so the virtualizer mounts nothing.
  The behaviour is covered end to end.
* e2e (`thread.spec.ts`, both schemes where marked):
  * (a) Scrolled up to the live header, the turn ends. The same element becomes "Worked
    for … · 12 steps · $0.04 · Opus 4.8", open, and the header and the first work row do
    not move. A MutationObserver checks `data-folded` never became true on the way.
  * (b) Jump to bottom then folds it, with the header and answer in view.
  * Reading the answer: nothing moves, and the user's wheel back to the bottom folds it.
  * Reading deep in an open Edit row: it stays open in place until Jump to bottom.
  * (c) Pinned: the existing "latest turn folds when it ends" spec, unchanged.
  * (d) The Edit row opened and the turn left open, then s-2 and back: folded, at the
    bottom, and unfolding shows the Edit row closed.
  * Four older specs that asserted the fold on end while scrolled up were rewritten.

## Gotchas

* The leave spec first used `wheelUpTo(Edit)` alone. In WebKit the Edit row could already
  be in view at the bottom, so no wheel ran, the list stayed pinned and the turn folded.
  A real wheel scroll comes first now.
* In the live check, a first turn folded on end although I had sent wheel events: the
  window (min height ~534 pt) barely overflowed early in the turn, so the list was back
  at the bottom (within `PIN_SLACK`), pinned, when the turn ended. That is correct
  behaviour. The second turn was run with the list visibly unpinned (Jump to bottom
  chip shown).

## Verified live

`make gui-build`, then this worktree's GUI with `CODE_FOUNDRY_HOME=/tmp/cf-fold4` and a
no-project haiku thread (`claude-haiku-5-5[1m]`, medium, auto) running `sleep 10` six
times with an echo before each, then three paragraphs. A follow-up asked for the same
again. The window was 1100×534 pt. During the second turn I scrolled up with real wheel
events (a CGEvent helper) until the live header sat mid-screen with the Jump to bottom
chip showing. The turn ended, and the header turned into "Worked for 1m 12s · 7 steps ·
<$0.01 · Haiku 5.5" in place, open, with the Bash rows unmoved
(`thread-fold-4-pinned-fold/open-on-end-dark.png`). Clicking Jump to bottom folded the
turn to the bubble, the header and the answer (`folded-after-jump-dark.png`). A header
click unfolded it with the header in place. Projects and back showed the turn folded
again. The app and its daemon were quit and `/tmp/cf-fold4` removed. No app setting was
changed (only the window size of the isolated copy).
