# Search 4: the cross-thread Find dialog (search.open)

PR 4 of 6 in the thread search series, on branch `cf/search-4-find-dialog`. GUI over
`ThreadService.Search` (search-3-index) with a hand-off to the in-thread find bar
(search-2-thread-find). Needs a daemon restart only because the command is defined in Go
(`search.open` is not listed by an older daemon, so its chord does nothing until then).

## What landed

| Path | What |
|---|---|
| `internal/command/commands_view_search.go` | `search.open`, "Search Threads", View, cmd+shift+f, always available (every view, the CLI); a ShowView intent |
| `gui/frontend/src/api/threadSearch.ts` | view models, code point → UTF-16 ranges, `searchThreads`, the preview's reads (`readHitItem`, `readPromptBefore`, `readLastReply`) |
| `gui/frontend/src/lib/threadSearch.ts` | pure: terms (the daemon's `splitTerms`), `handoffQuery`, `queryMatches` (smart case over the query), `currentMatchIndex`, rows, selection, `fitSnippet`, `dayLabel` |
| `gui/frontend/src/stores/threadSearch.ts` | `presentSearch` (the presenter), `openSearchHit`, `openSearchThread`, `openSearchThreadFind`, `activateSearchRow` |
| `gui/frontend/src/components/search/` | `SearchDialog` (shell, query field), `modes.ts` (the mode registry), `FindSearch` (the Find mode), `SearchList` (virtualized), `SearchPreview` + `preview.ts` (paint, count, caption), `useSearch.ts` (debounced search, preview loader), `search.css` |
| `gui/frontend/mock/search.ts` | `ThreadService.Search` and `ListItems` pages (since, last, role) over the mock's world |

## Placement and chrome

- A palette page (`PalettePage` "search", `openSearchPalette`): the palette's Dialog, scrim
  with its 1px blur, top position and `rounded-pane`. Only the width changes:
  `w-[min(1000px,calc(100vw/var(--cf-zoom)-2rem))]`, height `min(620px, 86vh - 2rem)`. Being a
  palette page gives the focus return and the "a presenter picked inside the palette
  reopens it" behaviour for free (`presentSearch` defers like `presentFileFinder`).
- Header: search icon, the field, "Aa" (only while the daemon's answer to the typed query
  says `case_sensitive`; the same chip as the find bar, its tooltip says why). Body: list
  `w-[min(440px,45%)]` and preview. Footer: ⏎ open at message (open thread on a name row),
  ↑↓ move, esc close. The sketch's "⌘⏎ open in panel" and the right-side filter text are not
  built.
- The chord works from anywhere: `search.open` is in `fieldYielded` (keys/bindings.ts), so a
  focused text field (the find bar, a settings search) yields cmd+shift+f too. It does not
  edit text. While the palette is open, chords are not looked up (as for every command).

## Modes (PR 6)

`components/search/modes.ts` lists the modes; each is a component with `SearchModeProps`
(`query`, `header(badges)` which draws the shared field with what the mode puts beside it).
The dialog keeps the query across modes. PR 6 adds Agent search as a second entry and the
switch in `SearchHeader` (shown only when there are several modes). The empty state and
no results are `SearchEmpty` in `FindSearch.tsx`: Recent searches and the "Try Agent search"
row go there.

## Results

- Typing searches after 90 ms (`SEARCH_DEBOUNCE_MS`); each new query aborts the previous
  request and an answer that arrives late is dropped. The last answer stays on screen while
  the next is out, so the list does not blink.
- Rows (`searchRows`): "Threads" (name rows: name with the match tinted, project, archived,
  time), then "Messages · N in M threads" (per thread a header row with project, archived
  and the hit count; up to 3 hits, `per_thread: 3`; then "N more"). A quiet note last for
  `names_only` ("Messages need a word of three letters or more."), `truncated`, or more
  threads matching than shown. The project is the sidebar's place (`useThreadPlace`: the
  workspace label for a set, "No project" for none).
- Hit rows: a fixed 48px speaker column ("You"; "Claude" for Claude's text and questions)
  and the snippet. **`fitSnippet`**: the daemon starts the snippet up to 48 code points
  before its first match, which a 440px row cuts off at the end ("fing…" in the first real
  run); the list cuts the head to about 24 units before the first match, at a word start,
  with "…". Tints are `<mark class="search-hit">`, `color-mix(in oklab, var(--cf-warning) 32%, transparent)`.
- Virtualized (TanStack Virtual) with fixed row heights per kind (`SEARCH_ROW_HEIGHT`), so
  sizes are exact; the selected row scrolls into view with its thread header.
- Selection: only name and hit rows take it. ↑/↓ (and ctrl+n/p) move and wrap like the
  palette; a pointer that moves over a row selects it (pointermove, so rows scrolling under
  a still pointer do not). A new query starts at its first row; the same query answered
  again keeps the row.
- Enter before the typed query is answered waits for the answer and opens its first row
  (like the file finder), so typing and pressing Enter at once never opens the previous
  query's row.

## Ranges

The daemon's ranges are code points; `codePointRanges` converts them once in `src/api`
(an index of each code point's UTF-16 offset). Out-of-range ends clamp; empty ones drop.
The test uses emoji before and as a match.

## Preview

- Crumb "project › thread name", the time (`sentTime`) and "archived".
- A hit: `ListItems(thread, {since: ordinal-1, last: 1})` for the item (its id checked);
  for Claude's text and questions also `ListItems(thread, {role: USER})` and the thread's
  own last user message before the ordinal, drawn dimmed above (the API has no "before"
  query; user messages are small). Both run together; results are cached per row for the
  dialog's life, and a row is read only after the selection rests 40 ms (holding an arrow
  key loads nothing in between).
- Drawn with the timeline's parts: `UserBubble`, `ThreadMarkdown` in `.cf-thread .a-md`, a
  question as its question/answer lines (`questionText`). `ThreadContext` gives path chips
  the thread's cwd.
- Matches are found again in the rendered DOM (`findText`, the find's skip selector) with
  `queryMatches`: every term, smart case over the whole query (one capital letter makes
  every term exact, as the daemon decides), overlaps merged. Painted with the Custom
  Highlight API under new names `cf-search` (32% warning) and `cf-search-current` (solid
  warning, warning foreground), so they never fight the find bar's `cf-find`. Cleared when
  the preview unmounts. The current match is scrolled into view in the preview.
- The caption counts from the data (`findDoc(item).text`, the same text the timeline and
  find use): "N matches in this message · opening it keeps “term” in the thread's find bar".
- A name row: the thread's latest text from Claude (`role: ASSISTANT, last: 8`, the last
  one that is the thread's own and not an API error), under "Latest from Claude"; nothing painted.

## Enter and the hand-off

- Hit: close the palette without handing focus back (`returnTo: "palette"`), select the
  thread, `openThreadFind(threadId, handoffQuery(query), { itemId })`. The find bar takes
  the keyboard (its focusSeq), the timeline scrolls to the item and the first match in it
  is current. Checked in WebKit on the mock and on a real daemon: a question hit expands its
  row and lands on its answer's match.
- **Deviation: `handoffQuery`.** The find bar searches one plain substring. A query of
  several terms (`stale badge`) would find only where they happen to be adjacent, usually
  "0 of 0". One term or one phrase goes over as typed (quotes dropped); several terms hand
  over the longest (the first of equals). The preview's solid match is that term's first
  match in the message, so the preview shows where the bar will land. Smart case then
  follows that term alone in the bar.
- Thread name: select it with its prompt focused; no find bar.
- A thread's header or "N more" under Messages (click only; not keyboard stops): the thread
  with the find bar on the query and no item (it starts at the top of what the list shows).
- Clicking a row does what Enter does; mousedown keeps focus in the field.

## Mock

`mock/search.ts`: the daemon's rules without an index (terms, smart case, names only under
three characters, every term must occur, snippets cut around the first match, ranges in
code points, groups by their newest hit, hits newest-first then in conversation order,
`limit` across groups). `ListItems` now honours a query (since an id or ordinal, last,
role), like `internal/api/thread_read.go`. The scripted s-r1 "Fix stale PR badge" gives
"fingerprint" hits.

## Gotchas

- A user who explicitly bound `"git.fetch" = "cmd+shift+f"` before #494 keeps that
  override, so cmd+shift+f stays git.fetch for them and search has no chord until they
  rebind one of the two. No migration code (agreed).
- In jsdom the virtualizer renders nothing; the dialog test stubs it like the sidebar's.
- `only-export-components`: the non-component helpers live in `preview.ts`, `modes.ts`,
  `lib/threadSearch` and `stores/threadSearch`.

## Left for later PRs

- (PR 6) Agent search as a second mode (`modes.ts`), Recent searches and "Try Agent search"
  in `SearchEmpty`.
- The sketch's "Claude · after 9 steps" in the preview's speaker line needs the turn's
  steps; not built.
- Filters (project, archived) are not exposed; the request supports `project_ids`.

## Tests

- vitest: `api/threadSearch.test.ts` (code points with emoji, mapping, the reads' queries
  and picks), `lib/threadSearch.test.ts` (terms, hand-off, smart-case re-matching, current
  match, `fitSnippet`, rows and notes, selection and wrap, `dayLabel`),
  `components/search/SearchDialog.test.tsx` (the chord through the keymap from a page,
  rows and tints, a late answer dropped, arrows and the preview's reads and caption, Enter
  on a hit / name, a header click, Enter before the answer, Aa / names-only note / no
  results), Go `commands_view_search_test.go` and the ShowView table.
- WebKit e2e `e2e/thread-search.spec.ts`: cmd+shift+f from the home page, typing, arrows
  through hits with the preview's current match painted, Enter landing in s-r1 with the
  find bar focused on the same query and its current match inside the selected item, on
  screen, and the dialog's paint gone.

## Verification

- `make check` green.
- Mock: the e2e spec in WebKit.
- Real daemon (`make drive DAEMON=dev` on a scratch home): three Sonnet 5.5 medium threads
  without a project (one archived, one with two turns), searched "fingerprint": names and
  grouped messages, archived label, Claude's hit under its prompt with six matches
  painted, Enter landing at "4 of 11" (the first match of the selected message) with the
  bar focused, dark and light.
