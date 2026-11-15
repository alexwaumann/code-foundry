# File previews 6: logs and terminal output (2026-11-14)

PR 6 of the file-format previews series. A `.log` file and a plain-text file with escape
sequences in it get a Rendered | Source switch. Frontend only; it builds on the registry
(file-previews-1-registry.md) and the tail read (file-previews-2-daemon.md).

## Files

| Path | What |
| --- | --- |
| `previews/ansi.ts` | SGR styles, one line as a terminal leaves it (`ansiLine`), `stripAnsi`, `styleCss` |
| `previews/logLine.ts` | levels, leading timestamps, trailing `key=value` fields, a row's layout (`viewLine`) |
| `previews/logDoc.ts` | a read parsed once (`parseLog`, `docOf`), rows laid out when drawn (`rowOf`), the filter, `sameLine` |
| `previews/LogBody.tsx`, `log.css` | the view: level filter, virtualized rows, scroll place |
| `previews/kinds/log.ts`, `kinds/ansi.ts` | the two kinds |
| `previews/types.ts` | `read?: PreviewRead` ("whole" or "tail") |
| `files/FileTab.tsx` | `READS` (a read per `PreviewRead`), the tail notice, Copy contents off for a tail read |
| `files/fileKind.ts` | `tailNotice` |
| `mock/logs.ts`, `mock/files.ts` | `logs/daemon.log` (slog text with a trace), `logs/test-run.txt` (a test run's terminal output) |
| `e2e/file-previews-logs.spec.ts` | scroll place across re-reads; SHOTS-gated screenshots |

## Decisions

- **Two kinds, one view.** `log` matches `.log` by extension, reads the tail, and looks for
  timestamps, levels and fields. `ansi` matches by a sniff (`text.includes("\u001b[")`, one
  scan) and only in a file the highlighter calls plain text (`shows`: `.txt`, `.out`, no
  extension), so a shell script or source file with a raw escape in it stays code. It is read
  whole and nothing in it is reinterpreted: a `.txt` with "ERROR" in it never gets a level.
  Separate ids also keep their remembered modes apart. A `.txt` without an escape matches no
  kind and goes through exactly the code path it did before; the only added work is the scan.
- **The tail read is a registry value.** `read: "tail"` on the log kind; FileTab's
  `READS = { whole: readFile, tail: readFileTail }` picks the call by `previewKindOf(path,
  null)` for every read of the tab. The registry note says how a later read plugs in.
- **The tail notice** ("Showing the last 1 MiB of 38.0 MB") shows for any read with
  `truncatedStart`, in Rendered and Source. A daemon older than the option answers the head
  with `truncated`, which keeps the old "first 1 MiB" notice.
- **No Copy contents on a tail read**, as on a head-cut read: the button says it copies the
  file, and it would hand over the last MiB of a 38 MB file without saying so. A small log
  (whole read) has it. In Rendered it copies the text with escape sequences gone and
  overwrites collapsed (what the view shows: pasted into a thread or an editor, raw escapes
  are noise); Source copies the text as written. The level filter does not narrow it: it is
  the file's contents, not the rows on screen.
- **Source of a tail read is numbered from the cut** (line 1 is the first line read). The
  daemon gives no first-line number (counting means reading everything before the window),
  and hiding the numbers would need a CodeFile option for one case; the notice above says
  where the text starts. CodeBody is unchanged.
- **Meta** `11260 lines · 38.0 MB · Log`: the lines are counted in what was read, the size is
  the whole file's (the notice covers the gap). Terminal output says `Terminal output`.
- **Levels** (logLine.ts `detectLevel`): `level=`/`lvl=`/`severity=` (logfmt, slog text, with
  slog's `WARN+2`), a JSON line's `level`/`lvl`/`severity`/`levelname` as a word or pino's and
  bunyan's numbers, `[warn]` in brackets (any case) in the first 80 characters after a
  timestamp, or a bare upper-case TRACE/DEBUG/INFO/WARN/WARNING/ERROR/FATAL (and TRC, DBG,
  INF, WRN, ERR, FTL, NOTICE, CRITICAL, PANIC) as one of the first four words. Lower-case
  bare words are prose ("error handling improved"). Escapes are gone before detection, so a
  coloured `WARN` counts.
- **Continuations.** A line that says no level takes the entry's above unless it starts an
  entry itself (a leading timestamp, a logfmt `time=`, a JSON object) and is not indented. An
  entry with a time and no level ends the one above (level none).
- **The filter** is a segmented radio group (the mode switch's component): All, then Info,
  Warn, Error, Debug, Trace, each only when it has lines. Error takes FATAL too. A chip's count
  is the rows it shows (a trace's lines count with their entry), so All is the line count and
  the levels sum to it when every line has one. The choice lives in the view: a re-read keeps
  it (falling back to All when its level went), switching to Source and back resets it.
- **A row**: a time column (the short time, its width the widest in the read), a level column
  (5 characters, only where the line said its level), then the message and the fields. A
  leading level word moves into the column only when it is the level found; one further in
  stays in the text. A JSON or logfmt line is rebuilt as message then `k=v` (time, level and
  message keys taken out; nested values as compact JSON). Trailing `key=value` words are the
  fields: key dimmed, value secondary. Warn rows are tinted `--cf-warning-surface`, error and
  fatal `--cf-error-surface`, continuations included.
- **Timestamps**: an ISO 8601 date-time (T or space, any fraction, a zone), Go's `2026/11/14
  09:14:02`, syslog's `Nov 14 09:14:02`, or a bare `HH:MM:SS(.mmm)`, maybe in brackets, at the
  line's start; JSON and logfmt time keys, epoch seconds or milliseconds included. Shown as
  `HH:MM:SS.mmm` as written (no time zone conversion); the full value is a tooltip (hidden
  information) only when it was shortened.
- **ANSI.** SGR: the 16 colours and bright ones as `var(--terminal-ansi-N)` (the terminal
  view's palette, src/terminal/theme.ts, so they follow the theme), 256 colours (cube and
  greys computed), true colour (`;` and `:` forms), bold, dim (opacity .6), italic,
  underline, inverse (default colours swap to text on surface), strike, and their resets. The
  pen carries across lines until a reset. CR, backspace, erase in line (K) and cursor column
  moves (G, C, D) are played on a row of cells, so a progress bar collapses to its last state;
  a shorter overwrite keeps the old tail, as a terminal would. Every other CSI, OSC (titles,
  OSC 8 links: the text stays, the link goes), DCS, APC, charset and two-byte escapes are
  dropped. An escape cut short at a line's end is dropped with its bytes; the byte that broke
  a CSI is text again. NUL and other C0 controls show as Unicode control pictures (␀); BEL
  shows nothing. A trailing CR (CRLF) is ignored.
- **Parsed once per read.** `docOf` keeps the parse in a WeakMap keyed by the read (the
  kind's meta, its copy and the body share it): line starts (`Uint32Array`), each line's
  level and whether it said it (`Uint8Array`), the pen each line starts with (only when the
  text has escapes), counts, the time column's width and the widest line. A row's layout
  (`rowOf`: the ANSI runs and `viewLine`) is made when the row is first drawn and kept (up to
  4000 per read). Nothing parses per render.
- **Virtualized** with TanStack Virtual: fixed 20 px rows unwrapped (the sizer as wide as the
  widest line in `ch`, so long lines scroll sideways), measured rows wrapped (the wrap toggle,
  `kind.wrap`).
- **Scroll place.** The view opens at the bottom. It notes, on each scroll, whether it is at
  the bottom, else the line on top and how far into it. After a re-read (Refresh, a file
  change), a filter change or the wrap toggle: at the bottom it stays there (and a
  ResizeObserver keeps it there while wrapped rows are measured); otherwise the noted line
  comes back on top. Across reads the line is found by its byte position in the file (the
  read's `offset` plus the UTF-8 bytes before it, `sameLine`), so a tail read that moved on as
  the file grew still lands on the same line; a line no longer read gives the first.
- **No find in Rendered** (`find` unset): rows are virtualized, so a DOM find sees only what
  is drawn. Source has the find as before.

## Timings (drive browser, WebKit, mock daemon)

1 MiB each, generated in the page and written through WriteFile. Parse is the median of 50
runs of `parseLog` in the page; first paint is from `openFileInPanel` to the frame after the
first row (or the code view's first line) is in the DOM, including the read over Connect.

| File | Lines | Parse | First paint |
| --- | --- | --- | --- |
| plain `.txt` (prose, an ERROR in every line) | 13,481 | sniff only: 0.02–0.04 ms | 113–122 ms (the code view, unchanged) |
| structured `.log` (slog text with traces) | 10,498 | 2.9–3.5 ms | 149–178 ms |
| ANSI `.txt` (a test run, 256 colours) | 13,901 | 12.1–12.8 ms | 123–184 ms |

The first run after Vite started was slower (178 / 217 / 427 ms) while modules compiled.

## Checked end to end

`make drive`: `logs/daemon.log` (chips, Error filter keeps the trace, wrap on and off,
tooltip on a time), `logs/test-run.txt` (colours in dark and light, the progress bar
collapsed), a 38 MB log from `POST /__mock/fs/log` (notice, opens on "the end", Source
numbered from the cut, no Copy contents), an empty `.log`, a `.txt` without escapes (code
view, no switch). The e2e spec checks the bottom across a growing file and the kept line when
scrolled up.

## Gotchas

- jsdom normalizes `max(100%, calc(…))` to `max(100%, … )` in a style: match either.
- `performance.now()` in WebKit is coarse (about 1 ms here); time a sub-millisecond scan as
  many runs divided.
- The mock's generated log (`mockLog`) makes the same line i for any size, so writing a bigger
  one is the file growing: what the scroll-place test relies on.
