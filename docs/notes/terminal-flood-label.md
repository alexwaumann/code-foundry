# Terminal flood label

A terminal printing faster than the page draws is dropped by the daemon every second or so
(`terminal.ErrSlowSubscriber`, `CodeResourceExhausted`), and each drop flashed "Reconnecting…". A
user counted 21 flashes for 21 `dropped slow attach subscriber` lines. Nothing had failed: the next
snapshot has the screen and scrollback, and input keeps working. A drop now stays `live`, as the
page's own `fallBehind` does.

## Decisions

- **`onError`, not `onStatus`, sees the drop.** `onStatus` gets `errorMessage(err)`, only the text.
  `onError` runs just before it with the error, so `isSlowSubscriber` (`api/errors.ts`) reads the
  code and `runStream` is unchanged. Attach returns no other ResourceExhausted.
- **Two statuses follow a drop.** `retrying` with the text, then a bare `retrying` when the next
  attempt starts, since `attempt` is 1 by then. Both must stay quiet, so `dropGrace` silences
  `retrying` as a state and not per call. A clean end with no grace still shows the label.
- **Only a hang needs the timer.** A hung attempt reports nothing after that bare `retrying`, so
  `DROP_GRACE_MS` (5 s) puts the label up. The first message ends the grace; any other error ends
  it at once and shows the label, with why.
- **A drop never restarts the deadline.** Drops in a row that bring no message would otherwise
  hold `live` forever.
- **5 s** is over ten times the longest drop to first message measured, 443 ms in 503 drops, and
  leaves room for a large snapshot: 100 MB at the 26 MB/s measured under a flood is about 4 s.

## On the real daemon

`seq 1 100000000` in headless WebKit against `daemon --dev`:

| Check | Result |
| --- | --- |
| 60 s of flood on the shipped code | 78 drops, 1 flash |
| Ctrl-C during a flood | `seq` gone within about 500 ms |
| Typing after it | Echoed and run |
| Daemon stopped (`SIGSTOP`) 100 ms after a drop | Label 5000 ms after the drop; `live` again after `SIGCONT` |
| Daemon killed 100 ms after a drop | Label at once, and it stays |
| Daemon killed with an idle terminal attached | Label at once, and it stays |

## What is left

- **About 5% of drops used to flash, 24 of 503; now none do, 0 of 324.** The page saw those as a
  dead socket (close 1006), the same as a killed daemon, and showed the label for about 350 ms. A
  flow-control count crossing the daemon's close frame failed the socket inside WebKit, so the
  daemon now holds that frame until no count is due (`docs/notes/tunnel-close-drain.md`). It was not
  the TCP reset this note first suggested.
- **A hang on an open stream shows nothing, as before.** `SIGSTOP` at a moment with no drop left
  the page `live` with no label for the 9 s it was held: an attempt that has sent no heartbeat is
  not watched, and a flood sends none. `fallBehind`'s reopen has no deadline either (from reading
  the code, not run). Neither is new here.
