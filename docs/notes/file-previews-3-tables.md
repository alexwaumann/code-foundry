# File previews 3: tables and JSON (2026-11-14)

PR 3 of the file-format previews series. Three preview kinds on the registry of PR 1
(`file-previews-1-registry.md`), sharing a data grid and a JSON tree:

| Kind | Files | Switch | Meta |
| --- | --- | --- | --- |
| `csv` | `.csv`, `.tsv`; `text/csv`, `text/tab-separated-values` | Table / Source | `26 rows · 7 columns · 1 KB · CSV` |
| `json` | `.json`, `.jsonc`; `application/json` | Tree / Source | `9 keys · 1 KB · JSON` (an array root: `120 items`) |
| `jsonl` | `.jsonl`, `.ndjson`; `application/jsonl` | Records / Source | `24 records · 1 invalid line · 7 fields · 4 KB · JSON Lines` |

## Files

| Path | What |
| --- | --- |
| `previews/kinds/{csv,json,jsonl}.ts` | the kinds |
| `previews/{Csv,Json,Jsonl}Body.tsx` | their bodies |
| `previews/data/csv.ts` | the CSV parser (pure, table tested) and the delimiter |
| `previews/data/json.ts` | the JSON parser (pure, table tested), JSONC rule, summary, error excerpt |
| `previews/data/{csvTable,jsonlTable,table}.ts` | the grid's models: columns, numeric detection, sort, tab-separated copy |
| `previews/data/treeRows.ts` | the JSON tree's visible rows, flattened, and what opens first |
| `previews/data/memo.ts` | a parse per file contents (see Decisions) |
| `previews/data/gridSort.ts` | the sort by path, in memory |
| `previews/data/DataGrid.tsx`, `JsonTree.tsx`, `data.css` | the two shared components |
| `mock/tables.ts` | the fixtures (one line in `mock/files.ts` `fixtures()`) |
| `e2e/file-previews-tables.spec.ts` | virtualization and sticky geometry, and SHOTS screenshots |

Shared files touched: `mock/files.ts` (an import and one fixtures line), `registry.test.ts`
(rows), `FileTab.test.tsx` (one `it` in `describe("previews")`). FileTab.tsx, types.ts and
registry.ts are unchanged: the registry had everything these kinds need.

## Decisions

- **No dependency for CSV.** The parser is ~100 lines: RFC 4180 quoting (`""`, delimiters and
  line breaks inside quotes), LF/CRLF/lone CR, a BOM, a trailing line break, blank lines
  skipped (as most readers do), a quote inside an unquoted field kept as text. Ragged rows:
  short rows pad with empty cells, long rows widen the table with unnamed columns shown as a
  dim `column 5`. The delimiter is by extension (tab for `.tsv`); a `.csv` whose first line
  has more `;` or tabs than commas uses those.
- **Our own JSON parser, not JSON.parse.** WebKit's JSON.parse gives no error position, moves
  integer-like keys to the front of an object, and loses number text (`1.0` → `1`, a 64-bit id
  rounded). The parser keeps key order (a repeated key shows twice in the tree; a JSON Lines
  cell takes the last, as JSON.parse would), keeps each number's text, and reports a message
  with line and column. A 1 MiB document parses in ~6 ms in the drive's WebKit (JSON.parse
  ~3 ms). Too-deep nesting is a parse error, not a crash.
- **`.jsonc` is JSON with comments.** The daemon reports `.jsonc` as `application/json`, so it
  gets the tree; the parser allows `//`, `/* */` and trailing commas for `.jsonc` and the
  files every editor reads as JSONC (`tsconfig*.json`, `jsconfig*.json`, `.vscode/*.json`,
  `devcontainer.json`), so a commented tsconfig is a tree, not an error. Any other `.json` is
  strict, and a comment there is an error that says so.
- **Parsed once per contents.** The File tab reads again on every worktree change, and each
  read is a new `FileReadView`. `memoByText` keeps the last 8 files' parses by path and
  returns the same parse when the text (and the cut) is the same, so the body, the meta and
  the copy share one parse, and the tree's open nodes (a set of parsed nodes) survive a
  re-read that changed nothing. A changed file opens its tree afresh; JSON Lines rows stay
  open by line number.
- **Truncated reads.** CSV drops the last record unless the cut fell on a record's end (or it
  is inside an open quote); JSON Lines drops the last line unless the text ends with a line
  break. JSON cannot parse cut short: the kind's `shows` refuses a truncated read, so it
  falls through to the code view under the truncated notice, with no switch.
- **Sort.** Ascending, descending, file order; a numeric column (every non-empty value a
  number: `42`, `-3.5`, `1e6`, `1,280.00`) sorts by value, text sorts naturally without case
  (`Intl.Collator` numeric); empty cells (and in JSON Lines missing keys, nulls, lines that
  are not objects) go last both ways; ties keep file order. The sort lives in a small store by
  path, in memory only, so Copy contents (the kind's `copy`, which sees no body) copies the
  order shown. It is never written anywhere.
- **Copy contents.** Table and Records copy tab-separated text with the header, a field quoted
  as spreadsheets read a paste when it holds a tab, a line break or a quote. In Records a
  nested value copies as its compact JSON rather than the `{2}` the grid shows (a count pastes
  as nothing useful), a line that is not an object as its text in the first column. Tree and
  Source copy the file's text (the registry's default).
- **The grid.** One scroll box (both axes), a sticky header row, a sticky row-number gutter
  (the record's number in the file for CSV; the line number for JSON Lines, so a row can be
  found in Source), rows virtualized with TanStack Virtual (`scrollMargin` for the header).
  Column widths in `ch` from the longest value (capped at 48), plus one: text exactly as wide
  as its box was cut by a sub-pixel in WebKit. Longer values end in an ellipsis; JSON Lines
  shows them whole in the opened tree.
- **JSON Lines rows.** Columns are the union of the objects' top-level keys in first-seen
  order. A line that is not JSON is a flagged row (error tint, a warning icon, its text);
  opened, it says the error and column. A line that is valid but not an object (an array, a
  string) is one cell across the row: `[3] [1,2,3]`, `"text"`. Click or Enter opens a row
  into its tree; the grid's keyboard moves a current row (Up/Down, Home/End, Page keys,
  Right/Left open and close); the tree inside keeps its own keys.
- **The tree.** The visible rows are flattened and virtualized, so a 10,000-item array costs
  a screenful. The Tree preview opens the root's children that are containers while the rows
  stay within 400 (deeper levels closed); an opened JSON Lines record opens as deep as 80
  rows allow, and is at most 20 rows tall before it scrolls inside. Keys `--syn-fn`, strings
  `--syn-str`, numbers `--syn-num`, `true`/`false`/`null` `--syn-kw`; a string longer than
  2,000 characters is cut in the row (Source has it).
- **Invalid JSON** shows "Not valid JSON", the message with line and column, the line with a
  caret under the spot, and Show source, which calls the registry's `onMode` (PR 4) with Source (so, like picking
  it there, JSON files open in Source until Tree is picked again).
- **Find** is not offered in Table, Tree or Records (the kinds do not set `find`); it works
  in Source as everywhere.

## Timings (drive's WebKit, mock daemon)

Five runs each, ms (WebKit's timer is coarse):

| | 1 MiB CSV (20,800 rows × 7) | 1 MiB JSON Lines (6,700 records × 7) |
| --- | --- | --- |
| parse | 6–7 | 9–11 |
| sort, text column | 17 | — |
| sort, numeric column | 4–5 | 1–2 |
| copy as TSV, sorted | 16–25 | — |
| open to first rows painted (read included) | 156 | 125 |

## Gotchas

- In jsdom, RTL's automatic cleanup does not run in this suite's setup for a file that only
  imports `render`: `DataPreviews.test.tsx` calls `cleanup()` in `afterEach`.
- `ch` is the width of `0` in the cell's font: keep the header and cells in the same font
  (the grid sets it once) or the widths disagree.
- A big highlighted JSON that falls back to the code view (over the cap) can open scrolled
  to its end. It does the same with the json kind removed, so it is the code view's, not
  this change's.
