# Fuzz 2026-11-15: search (file finder includes + Text mode)

Two findings from the fuzz pass since v0.21.7, fixed in one PR.

## 1. A text search result in a minified file froze the window

A user's repo with a committed `d3.min.js` (280 KB on one line): cmd+shift+P, `function`,
arrow onto its row, and the window took no input for 129 s. Enter (the File tab's find bar on
the query, 2,362 matches on the line) had still not painted after six minutes.

Cause: the preview (`previewPaint.ts`) and the File tab's find (`useFileFind.ts` codeSurface)
put a Custom Highlight range on every match of every rendered line. Measured in WebKit:

- Each range costs about the length of its line on every frame: 20 ranges on a 280 KB line
  add about 90 ms per frame, 200 add about 500 ms, and the shadow observer repaints as the
  library renders, so the freeze repeats.
- WebKit also misdraws a highlight on a text run of about 10,240 characters or more (here
  @pierre/diffs renders the line as one text node): the run fills with the highlight and its
  text is gone. It is a character limit, not a pixel one (the same at 13 px and 26 px). Even
  the current match alone blanked the d3 line.
- Below that, 200 or 250 ranges on a 10,000-character line cost nothing measurable.

Fix: `lib/fileFind.ts` `paintedMatches(lineLength, count, current)`, used by both painters.
A line over `LONG_LINE` (5,000 characters, half the misdraw limit) paints no matches; a
shorter one paints at most `MAX_LINE_PAINTS` (200), the ones nearest the current match. On a
very long line the Text mode's row keeps its own highlighted snippet, and the find bar keeps
its count and stepping; only the paint is gone. Vitest pins the bounds. No e2e test: the
bound is what keeps the frame fast, and a timing assertion would flake. In WebKit on the dev
daemon (selecting the row, arrowing off and back on, Enter, stepping in the find bar) each
step now takes the CLI round trip (about 1.2 s, the same as a no-op), and the line's text
shows.

## 2. An include of more than 20,000 ignored files was searched in part, silently

With `node_modules/` included (20,500 files), cmd+P `react-dom-profiling` said "No matching
files." and Text mode said "No matches" for a file past the 20,000th.

Cause: `fsx.IncludedIgnored` reports `truncated`, but the file index only logged it.

Fix (the cap stays): the listing keeps `includeCapped` in its cache entry;
`FileIndex.SearchSources` and `Files` return it, and `SearchFilesResponse.included_capped` and
`SearchTextSummary.included_capped` carry it. The Text mode adds "searched the first 20,000
included files" to its footer notes, after "stopped at 2,000 lines". The Files mode's footer
has no status line, and the palette there is too narrow for the note beside the keys (it cut
to "Searched th…"), so the note is its own quiet line at the top of that footer. The mock
lists at most a cap of included files and says when it cut them; `POST
/__mock/ignored/cap?files=N` lowers the cap so its few files can reach it.

The flag does not cover git's own `MaxGitFiles` cut or the walk's `MaxWalkEntries`: those
were not part of the finding.
