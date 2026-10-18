# Path chips for paths with spaces

Alex (2026-10-18): PDFs and images get no clickable chip in the thread "when there are
spaces" in the path, while other files do. Frontend only (`gui/frontend/src/lib/pathChips.ts`).

## Reproduction

Isolated app (`CODE_FOUNDRY_HOME=/tmp/...`), a scratch project `~/cf-scratch-spaces` with
`docs/my report.pdf` and `shots/screen shot.png`, Haiku 5.5 at medium effort (Haiku 4.5's
id, `claude-4.5-haiku[1m]`, is the Bedrock one and fails off Bedrock).

| Where | Before |
| --- | --- |
| Read tool rows (`ToolPathChip`) | Chips. `toolFileTarget` takes `file_path` as is; clicking opens the File tab for both files. |
| Claude's prose, backticked (`` `docs/my report.pdf` ``) | **No chip**: plain inline code. This is what Claude writes by default (both files, first answer), so this is Alex's bug. Extension does not matter: any spaced path failed; PDFs and screenshots are just the files that have spaces. |
| Prose, bare (asked for "no markdown, one per line") | **Wrong chips**: `/Users/…/docs/my` and `report.pdf` as two chips, each opening a file that does not exist. |
| Prose, double quotes (`"docs/my report.pdf"`) | No chip (same rule as backticks). |
| User bubble | Correct. The bubble draws chips only from composer tokens, and a token's label keeps spaces. A pasted `drop me here.png` became a tile; a tile's original name never reaches Claude (it gets `Attached image: <staged path>`), and an inline chip projects to `[Image: drop me here.png; ref=<staged path>]`. |
| File tab | Opens spaced paths (image preview; a PDF is "Binary file", as for any PDF: the File tab has no PDF viewer). Open in editor / Reveal pass the path as an argv element, not through a shell. |

Cause: `matchPath` refused any whitespace (`PATH_CHARS`), and the prose pass splits on
whitespace, so a spaced path was never a candidate whole, and its pieces could each pass.

## Fix

- **Spaced tokens** (`spacedPathOk`): a token with spaces can only come from something
  that delimits it, so `matchPath` accepts one under extra rules: single spaces (U+0020,
  U+00A0, and U+202F, which macOS puts before "AM" in screenshot names), none at either
  end; balanced parentheses allowed (`report (1).pdf`); must end in a known extension (a
  file, so `npm run build` and folders are out); no word after the first may start with
  `-`, `/`, `~`, `$`, `@` (`/bin/cat /tmp/a b.md`, flags); no word before the last may
  already be a file (`src/a.ts and src/b.ts`); a relative one needs a slash with no space
  before it (`cat docs/a.md`, `open shots/x.png` are commands; `screen shot.png` and
  `My Documents/a.md` do not chip). Absolute, `~/`, `./`, `../` paths may have spaces
  anywhere.
- **Where a spaced token comes from**: a whole inline code span (unchanged call site in
  `components/pr/Markdown.tsx`); a prose quote pair, `"…"`, `“…”`, `‘…’`, `'…'` not
  touching letters on the outside (apostrophes stay apostrophes), the quotes left as text
  and a stop inside the closing quote left out; a prose line that is nothing but the path
  (leading `([{"'` and trailing punctuation aside), which is how Claude lists paths when
  told not to use markdown.
- **Bare in a sentence**: left to the word pass, exactly as before. The first version of
  this PR masked such runs (up to six words from a word with a slash to the first word
  with a known extension that pass as a spaced path), so `/a/docs/my report.pdf` lost its
  wrong pieces; review caught that the same shape is everyday prose ("in
  internal/store/thread add stream.go", "Run /usr/bin/python3 on main.py") whose chips it
  took. The wrong pieces of a bare spaced path in a sentence are the lesser cost, and
  Claude writes those in backticks anyway. Note "the files in src/components like
  Button.tsx" has one chip (`Button.tsx`), before and after: a two-segment folder is not a
  prose chip.
- `splitProse` now decides spans in three passes (quoted, alone on a line, words) instead
  of one word loop; the rehype plugin and the renderer's re-match (`data-cf-path`) are unchanged
  because `matchPath` itself accepts the spaced token.

## Shift-left (projection quoting): not done

The brief suggested quoting `ref=` in `[Image: …; ref=…]` when it has spaces. The
reproduction says it would not help: staged attachments are named `<32 hex>.<ext>` (PDFs
`<hex>-<N>p.pdf`) under `~/.code-foundry/attachments`, so a ref has a space only when
`CODE_FOUNDRY_HOME` does, and the original file name (which may have spaces) is only a
label. Claude also wrote project paths with spaces in backticks unprompted, which now
chip. `lib/prompt.ts`, `lib/userMessage.ts` and the daemon are unchanged; tests pin that
spaced chip names round-trip through `sentComposerText` / `parseUserMessage`.

## Gotchas

- A chip is `inline-flex`, so a line can break between an opening quote and its chip
  (`is "` / `docs/my report.pdf".`). Same as `(src/a.ts)` before this change; left alone.
- Claude may echo the staged hex name (`9d08….png`) bare; that chips relative to the
  checkout and is not found. Pre-existing, unrelated to spaces.
- Driving the real app from a worktree agent: `osascript` "click at" fails (-25208), but
  CGEvent mouse/key/scroll events from a tiny Swift helper work; pasting a file URL from
  the clipboard (`set the clipboard to POSIX file …`) attaches it in the composer.

## Tests

- `pathChips.test.ts`: spaced chips (code, prose, `:line`, parentheses, U+202F, `./`, `../`)
  and 16 spaced non-chips; `splitProse` table for quotes (straight, curly, single, stop
  inside), lines of their own, a label line, bracketed, bare in a sentence (left to the
  word pass: pieces as before), folder-then-file sentences keeping their chips
  (`src/components like Button.tsx`, `internal/store add thread.go`, three-segment variants
  with two chips, `/usr/bin/python3 on main.py`), quoted words, apostrophes, a run stopping
  at a line break; rehype marks a quoted spaced path whole.
- `rows.test.tsx`: an answer with a backticked, a quoted and a line-only spaced path and a
  folder-then-file sentence (five chips, click resolves against the checkout);
  Read rows of an image, a PDF and a spaced folder are chips that open the path.
- `userMessage.test.ts`: image, PDF and U+202F-named chips keep name and staged path.
