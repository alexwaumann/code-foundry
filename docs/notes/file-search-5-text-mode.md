# File search 5: Text mode in the finder

Status: PR 5 of 5 for file search, on branch `cf/file-search-5-text-mode`. PR 4
(`docs/notes/file-search-4-text-rpc.md`) gave the daemon `FilesystemService.SearchText`; this PR
is its GUI: a second mode of the cmd+P finder, a command and chord for it, and a line on the `@`
file tag. Agreed from the sketch "3 · Text search A: list + preview" (and view 2 for the switch);
views 4 and 5 (stacked, excerpts) were rejected and are not built.

## What landed

| Path | What |
|---|---|
| `internal/command/commands_view_file_find_text.go` | `file.find.text`, "Search in Files…", View, cmd+shift+p, file.find's availability (canFindFiles); a ShowView intent |
| `internal/command/chord.go` | cmd+shift+p is no longer reserved: the palette keeps cmd+k only |
| `internal/store/thread/filerefs.go`, `provisional.go` | a file reference's `#L<n>` passes through to Claude; the provisional name reads `a.ts:24` |
| `src/api/textSearch.ts` | view models (ranges to UTF-16 once), `searchText` (the stream: files to a callback, the summary as the result), `textSearchError` (query / unavailable / other) |
| `src/lib/textSearch.ts`, `src/lib/textQuery.ts` | pure: minimum length, search key, rows grouped by file, counts and caps, selection, status, a row's line runs; smart case and the query as a RegExp (`textQuery.ts` has no imports: the mock shares it) |
| `src/components/palette/FileFinder.tsx` | the finder holds the query, the toggles and the preview cache across modes; `FilesMode` is the old body plus the switch, Tab and the line on ⌘⏎ |
| `src/components/palette/TextFinder.tsx`, `TextResults.tsx`, `TextPreview.tsx`, `previewPaint.ts`, `useTextSearch.ts`, `FinderModeSwitch.tsx` | Text mode: header with toggles and switch, the virtualized list, the preview, the paint, the stream and read hooks |
| `src/stores/ui.ts` | `palette.fileMode`, `openFilesPalette(threadId, mode)`, `setFileFinderMode` |
| `src/stores/fileFinder.ts` | `presentTextFinder`, `openTextMatch` (open at the line, hand the find bar the query), `tagFoundFile(…, line)` |
| `src/components/palette/CommandPalette.tsx` | the dialog takes the thread search dialog's width in Text mode |
| `src/lib/prompt.ts`, `components/compose/tagContext.ts`, `TagView.tsx`, `lib/userMessage.ts`, `lib/promptRail.ts`, `thread/UserBubble.tsx` | the file tag's optional line |
| `src/components/files/CodeBody.tsx`, `useFileFind.ts`, `code/codeCss.ts` | `lineAt` (where the line lands), `observeShadow` and `revealSideways` exported, the preview's `::highlight` rules in the shadow root |
| `src/keys/bindings.ts`, `stores/views.ts`, `mock/world.ts`, `mock/settings.ts` | cmd+shift+p off the view actions; the presenter; the mock's command and reserved list |
| settings schema, `project.files.include`, Settings and project page texts | "text search" back in the include descriptions (PR #741 left it out) |

## Decisions

* **One finder, two modes.** Text is a mode of the palette's `files` page (`palette.fileMode`),
  not a new dialog. Tab (or shift+Tab) in the field, or the Files / Text switch at the field's
  right, changes it; the typed text stays. In Text mode `CommandPalette` gives the dialog the
  thread search dialog's width (1000px clamped) and the body sets its height (620px clamped);
  Files mode keeps `max-w-xl`. The toggles and the preview's reads live in `FileFinder`, so
  they last for the finder's life across mode switches; they are not remembered across opens.
  Files mode's hooks (SearchFiles, the worktree details) do not run in Text mode and the Text
  stream does not run in Files mode: each mode is its own component.
* **Chords.** `file.find.text` binds cmd+shift+p, which the palette gave up (a changed
  default chord: the palette is cmd+k only). Removed from `ReservedChords`, `viewActions` and
  the mock's reserved list; the e2e that pressed cmd+shift+p for the palette press cmd+k now.
  The spec's key table in `docs/notes/shell-model.md` is unchanged (it lists cmd+k and cmd+p
  only).
* **Minimum query: 2 characters (code points), spaces included.** One character matches
  nearly every line: the daemon stops at 2,000 lines after its first chunk, the list is
  noise, and every search's first keystroke would start a stream (and ripgreps) that the
  second one cancels. The query is not trimmed: spaces are text.
* **Debounce 120 ms** (Files mode's is 80): each search starts ripgrep. One stream at a time;
  the request's AbortController is aborted by a newer key (query, any toggle, the checkouts),
  by leaving Text mode and by closing (the component unmounts). The previous answer stays on
  screen until the new search's first message (its files, or a summary alone for no match);
  files then append as messages arrive.
* **Rows.** Per file a header (name, directory dimmed and cut from the left like Files mode,
  the project's name with several checkouts, a quiet `ignored`, the count: `line_count`,
  `999+` when capped), its lines, and a quiet "N more in this file" when the file has more
  matching lines than were sent (the 50-line cap or the total cap cutting it). A line row is
  its number and its text in the code font, every range tinted (`.search-hit`, the thread
  search's tint), its indentation dropped unless a match is in it, cut in front so the first
  match shows in the 440px column (`fitSnippet`, about 20 characters before the match), and
  an ellipsis wherever the daemon cut it. Only line rows take the selection; ↑↓ and ctrl+n/p
  wrap; a new answer selects its first match; more messages of the same answer keep it.
* **Status** (footer, left): "N matches in M files" where N is the sum of the files'
  `line_count` (lines, not occurrences; "+" when some file's count was capped or the search
  stopped), "Searching… …" while the stream runs, "No matches". Quiet notes: "stopped at 2,000
  lines", "stopped after 15 s".
* **Errors.** InvalidArgument (an invalid regex, a too long query) is said in a band right
  under the field, with `aria-invalid` on it, never a toast; FailedPrecondition (ripgrep
  missing or broken) shows the daemon's sentence in the list; anything else "Cannot search: …".
* **Aa.** Pressed when match case is on, or when the summary for the typed query says it ran
  case-sensitive (smart case); its tooltip then says why. A click flips the explicit option.
  Whole word and regex are plain toggles. ⌥C, ⌥W, ⌥R toggle them from the field (by key code:
  ⌥C types ç); the tooltips name them.
* **Preview.** Read with `readFile` (the File tab's read) once the selection rests 60 ms,
  cached per finder (24 files, least recently shown dropped; a failed read is not kept), drawn
  with the File tab's `CodeBody` (the same @pierre/diffs highlighting, line numbers, the line
  marked with the library's selection), with `lineAt: 0.5` so the line lands in the middle. The
  query's matches on the rendered lines are painted with the Custom Highlight API under
  `cf-text-search` / `cf-text-search-current` (rules in `CODE_SHADOW_CSS`, the ranges in the
  shadow root), repainted as the library renders more lines (`observeShadow`); the selected
  row's first range is solid, then brought into view sideways past the gutter. The preview
  matches lines again in JavaScript with the daemon's rules (`queryRegExp`); a regex only Rust
  can compile paints just the selected line, from the daemon's own ranges. No highlighter of
  its own.
* **When the file cannot show the match** the row's own line (number, tinted text, ellipses)
  stands in with a quiet note, never an error wall: a failed read, a file gone, not text, cut
  by the reader's 1 MiB before the line, or changed since the search (the line at that number
  no longer contains the row's text; a cut row's text is a substring of its line, so the check
  is `includes`).
* **Enter** opens the file in a File tab beside the thread at the line (`openFoundFile`, as
  Files mode), and when the query is something the File tab's find bar can search (literal,
  not whole word, and the bar's smart case over the query agrees with how the search ran)
  opens the bar on it with the line's first match current (`openTextMatch`:
  `openFileFind`, `setFileFindQuery`, `setFileFindCurrent({line: n-1, nth: 0}, reveal)`). The
  bar then has the keyboard, in the file's pane. A regex or whole-word search just opens at the
  line. Enter before the typed query's first answer waits for it and takes its first match
  (the finder's rule); a click acts at once on the row it hit. IME keys are ignored
  (`imeKeyDown`).
* **⌘⏎ and the tag's line.** `PromptTag` file gains `line?`; the draft token is
  `[Composer.tsx:24](cf-file://<project>/src/Composer.tsx#L24)` (a `#` in a name is
  percent-encoded, so a bare `#L<n>` at the end is always the line), the chip reads `name:24`,
  its tooltip `path:24`. Claude gets `@cf-file://<project>/<path>#L24`; the daemon's rewrite
  leaves the suffix alone, so Claude Code receives `@/abs/path#L24`, the form its `@` mention
  reads a line from (its parser is `^([^#]+)(?:#L(\d+)(?:-(\d+))?)?`). Old drafts and history
  without a line parse as before. A directory takes no line. Files mode's `name:42` then ⌘⏎
  tags line 42 too. The node keeps the line as a string attribute (`line`, "" for none).

## Differences from the sketch

* The toggles are icon toggles (lucide `CaseSensitive`, `WholeWord`, `Regex` on shadcn's
  Toggle) with name-and-key tooltips, not the sketch's text chips "Aa ab .*": the app's
  icon-control convention.
* ⌘⏎ for "@ in prompt", not ⌥⏎ (the user's choice in PR #741).
* `ignored` is quiet text like Files mode's label, not the sketch's bordered chip.
* The selected line in the preview is marked by the File tab's line selection (the code view's
  own colour), not the sketch's warning-tinted band with a left bar: the preview reuses the File
  tab's rendering as agreed.
* The list drops indentation and cuts a long line in front of its first match; the sketch's
  lines were short. A "N more in this file" row appears when a file's lines were capped.
* The invalid-regex message is a band under the header (the field has no room beside it).

## Tests

* Go: `TestFileFindTextAvailability`, `TestFileFindTextWhyUnavailable`,
  `TestFileFindTextKeybinding` (cmd+shift+p not reserved and bound only here), the registration
  and ShowView tables; `TestRewriteFileRefs` (a `#L42` passes through, after `%23` too),
  `TestProvisionalName` (`a.ts:24`).
* Vitest: `lib/textSearch.test.ts` (minimum length, keys, smart case, RegExp and ranges with
  emoji, the find bar hand-off rule, grouping, dedupe, counts, caps, selection wrap, status and
  notes, line runs with non-ASCII text, indentation and cuts); `api/textSearch.test.ts` (mapping,
  code points to UTF-16, errors); `palette/previewPaint.test.ts` (each fallback);
  `palette/TextFinder.test.tsx` (the presenter, cmd+shift+p through the keymap, the width, Tab and
  the switch keeping the query, under 2 characters, streaming and the status, caps, abort and no
  blink, no match, aborting on mode switch and close, toggles and ⌥ keys, Aa from the summary,
  the regex error by the field, ripgrep missing, arrows and wrap, the preview's read, its
  fallback and its cache, Enter with and without the find bar, Enter before the answer, an IME
  Enter, ⌘⏎ with the line); `palette/FileFinder.test.tsx` (`name:42` ⌘⏎);
  `lib/prompt.test.ts` and `compose/tagContext.test.ts` (token, label, projection, `%23`, an old
  token, a directory, the node attribute); `keys/bindings.test.ts` (cmd+shift+p not the palette's).
* Playwright `e2e/file-text-search.spec.ts`: cmd+shift+p from a thread's prompt, the dialog
  wide in Text and narrow in Files, the preview's solid match painted inside the shadow root
  and centred (between 30% and 70% of the box), Enter landing in the File tab with the find bar
  focused on the query at "2 of 2" and the keyboard in that pane, the preview's paint gone.
  `SHOTS=<dir>` saves the PR's screenshots (before: the same spec on origin/main, where Text
  mode is skipped). `e2e/app.spec.ts`'s two palette-chord tests press cmd+k.

## Verified end to end

`make build`, `make drive DAEMON=dev` on its own home (`/tmp/cfts5`), a scratch git repo under
home with `src/app.ts`, `README.md`, an ignored `.env.local` and an ignored `node_modules`,
registered with `project add`, a Sonnet 5.5 medium thread in it, driven with `playwright cli`:

* cmd+shift+p from the thread: Text mode; `needle` listed `.env.local` (labelled ignored),
  `README.md` and `src/app.ts` (4 lines), nothing from `node_modules`; "6 matches in 3 files".
* ⌥C: only the two lower-case `needle` lines; ⌥W with it: the same; ⌥C off: whole word
  without case, five lines (not `loadNeedle`). Regex `(needle`: "invalid regular expression:
  unclosed group" under the field; `ne+dle\(` found the two `loadNeedle(` lines.
* The preview showed each file highlighted, the line centred, the match solid.
* Enter on `src/app.ts:3`: a File tab beside the thread at line 3, the find bar focused on
  `needle` at "3 of 5".
* `return process` then ⌘⏎: the chip `app.ts:7`; sent with "quote that line exactly…". The
  thread's item text was `@cf-file://<project>/src/app.ts#L7 …`; Claude's transcript's user
  message was `@/Users/…/cfts5-scratch/src/app.ts#L7 …`, and Claude answered with line 7 in
  1.4 s without a tool call (the mention attached the line).
* Cleanup: the thread removed (`thread remove`), the drive stopped by its pid, the scratch repo
  and home deleted. Claude Code keeps its transcript folder for the scratch path under
  `~/.claude/projects`; that shared folder was left alone.

## Gotchas

* macOS file names are case-insensitive: `textPreview.ts` beside `TextPreview.tsx` broke the
  type check ("differs only in casing"); the helpers are `previewPaint.ts`.
* `lib/threadFind.ts` pulls in markdown and thread code; the mock (run by `tsx`) shares only
  `lib/textQuery.ts`, which imports nothing.
* An archived thread's prompt took no tag from ⌘⏎ in the mock (Files mode as well, so not this
  PR's); active threads do.
