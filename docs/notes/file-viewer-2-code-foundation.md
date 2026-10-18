# File viewer 2: code and diff rendering on @pierre/diffs

PR 2 of 5 of the file viewer (1: daemon RPCs, 2: this, 3: File and Diff panel tabs, 4: path
chips, 5: PR Code tab). Frontend only. Puts `@pierre/diffs` 1.5.2 in, bridges it to the app's
themes, adds the two components the later PRs build on, and moves the thread's Edit / Write /
NotebookEdit rows and the docked permission diff onto them. The hand-rolled diff
(`lib/diff.ts`, `components/thread/DiffView.tsx`) is gone.

## Files

| Path | What |
| --- | --- |
| `src/lib/codeTheme.ts` | the theme bridge: `codeThemeOf(theme)` (pure), `ensureCodeTheme` (registers once), `useCodeTheme()` |
| `src/stores/codeView.ts` | persisted `code-foundry.codeView`: `diffStyle` (unified), `wrap` (false). Global, not per tab |
| `src/components/code/CodeFile.tsx` | `<CodeFile name contents wrap? lineNumbers? />` on the library's `File` |
| `src/components/code/CodeDiff.tsx` | `<CodeDiff patch />` or `<CodeDiff oldFile newFile />` (either side's `{name, contents}`, old null for an added file) on `PatchDiff` / `MultiFileDiff`; `diffStyle?`, `wrap?`, `lineNumbers?`. `CodeScroll`: the library's `Virtualizer` |
| `src/components/code/useCodeHost.ts` | the StrictMode workaround (gotchas) |
| `src/components/code/code.css` | font metrics as `--diffs-*` custom properties |
| `src/components/thread/ToolDiffView.tsx` | the row's file header (path, Copy diff) above one CodeDiff per part |
| `src/lib/toolSummary.ts` | `toolDiff` (replaces `toolHunks`), `toolDiffFiles`, `diffStats`, `toolDiffStats`, `diffText`, `structuredPatchText` |

## House options

Set by CodeFile / CodeDiff on every render; the rest are the library's defaults.

| option | value |
| --- | --- |
| `theme` / `themeType` | `cf-<app theme id>` / the theme's scheme (lib/codeTheme) |
| `disableFileHeader` | true: callers draw their own header outside the component |
| `disableLineNumbers` | false unless `lineNumbers={false}` |
| `diffStyle` | the store's (default unified) unless the prop fixes it |
| `overflow` | `wrap` / `scroll` from the store's `wrap` (default scroll) unless the prop fixes it |
| `diffIndicators` | bars (library default, set explicitly) |
| `lineDiffType` | word-alt (library default, set explicitly) |
| `hunkSeparators` | line-info (default, not set) |
| `preferredHighlighter` | shiki-js (default: JS regex engine, no wasm) |

No worker pool. Option and file objects are memoized (`useMemo` on their inputs): the library
compares options with `areOptionsEqual` and re-renders on a new identity.

## Theme bridge

One Shiki theme per app theme, built from the catalog's hex `vars` (`src/themes/catalog.json`,
which already carries the syntax colours thread.css scopes under `.cf-thread`), registered
with `registerCustomTheme` the first time a component renders in it. No theme JSON shipped.

- `editor.background` = `--pane`, `editor.foreground` = `--syn-fg`.
- `gitDecoration.added/deleted/modifiedResourceForeground` = `--success` / `--destructive` /
  `--info`: the library reads these for the diff's bars and line tints (it mixes them into the
  background itself), so additions and deletions are the status colours the old diff used.
- TextMate scopes onto the seven `--syn-*`: comment → com (italic); keyword, storage,
  keyword.operator.expression/new, markup.heading → kw; entity.name.function,
  support.function, attribute names, markup.bold → fn; entity.name.type/class/tag,
  support.type/class → type; string, markup.raw, markup.inserted → str; constant.numeric /
  language / character / other, markup.list → num; variable, punctuation, plain
  keyword.operator → fg.
- `useCodeTheme()` follows `useActiveTheme()` (scheme preference, slots, macOS appearance);
  a theme switch changes the option and the library re-renders in the new theme (checked
  live: dark → light on the open thread).
- Test: every catalog theme produces a complete theme with hex colours, its comment / keyword /
  string colours are the catalog's, and the 22 names are distinct.

Checked by eye in a throwaway page (not committed): a markdown note, a Go file, a proto file
and a TS file in GitHub Dark, GitHub Light, Catppuccin Latte and Rosé Pine. Grammars load
lazily: each is its own chunk (`go-*.js`, `proto-*.js`, `markdown-*.js`, `typescript-*.js`).

## Thread rows

Source per row is `toolDiff(t)` (what `toolHunks` read before):

| tool | renders |
| --- | --- |
| any, result has a non-empty `structuredPatch` | a git-style patch (`diff --git a/p b/p`, `---`, `+++`, `@@ -o,n +o,m @@`, Claude's lines) → `PatchDiff`, real line numbers |
| Edit (no result yet: waiting for permission) | `old_string` → `new_string` → `MultiFileDiff`, line numbers off |
| MultiEdit | one pair per edit, one `MultiFileDiff` each, stacked under one header |
| Write | `content` as an added file (old null), numbered; an `update` result with an empty patch has no diff |
| NotebookEdit (new) | `new_source` as an added cell (`cell.py`, or `cell.md` for markdown, or the result's `language`), line numbers off; `edit_mode: delete` has no diff. The old source is not in the input |

- Snippet pairs (unnumbered) get a trailing newline on both sides, so the library does not
  draw "No newline at end of file" under an Edit's strings.
- Stats (`+N −M` on the row and on the docked prompt's toggle) are summed from the library's
  `FileDiffMetadata` hunks (`parsePatchFiles`, `parseDiffFromFile`). The row computes them once
  per item object (`WeakMap`), since a row calls `toolSummary` twice per render.
- Copy diff copies the patch itself, or for pairs each hunk as `@@` plus `-`/`+`/space lines.
- Lines wrap in the thread (`wrap` fixed true on these rows, as the old diff and the rest of
  the thread's output do); unified/split follows the store, so PR 3's toggle applies here too.
- The row's header (path, dir muted, Copy) is the old one, moved into `ToolDiffView`; its
  `.diff .dh` rules stay.
- Long diffs: above 400 rendered lines the parts render inside `CodeScroll` (the library's
  `Virtualizer`) in a 480px scroll box that lays out only the visible lines. Chosen over
  `collapsed` (which hides the whole file, not a tail) and replaces "Show N more lines".

## Read rows

Stay on lowlight. The library's `File` numbers lines from 1 (`FileRenderer`:
`lineNumber = lineIndex + 1`); `startingLine` in its types is a render-range index for
virtualization, not a number offset, and there is no other offset option. A Read with an
offset starts at `result.file.startLine`, so Read keeps its own gutter (`.diff .l`, `.l .o`).
PR 3's File tab shows whole files, which start at 1.

## Removed

`lib/diff.ts` and its test, `components/thread/DiffView.tsx`, `markTokens` / `MarkedToken`
in `lib/highlight.ts` (only DiffView marked tokens) and `TokenSpans`' `mark` prop; thread.css
`.diff .hunk`, `.l .n`, `.l .g`, `.l.la*`, `.l.lr*`, `.l ins`, `.l del`, `.diff .more`.
`lib/highlight.ts` otherwise unchanged (fenced blocks, shell commands, Read).

## Bundle

| | origin/main | this PR |
| --- | --- | --- |
| main chunk (`index-*.js`) | 2.90 MB (843 KB gzip) | 3.41 MB (984 KB gzip): +508 KB, +141 KB gzip |
| `dist/assets` | 4.9 MB, 6 files | 16 MB, 324 files |

The main chunk gains the library, Shiki's core and the JS regex engine (the thread pane is in
the main chunk; `stores/threadActions` → `lib/threadRequest` → `lib/toolSummary` imports the
library's parsers too). The rest is Shiki's lazy chunks: every bundled grammar and theme is a
dynamic import, fetched only when a file of that language (or that bundled theme) renders. We
use none of the bundled themes. They ride in the binary's embedded assets.

## Gotchas

- **StrictMode and `disableFileHeader`** (1.5.2): the library's `cleanUp` leaves its empty
  `<pre>` in the shadow root. StrictMode's double ref attach (development and e2e only) then
  re-hydrates the same `<diffs-container>`, finds the `<pre>`, takes it for prerendered HTML
  and, with the header disabled, never renders: an empty diff. With the header on it works
  only because the header is missing too. `useCodeHost` empties the shadow root when the
  component detaches, so a re-attach starts clean. Production builds never double-attach.
- The diff lives in an open shadow root: jsdom tests see `<diffs-container>` but not its
  lines (rows.test checks the container); Playwright's CSS locators pierce it
  (`[data-code] [data-line][data-line-type="change-addition"]`).
- A patch without `diff --git` keeps the `a/` / `b/` prefixes in the names and reads as a rename;
  `structuredPatchText` writes the git header.
- Rendering is async (theme and grammar resolve first): an e2e that measures a diff right after
  opening it must wait for its lines.

## Verified

- `make check` green (one unrelated Go test failed once and passed on rerun).
- `make gui-e2e` subset: `e2e/thread.spec.ts`, `e2e/thread-prompts.spec.ts` on Chromium, 46 passed.
- Live (`make gui-build`, isolated `CODE_FOUNDRY_HOME`, scratch repo, haiku 5.5 / medium,
  supervised): Read, Edit (structuredPatch, word-level marks on `Hello,` / `Hi there,` and
  `!` / `.`), Write (created NOTES.md, numbered, all added) and a pending Edit (row and docked
  prompt, word-level `, "Barbara"`), dark and light. Screenshots in the PR body.
