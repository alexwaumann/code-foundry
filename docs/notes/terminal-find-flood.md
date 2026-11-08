# Terminal find under a flood

A fuzz pass found two things with the terminal's find bar open while a program floods the
terminal (a test re-run, `cat` of a log, a noisy build).

## What was wrong

1. **Ctrl-C took a minute or more to show.** With the bar open on a word on most lines
   (`GET`, `passed`, `INFO`), 20 s of flood, then Ctrl-C: 54 s, 231 s and 52 s to the prompt
   in WebKit, against 0.1 to 0.3 s with the bar closed. Each highlight is an xterm decoration
   with a marker, and xterm calls every marker for every line a full scrollback drops
   (`Buffer.addMarker` listens to `lines.onTrim`, which fires once per line). With 20,000 of
   them a flood parsed at tens of KB/s instead of 9 MB/s, and the up to 8 MiB the attach
   controller had already handed xterm (`MAX_BEHIND_BYTES`) could not be taken back, so the
   prompt waited behind it. The forced re-search every second or so put the markers back as
   fast as the flood trimmed them. It is not only capped counts: one line in two (15,006
   matches, spread over the buffer) took 42 s, and one in four (7,503) 0 to 3 s, depending
   on when a search landed.
2. **The count dropped to "0 of 0" on every reconnect.** A flood makes the controller drop
   its stream and replay a snapshot about once a second. `reset()` published `NO_RESULTS`
   and the snapshot was searched only once it was a second stale, so under steady output the
   bar mostly showed 0, and the current match went back to the newest.

## The fix (find side)

`TerminalFind` (src/terminal/find.ts) is told whether xterm still has output it has not
parsed: `XtermRenderer` counts its writes until their callbacks (`pending`). After each batch
xterm parses:

- **Behind: no highlights.** The decorations go (`clearDecorations(true)`, which keeps the
  addon's query), and a stale search still runs but only counts: its decorations go in the
  same task, before xterm parses on. The count and the current match (the selection) stay.
  The addon's own search after 200 ms without output puts the highlights back, or a stale
  search once xterm has caught up. A step while they are gone searches first, or the addon
  would count nothing.
- **A replay of the same terminal** (`reset(true)`, from the controller's snapshot, never
  from `attach()`): no `NO_RESULTS`. The current match is saved as its line's text, its
  column and length, its row counted up from the cursor, and its screen row when the user
  had scrolled up to it. Once xterm has parsed the replay, the first line at or above that
  row with the same text is selected again (output since the reset only adds lines below
  it), the viewport is put back, and the buffer is searched from there, count only, since the
  rest of a flood follows a replay.

A tab switch (`attach()`, `reset()`) still starts from nothing.

### Gotchas

- **xterm parses the first write after a key at once.** Ctrl-C is a key, so the cursor
  write inside `reset()` was parsed synchronously, `onWriteParsed` fired with nothing
  pending, and the find took the empty reset screen for the parsed replay ("13 of 13").
  `reset()` counts as pending until it returns.
- "Parsed" is "nothing pending at onWriteParsed". It works because the controller holds live
  output until the snapshot is parsed and its write callbacks run in a microtask, after
  `onWriteParsed`; `send()` decrements in xterm's own callback, inside the parse loop.
- Under a real flood the saved match is usually gone by the replay: the controller drops at
  least `MAX_BEHIND_BYTES` before it reconnects, which pushes it out of 30,000 rows. Then the
  search starts from the newest, as before. The place matters for a quiet reconnect (a
  daemon restart, a network drop) and output with long lines.
- Highlights are off for as long as xterm is behind, whatever the count: 7,500 spread-out
  matches slow a flood too. A stream xterm keeps up with (a dev server's log) is unchanged:
  its writes parse within the frame, so nothing is pending at `onWriteParsed`.

## Why not the attach-side bound

The report also suggested bounding what is handed to xterm by time rather than bytes. Not
done: with the find fix every measured row is within a second of the bar closed, and no other
cause of a slow parse was found. A time bound needs a parse-rate estimate, and that estimate
is wrong exactly when it matters: one search took the rate from 9 MB/s to tens of KB/s in one
step, after megabytes had been handed over. To be robust it would have to feed xterm small
batches out of `held` and fall behind on an estimated drain time. That reworks the backlog
accounting that `attach.test.ts` pins, for a case that no longer occurs.

## Measured

Dev daemon, headless WebKit 1280x800, a 30,000-row bash scrollback (`PS1=READY$`), find open,
20 s of flood, Ctrl-C through `term.input("\x03")`, time until the cursor line is the prompt.

| Query open during the flood | Matches | Before | After |
| --- | --- | --- | --- |
| none (bar closed) | – | – | 0.06 / 0.31 s |
| `GET` (every line, `yes`) | 20000+ | 54.2 s | 0.02 to 0.30 s |
| `passed` (3 lines in 4, awk) | 20000+ | 230.7 s | 0.16 to 1.5 s |
| `INFO`, colored vite-style log | 20000+ | 52.0 s | 0.19 to 1.4 s |
| `FAIL` (1 line in 4) | 7,503 | 3.3 / 0.03 s | 0.02 s |
| `HALF` (1 line in 2) | 15,006 | 41.8 s | 0.23 to 0.70 s |

Before, the count at the prompt was "0 of 0" in every row, and samples during a flood read
"0 of 0" now and then. After, the samples (every 3 s) and the count at the prompt stayed at
the count (`20000+`, `7467 of 7467`, …) and never read 0.

A first version dropped the highlights only for capped counts (as the report suggested); it
fixed the three capped rows but `FAIL` then took 4.6 to 12.7 s, because the replay's search
landed on the whole snapshot just before the rest of the flood. Hence highlights off while
xterm is behind, for any count.

## Tests

- vitest `src/terminal/find.test.ts`: a real xterm and addon with the backlog scripted. Behind,
  no markers and the count kept; back after 200 ms of quiet; counted within a second of a
  flood that never pauses; a step while dropped counts; a same-terminal replay keeps the count
  and the match, puts the viewport back, falls back to the newest; a tab switch counts from 0;
  a reset right after a key waits for the snapshot.
- vitest `src/terminal/attach.test.ts`: `attach()` resets for another terminal, each snapshot
  for the same one.
- e2e `e2e/terminal-find.spec.ts`: 31,000 `GET` lines, the bar on `GET` (`20000+`), a mock
  flood (`POST /__mock/terminal/flood`, 256 KiB a millisecond until the shell reads ^C), 6 s,
  Ctrl-C: the prompt within 4 s. Without the fix it times out.
