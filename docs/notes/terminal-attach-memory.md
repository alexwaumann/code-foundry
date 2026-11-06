# Terminal attach memory

A user's daemon reached 2.2 GiB with two terminals of very colourful output, attached twice
each. It is not a leak. Attaching made large C buffers, and macOS's malloc keeps large freed
blocks in the process footprint for a long time. Snapshots now stream, so those buffers are
never made.

## Cause

`buildSnapshot` formats a screen three times. `Formatter.Format` (`ghostty_formatter_format_alloc`)
grows its result in a `std.Io.Writer.Allocating` on the C allocator, and Go then copies it out.
libghostty frees that buffer correctly, but `vmmap` shows it staying as `Malloc Large (empty)`
next to a `Deferred Reclaim` region, with no bytes allocated.

A C program with no Go or ghostty in it reproduces the shape, so this is libmalloc: three 30 MB
buffers grown by realloc and freed, per round, add 86 MiB a round up to 1839 MiB, the same
figures as the daemon. `malloc_zone_pressure_relief` returns 0 and changes nothing. Shape
decides it: a same-size `malloc`/`free` loop stays flat at one block and goes after about 80 s
idle, varying sizes reach 194 MiB, and only grown buffers are never reused.

## Fix

Nothing goes through `Formatter.Format` or `Terminal.Snapshot` any more. `formatTo` streams with
`Formatter.WriteTo`:

- the wrapped pass is only measured (`rowCounter`: CRLFs for the padding, size for `out.Grow`);
- the prefix pass goes straight into `out`;
- the full pass is checked against it and only the tail is kept (`tailWriter`).

So a snapshot costs Go one copy instead of four, and C none. The passes stay three: the formatter
cannot emit the suffix alone. `SnapshotWriteTo` replaces `Snapshot` on the alternate screen, and
`formatScrollbackPlain` streams too.

Measured against the old code, snapshots are byte-identical on 400 random VT streams (195 on the
alternate screen, with resizes and compression) and on 28 MB worst-case terminals on both screens.
`BenchmarkSnapshotFullScrollback` is within noise (medians 17.6 and 18.3 ms on a loaded machine).

## Numbers

Worst case: every cell its own truecolor, 198 columns. Footprint above the start, in MiB.
Footprint is `ri_phys_footprint`, the figure Activity Monitor shows.

| Store test | Before | After |
| --- | --- | --- |
| 10,000 rows / 64 MiB, attach 1 | +288 | +119 |
| each further attach | +83 | 0 |
| 60 attaches, no idle | +1866, peak +1977 | +92, peak +120 |
| 30 attaches on the alternate screen | +1802 | +34 |
| 30,000 rows / 128 MiB, 5 attaches | +1249 | +234 |
| the same, after Remove | +1123 | +135 |
| create, fill, attach twice, remove | +172 to +918 over 14 cycles | +4 after 45 cycles |

A real daemon at default limits (80x24), two terminals, each attached twice over the socket:

| Absolute | Before | After |
| --- | --- | --- |
| after the attaches | 1407 | 553 |
| peak | 1407 | 567 |
| after killing them | 771 | 336 |
| two minutes later | 409 | 302 |

`leaks` after 14 cycles, old and new: 796 nodes, 70 KB live, and one 32-byte `xpc_date_t` that is
not ours.

## Gotchas

- `ps` RSS misleads in both directions. It drops when macOS's memory compressor takes pages
  (`vmmap` Swapped) although the footprint does not, which looked like the memory coming back.
  Read `vmmap -summary`, whose Malloc Zone table has live bytes.
- A fork cancels `MADV_FREE_REUSABLE`. In C: dirty 64 MiB, fork, `madvise` returns 0 and the
  footprint stays at 65 MiB; without the fork it falls to 1. Go's `os/exec` forks, and both Go's
  scavenger and scrollback compression rely on that call, so a harness that shells out to `ps`
  changes what it measures, and compression in a daemon that spawns git may save less footprint
  than `MemoryUsage` says: a real daemon kept 211 MiB of the page region (dirty plus swapped) with
  its compressed data live. Not addressed here.
- The 1.8 GiB ceiling was on a 36 GiB Mac, which is 5% of RAM. One machine; the ratio is a guess.
- Attaching still restores every page: `formatter.zig` reads through `node.page()`, which
  decompresses in place, until `CompressAfter` recompresses them. That is bounded by the scrollback
  limits and recompressed as before, so `touch` stays as it was.
- `-race` doubles what `bytes.Buffer.Grow` allocates, since the compiler no longer drops its
  `make` temporary. `TestSnapshotAllocatesOneCopy` allows 2.5 copies: fixed code takes 1 (2 under
  race), `Formatter.Format` 4 (5 under race). It counts `TotalAlloc`, not RSS, so load cannot
  flake it.

## Not determined

- What remains in the real daemon after the terminals go, about 300 MiB, is mostly Go heap regions
  (215 MiB dirty plus swapped). It may be the fork effect above; the daemon's `MemStats` were not
  read. It is there before the fix too.
- When the kernel reclaims the retained blocks, and whether memory pressure does so at once.
  Pressure was not applied on a shared machine.
