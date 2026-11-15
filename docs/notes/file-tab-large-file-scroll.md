# File tab: a long file opened at its end

A long file in the File tab (over 400 lines, so the library's virtualizer) could open scrolled
to its last line instead of its first. Found on a 1.1 MB JSON over the read cap, but neither
the size, the cap nor JSON mattered.

## What it depended on

Driven cold (a fresh page) and warm, on the mock and on a `--dev` daemon with real files:

| file | before | after |
| --- | --- | --- |
| mock docs/huge.json (1.1 MB, cut at 1 MiB) | end, every time | top |
| real 3 MB pretty-printed .json (cut) | end | top |
| 700-line .ts (17 KB, whole) | end | top |
| real 1.9 MB .ts (cut) | top once, end once | top |
| real 1.4 MB .md in Source (cut) | top once, end once | top |
| 1.5 MB .txt, 1,200-line .txt | top | top |
| 1.7 MB minified one-line .json | top (one line: not virtualized) | top |
| any of them warm (the grammar already loaded) | top | top |

Wrap on or off made no difference; a Refresh or a re-read kept the reader's place both before
and after. A file opened at a line (`:300`) on a cold open landed at the end too, and after
the first half of the fix at the top: see the line jump below.

## Cause

`File.render` draws nothing while the highlighter loads the file's grammar or theme
(`renderFile` returns null); when it is ready it calls `rerender`, and the virtualizer's next
pass draws the file. That pass first takes a scroll anchor (`getScrollAnchor`), renders, then
scrolls so the anchor stays put (`scrollFix`). The anchor is a file's top, or its bottom when
`fileBottom <= 0`, meaning "the file is above the view". A file not drawn yet is 0 px tall,
so at the top of the box its bottom is 0 too: it was anchored by its bottom at 0, and once the
pass drew it 1,126,736 px tall the fix scrolled by all of that, to the end. Plain text has
no grammar to load and renders in the same pass as the mount, and a warm grammar does too,
which is why it was a race and which files lost it.

## Fix

- `patches/@pierre__diffs@1.5.2.patch`, Virtualizer `getScrollAnchor`: a file is anchored by
  its bottom only when it is above the view (`fileBottom <= 0 && fileTop < 0`). The only case
  that changes is a 0 px file at or below the top, which grows down from its top. The Diff
  tab goes through the same virtualizer, so it gets this too.
- `CodeBody.tsx` `useScrollToLine`: the one estimated jump toward an undrawn line waited for
  nothing, so on a cold open it ran against a 0 px file, was clamped to 0 and never retried.
  It now waits for the file's first rows. Its estimate is now the virtualizer's own
  20 px per unmeasured line (`DEFAULT_VIRTUAL_FILE_METRICS.lineHeight`), not the drawn row's
  19: at 19 the estimate fell 1 px short per line, so `:20000` in a big file landed about
  1,000 lines early, outside the rows the library draws, and never found its row. That was
  wrong before this bug too (warm opens at far lines).

## Test

`e2e/file-open-scroll.spec.ts`: a fresh page opens the mock's docs/huge.json with no line (top,
then a Refresh keeps the place) and at line 30,000 (the line a third down). Both poll until
rows are drawn; each fails without the fix (`first` 56,313 instead of 1; the row never drawn).
Scroll positions after the library's own pass need a real browser, so no vitest test.
