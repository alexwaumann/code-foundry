# Terminal REP cap

One line of output could wedge a terminal for good:

```
printf 'e\xcc\x81\xcc\x81\xcc\x81\033[2147483647b\n'
```

xterm 6.0.0's REP handler allocates `new Uint32Array(text.length * count)` with no cap on the count.
WebKit throws `RangeError: Out of memory` at 2^33 elements, and that throw ends xterm's parse loop.
`unparsed` never drains, the phase stays `live` over a frozen screen, and a new tab in the same host
stays blank, because its snapshot waits for `unparsed === 0`. Reproduced here on a dev daemon before
the fix: `unparsed` stuck at 253 and the `echo` after it never shown. Smaller products hang instead
of throwing: `A` with the same count froze the page for over a minute.

## The fix

`XtermRenderer.capRepeats` registers a `CSI b` handler. It swallows a REP when `count x code units in
the repeated cell` is over `MAX_REPEAT_UNITS`, and otherwise lets xterm run it.

**Why 4096.** A program uses REP to fill part of a row, and the daemon refuses a grid wider than
`maxDimension` (4096, `internal/store/terminal/manager.go`), so no row can need more. It also bounds
the cost of a flood, measured in WebKit over 64 KiB of nothing but REP:

| Count | Main thread blocked per 64 KiB |
| --- | --- |
| 80 | 38 ms |
| 1024 | 223 ms |
| 4096 | 616 ms |
| 16384 | about 2.3 s (6 KB measured, scaled) |
| 65535 | about 8.6 s (6 KB measured, scaled) |

65535 would have matched Ghostty's ceiling (below), and was rejected for that last row.

**Why code units and not only the count.** A count cap alone leaves the same bug one step away: xterm
keeps no limit on the combining marks in a cell, so `e` with 300,000 marks and a count of 4096 asks for
1.2 billion elements, about 4.9 GB. That figure is arithmetic; the count-only version was not run.
The handler reads the cell through the public buffer API, stepping back over the spacer of a wide
character, which is the cell xterm's own `getString(x)` reads. One limit covers both, and a real
cluster still fills a real row: an 11-unit family emoji repeats 372 times, 744 columns.

The handler cannot clamp: `registerCsiHandler` passes a copy of the params, and nothing on the public
API prints synchronously from inside the parser. So an over-limit REP prints nothing.

## Against Ghostty

Read at the pinned commit (`scripts/ghostty-vt.sh`).

| | libghostty (the snapshot) | xterm (the live view) |
| --- | --- | --- |
| Count | `u16`, saturating in `Parser.zig`: never above 65535 | Up to 2^31 - 1, capped here |
| What repeats | `previous_char`, one code point; combining marks are not it | The whole cell, marks included |
| More than one param | Ignored | Uses the first |
| Count 0 or none | 1 | 1 |

Counts up to the cap agree for plain characters. Above it the two differ until the next snapshot:
`A\033[5000b` showed 1 `A` live and 5001 after a remount, and output after it draws from a different
cursor until then. That is the accepted cost. No real program sends it, and the daemon stays right.
The cluster row is an older difference this does not touch.

## Checked live

`make drive DAEMON=dev`, a bottom-panel shell in WebKit, `echo` after each. All returned in under
half a second with `unparsed` 0 and phase `live`: the cluster and `A` reproductions, one emoji with
the same count, and `e` with 300,000 marks and a count of 4096. `Z\033[9b` printed ten `Z`, and a new
tab reached `live`.

## Key order across a remount

The input queue belonged to the controller, and cmd+j remounts the host, so keys queued in the old
controller flushed beside the new one's: `a`, `b`, dispose, `c` sent `a`, `c`, `b`. The queue is now
`TerminalInput` (`terminal/input.ts`), per terminal id, one instance for the app in `TerminalHost`.

- It comes in through `AttachDeps` and is not a bare module-level map, so each test gets its own and
  a Write a test leaves unsettled cannot hold up the next one.
- A queue exists only while it has something to send. A closed terminal's Write fails
  (`ErrNotFound`), which drops what waited and removes the queue. An exited one's controller already
  takes no input.
- A failed Write tells each controller with keys in the batch once, so the live one shows
  `write failed` and a disposed one only reports the transport error.
- Changed on purpose: terminals no longer wait for each other's Write. Order across two terminals
  was never a guarantee, and a key in `t2` no longer waits on a slow `t1`.
- One cost: a Write that never settles now holds that terminal's input across a remount, where a new
  controller used to start fresh. Terminal input is a unary call on fetch, which fails when the
  daemon goes away, so nothing is known to do this.

## Follow-ups

**A watchdog: not yet.** Recreating the renderer when `unparsed` stops moving would recover from any
parser throw, but REP is the only known one and it is gone. It would take a timer armed while
`unparsed > 0` with no parsed callback for about 10 s, only while the document is visible, since
hidden pages throttle xterm's timer. The controller would need a renderer factory in place of its one
fixed renderer, new `onData` and `onResize` subscriptions, and its counters reset, and the host would
have to re-mount into the element and restore WebGL, font and find state. The snapshot brings back
the screen, so nothing is lost. Worth building if a second trigger appears.

**Other uncapped counts.** These loop `count` times and do not allocate, so they hang and then
recover, with no wedge. Measured at 1,000,000 and scaled to 2^31 - 1, they freeze the page for about
nine minutes each: `CSI Ps S`, `T`, `L` and `M`. `CSI Ps I` is about 25 s. Not fixed here. A swallow
like this one would do, capped at the grid's rows.
