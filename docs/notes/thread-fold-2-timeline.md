# Thread fold 2: a message sent mid-turn stays inside its turn

A message sent while Claude works is a steer: the daemon writes its `user` item at once,
so it lands inside the running turn between tool calls, Claude picks it up at its next
step, and the turn ends with a single `turn_end`. `buildTurns` started a new turn at every
user item, so the first half of a steered turn closed without a turn_end (no footer, never
folded) and the one footer went to the second half. Same when the user interrupted after
steering. Frontend only; the daemon is unchanged.

## Decisions

* **The steer rule** (`lib/threadTimeline.ts buildTurns`). A user item is a steer when a
  turn is open and has items after its user message(s), and the turn's last item is not
  an `error`. It is pushed into the turn's items, and `workNodes` turns it into
  `{ type: "steer", key, id }` in order. The other cases behave as before: after a
  turn_end, after a system note, or next to another user item at the start of a turn.
* **An error item ends the turn for this rule.** Every daemon `error` item marks a process
  that ended: it failed to start, stopped unexpectedly mid-turn, or did not get a message
  (`internal/store/thread/items.go KindError`). No turn_end will follow, so the next
  message starts a new turn rather than reading as "sent mid-turn". The e2e "a claude that
  did not start … the next message starts it" depends on this.
* **Folding.** `foldsAway` is false for steers (they stay like notes); `stepCount` excludes
  them. `markFinal` is unchanged: only trailing text counts as the answer, so a steer after
  the last text leaves that turn with no final text, and its work folds away.
* **Working row.** The elapsed time still counts from the turn's opening message, not the
  steer (`t.user` never contains steers).
* **Rendering.** `UserRow` takes `steer`, and `UserBubble` has a `steer` variant (tags,
  chips and thumbnails shared): `data-testid="thread-steer"`, the bubble
  `max-w-[72%] rounded-lg px-3 py-1.5 text-body-sm`, and under it a `text-caption` line
  with lucide `ArrowDown` and "sent mid-turn · 14:12" (UserBubble's `timeOf`). A wake
  message is still a `WakeNoteRow` wherever it lands. `Timeline.tsx estimate` has `steer: 64`.
* **The bubble CSS split.** `thread.css` is unlayered, so its `.u .bubble` size, radius,
  padding and max-width beat Tailwind utilities. Those now sit in `.u:not(.steer) .bubble`
  and the shared fill and border stay in `.u .bubble`, so the steer's role and radius
  utilities apply. `.u.steer` has its own (tighter) margins.
* **Nothing to fold.** `FooterRow` with `steps === 0` renders the line in a plain
  `span.line` (same layout as `.fold`, no chevron, no button, no hover, not focusable).
  The interrupted and failed wording is the same. The copy button still needs
  `finals.length > 0`, so an interrupted or failed turn without final text has none
  (now tested).
* **Wording.** `sendThreadDraft`'s doc says Claude picks the message up mid-turn (a steer).

## Mock and e2e

* `mock/thread.ts send`: sent while the thread is BUSY, it first completes the text
  streaming at that moment, then appends the message and replies in the same turn (one
  turn_end). Before this change the scripted streaming answer kept its caret forever.
* The crashed seed thread (s-4, `end: "cut"`) now ends with the daemon's
  "Claude stopped unexpectedly (exit code 139)" error item, as the real daemon writes it.
  Without it, the "a stopped thread … a message starts it" e2e saw its message become a
  steer.
* New e2e in `thread.spec.ts`: the streaming thread, a message sent mid-turn becomes a
  `thread-steer` with "sent mid-turn · …", never a `thread-user`. The reply ends the turn
  with one more footer, the turn folds, and the steer stays visible.
* Gotcha: virtualization means `thread-user` counts depend on scroll (the turn's opening
  bubble is unmounted while the list sits at the bottom of a long turn). Assert on text,
  not counts.

## Known gap (daemon follow-up)

A process that ends mid-turn on purpose (archive, snooze, a daemon stop or restart while
busy) writes no error and no turn_end (`stream.go`: `r.closing` adds nothing). The next
message after it is then read as a steer of that dead turn: it gets "sent mid-turn" and
shares the new turn's footer. The GUI cannot tell this from the items. A small daemon
change would fix it: an item (a note, or a turn_end marked as cut) when a process ends
mid-turn while closing.

Another edge, not seen live: a message sent after Claude's final text but before its
result arrives. It sits before that turn_end, so it is a steer in the finished turn, and
any reply Claude makes to it in a separate result shows as a turn with no user message.

## Verified live

`make gui-build`, then this worktree's GUI with `CODE_FOUNDRY_HOME=/tmp/cf-fold2`. A
no-project haiku thread (`claude-haiku-5-5[1m]`, medium, auto) was asked to run
`sleep 15` three times, one Bash call each, then reply FIRST DONE. 12 s in,
`thread send` added "Also, when you are done, reply exactly: SECOND DONE." `thread read`:

```
#1 you: Run the shell command `sleep 15` three separate times, …
#2 tool Bash [done] sleep 15 (run 1 of 3)
#3 you: Also, when you are done, reply exactly: SECOND DONE.
#4 thinking
#5 tool Bash [done] sleep 15 (run 2 of 3)
#6 tool Bash [done] sleep 15 (run 3 of 3)
#7 thinking
#8 claude: SECOND DONE.
#9 turn end: success, 38.2s, …
```

The GUI shows one turn. It is folded to the opening bubble, the steer ("sent mid-turn ·
02:54 PM"), the answer and one footer ("Worked for 38s · 5 steps · <$0.01 · Haiku 5.5"),
in dark and light: `thread-fold-2-timeline/steer-dark.png`, `steer-light.png`. The light
shot used the isolated home's `appearance.theme` (reset afterwards; the home was removed).
