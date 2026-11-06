# Terminal scrollback: 30,000 rows

A user lost history just by opening a side panel. The scrollback cap counts rows, and narrowing a
terminal rewraps long lines into more rows, so the oldest fall off the cap for good in both xterm
and libghostty: 9,000 lines of 150 characters left 5,008 after one panel open and close.

`threads.scrollback_lines` now defaults to 30,000 and the byte cap to at least 128 MiB.

**This adds headroom only. A full terminal still loses its oldest rows when narrowed.** The cap
still counts rows, so 30,000 lines that each wrap in two keep their newest 15,000 or so. Keeping
history across a resize would need a cap that counts lines, which neither emulator has.

## The byte cap follows the row limit

A fixed 128 MiB undercuts the setting's maximum of 100,000. Measured, at 100,000 rows:

| Columns | Plain | Coloured (a change every 8 cells) | Every cell its own truecolor |
| --- | --- | --- | --- |
| 160 | 132 MiB | 174 MiB | 790 MiB |
| 250 | 206 MiB | 271 MiB | 1,233 MiB |

`scrollbackByteCap` is `max(128 MiB, rows × 3 KiB)`: 3 KiB covers a coloured row at 250 columns
(2.8 KiB), so 128 MiB applies up to about 43,000 rows and 100,000 rows get 293 MiB. With a fixed
128 MiB those four ordinary cases kept 47,000 to 97,000 of 100,000 rows (TestByteCapDoesNotUndercutTheRowLimit).
The cap reserves nothing. Output colouring every cell still hits it, which is what a safety cap is for.

The setting's key stays `threads.scrollback_lines`, so stored settings need no migration; only its
title and description say rows now.

## Snapshot size and replay

xterm's 50 MB limit is on what is pending when a write arrives, not on the size of a write. One
large snapshot goes through; a write made while more than 50 MB is unparsed throws. Output during a
replay is held by `AttachController`, so what is exposed is a tab switch during the replay.

Measured through the real daemon in WebKit (`make drive DAEMON=dev`), at 198 columns on a loaded
machine:

| Output | Rows kept | Snapshot | Parsed in | Live after |
| --- | --- | --- | --- | --- |
| Colour change every 4 cells, foreground and background | 29,801 | 42.7 MB | 410 ms | 700 ms |
| Every cell its own truecolor | 13,001 (byte cap) | 104.1 MB | 780 ms | 1.3 s |

The first row is about twice as dense as the earlier "heavily styled" sample (1.4 KB a row against
0.67 KB), and stays under 50 MB at up to about 230 columns. The second is past 50 MB and replayed
whole as one write; by the same ratio it was already at about 52 MB under the old 64 MiB cap
(estimated, not run).
A tab switch with 104 MB pending recovered: no error, the plain shell live after a second.

From the Go side, at 160 columns and 30,000 rows: plain 4.8 MB in 36 ms, coloured 13.7 MB in 123 ms,
every cell truecolor 193.5 MB in 790 ms with no byte cap.

Opening and closing the panel with 9,000 lines of 150 characters reflowed in 24 ms and 17 ms.

## End to end

`make drive DAEMON=dev`, 9,000 lines of 150 characters, side panel opened and closed: 198 columns
to 137 and back. All 9,000 lines stayed in xterm (18,001 rows while narrow), and all 9,000 came back
in a fresh snapshot after attaching again, so libghostty kept them too.

## Daemon memory

An idle terminal costs the same at any cap (0.3 MiB). A full one is the table above. Attaching is
the expensive moment: a snapshot is built in several passes and held while it is sent. After two
full attaches each to the two terminals above, the daemon's RSS was 2.2 GiB.
Two minutes after killing them it was 540 MiB, with a physical footprint of 1.3 GB, so it goes back
gradually rather than leaking. This was not compared with the old defaults. The worst case's
snapshot doubled with the byte cap, so its peak should have grown about as much; ordinary output
is far below it.

## Rollout

A daemon restart is needed, like any change to this setting: the terminal store reads the limits
when it starts, so nothing changes until then. A user who set a value keeps it. `docs/perf.md` is
left alone: it records what was measured at the time.
