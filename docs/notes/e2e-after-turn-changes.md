# e2e failures on main after the turn and sidebar merges (2026-11-19)

The whole e2e suite on a clean origin/main (ba5044970, after #811 to #816) ran 887 tests:
633 passed, 248 skipped (SHOTS and live), 6 failed. Each failure was re-run once on its own
to tell a break from a flake.

## Out-of-date tests: `thread-switch-place.spec.ts` (three tests, after #815)

"a thread left at the bottom opens there again", "a thread left scrolled up opens at the same
row" and "a thread ending in short rows opens with its pane full" all waited for
`[data-index="119"]`, the mock's last row when a finished turn was three rows (question,
folded header, reply). #815 gave every finished turn a gutter row, so the `long` and
`short-turns` threads are 160 rows and the last is 159; row 119 is mid-list and never drawn at
the bottom. The tests take the last index from one constant now.

Not an app break: with the right row, every frame of each switch shows the same row at the same
height, as before, so the row estimates (`gutter`: 28) and the place logic hold with the new rows.

## App break: the footer headers sat 1px in from the rows (`sidebar.spec.ts`, after #811)

"Working section: the header sits on the rows' edge" got x 13 against the rows' 12. #811 wrapped
each footer header in `FooterHeaderBox` with `border border-transparent`, so its drop-target
highlight could turn the border on. The border took a pixel on every side, always: the header
started 1px right of the rows, was 2px narrower and 2px shorter inside its fixed height.

Fix: the highlight is an inset ring (`ring-1 ring-inset ring-cf-focus`), which takes no layout
space, so the box is the plain `HEADER_HEIGHT` box it was before #811 and lights up the same way.
Geometry is the e2e test's to check (jsdom has no layout), so no vitest test was added.

## Flake fixed: `inline-page-frame.spec.ts` "a wheel up over a page at its top scrolls the thread"

Failed about 1 run in 20 with 4 workers on main (7 of 150), the list back at its bottom (892). The test put
the pointer 60px below the page frame's top and wheeled 150px. A scroll over a frame counts as
the user's while the frame is `:hover` (`lib/scrollIntent.ts`). The first tick scrolls the list
up and carries the frame 150px down, out from under the pointer, and under load WebKit sometimes
updated `:hover` before it fired that scroll event (logged: `mouseout IFRAME -> DIV`, then the
scroll with `iframe:hover` false). Not the user's, so the pinned list snapped back.

A real wheel or trackpad moves a few px per event, so the frame does not leave the pointer
within one event; the race came from the test's 150px ticks. The pointer now starts 60px above
the frame's bottom, so it stays over the frame through the first tick, which is the one that
unpins. 0 of 320 runs failed after. Waiting for `:hover` after the
move did not help (9 of 240 failed): the hover was already there; it was lost in the tick.

## Load-sensitive, left as it is: `terminal-find.spec.ts` "Ctrl-C reaches the prompt within seconds of a flood"

Hit its 40 s test timeout once in the full run and passed on re-run (11.6 s). Not related to
these merges (nothing under the terminal changed since 2026-11-15). Timed step by step: alone,
the check before Ctrl-C took 0.1 s and the prompt came 0.16 s after it. With four copies at
once on a machine at load average 50 (other worktrees' checks), the page's main thread, busy
parsing the mock's 256 KiB/ms flood, took about 19 s to answer that check and up to 9 s to take
the key, and 10 of 16 copies ran out of time. Ctrl-C to the prompt itself (the 4 s poll) passed
in every run. The test races the machine's CPU, not anything it can wait for, and the only
test-side changes would be a longer timeout or a smaller flood, so it is unchanged.

## Gotchas

- Several worktrees run e2e on this machine. The mock's ports are fixed (7799 + worker, Vite
  9255) unless `E2E_MOCK_PORT` / `E2E_VITE_PORT` move them; a second run on the defaults fails
  at once with "is already used". `--workers` above `E2E_WORKERS` (4) has no mock for the extra
  workers ("fetch failed").
- "Copy shows on hover" in `thread.spec.ts`, reported failing earlier the same day, was already
  rewritten by #815 (the latest turn's gutter at rest) and passes.
