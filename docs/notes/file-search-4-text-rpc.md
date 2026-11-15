# File search 4: the text search RPC

Status: PR 4 of 5 for file search. Daemon, proto and mock only; PR 5 builds the finder's Text
mode (results grouped by file on the left, a preview around the selected match on the right,
Enter opens the file at the line).

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/filesystem.proto` | `SearchText` (server stream), `SearchTextRequest`, `SearchTextResponse`, `TextFileMatch`, `TextLineMatch`, `TextRange`, `SearchTextSummary` |
| `internal/textsearch` | `Searcher.Search`, `Query` (smart case), `Limits`, the chunked ripgrep runs and their JSON, cut lines and code-point ranges |
| `internal/fsx/files.go` | `FileIndex.Files`: each source's files from the same cache SearchFiles ranks, sorted by path |
| `internal/ripgrep` | `Engine`: finds and checks ripgrep once per daemon; `ripgreptest.Real` for tests |
| `internal/api/filesystem_text.go` | the thin handler; `searchSources` (shared with SearchFiles) resolves and dedupes |
| `internal/daemon` | one `ripgrep.Engine` in the stores; the startup check warms it, the API uses it |
| `gui/frontend/mock/textSearch.ts` (+ server, filesystem) | the RPC over the mock's files; `POST /__mock/text`, `POST /__mock/text/delay` |
| `Makefile` | `go-test` depends on `ripgrep` and sets `CODE_FOUNDRY_RG_BIN` to the pinned binary |

## For PR 5 (the GUI)

* `FilesystemService.SearchText(SearchTextRequest{sources, query, match_case, whole_word,
  regex})` streams `SearchTextResponse`: messages with `files` (in order, continuing the
  previous message's; a file is never split across messages), then one last message with
  `summary` alone. A newer query cancels the old stream (abort the request); the daemon kills
  its ripgreps at once.
* `TextFileMatch{project_id, checkout, path, ignored, lines, line_count, line_count_capped}`.
  `checkout` is the source's path as sent (as `FileMatch.checkout`): open
  `checkout + "/" + path`. "N in this file" is `line_count` (shown as "999+" when
  `line_count_capped`), which counts beyond the 50 lines sent.
* `TextLineMatch{line (1-based), text, ranges, cut_start, cut_end}`. Ranges are
  `TextRange{start, end}` in code points (`Array.from(text)` indices), end exclusive, every
  match in the line; a regex can give an empty range (`start == end`). `cut_start` /
  `cut_end`: show an ellipsis before / after `text`; the ranges refer to the cut text.
* `SearchTextSummary{lines, files, truncated, file_capped, total_capped, timed_out,
  case_sensitive, elapsed_ms}`. `case_sensitive` is what smart case decided (show it beside
  the match-case toggle, like thread search). `truncated` is any of the three.
* Errors: InvalidArgument for an invalid regex ("invalid regular expression: unclosed
  group"), a query over 500 characters, more than one line or with a NUL, no sources, more
  than 16, a bad path; NotFound for an unknown project; FailedPrecondition when ripgrep is
  missing or broken (`ripgrep.ErrMissing`'s sentence: "text search is unavailable: ... update
  or reinstall Code Foundry to restore it"). The message reads as is after
  "invalid argument: ".
* An empty query returns the summary alone, without running ripgrep.

## Matching

* Literal text by default (`--fixed-strings`); spaces are text (`func Home` is a phrase, two
  spaces are two spaces). The query is handed to ripgrep as one argument,
  `--regexp=<query>`, and the paths after `--`, so a query or path starting with `-` is never
  read as a flag (`-v`, `--regexp=x` are tested as text).
* Smart case, decided by the daemon (not ripgrep's `--smart-case`) so the response can say
  it: `match_case`, or an upper-case letter (Unicode `IsUpper`) in the query, matches case;
  otherwise `--ignore-case`. In a regex a letter after a backslash is not text (`\W`, `\S`,
  `\p{Lu}`, `\x{41}`), as in ripgrep's own smart case; a literal query's `\W` is text.
* `whole_word` is `--word-regexp`; `regex` drops `--fixed-strings` (ripgrep's Rust syntax).
  No fuzzy matching.
* An invalid regex is found before any file is searched: ripgrep compiles it over
  `/dev/null` while the checkouts are listed. Its stderr's last `error: ...` line becomes the
  message. A pattern ending in a lone backslash reads "unclosed group" from ripgrep (it wraps
  the pattern in a group the backslash escapes), so that case says what it is.
* A query is one line, at most 500 code points, no NUL, valid UTF-8 (protobuf strings are
  anyway).

## The file set: ripgrep over file search's own list

Text search covers exactly the files `SearchFiles` lists for the same sources, by
construction: `FileIndex.Files` hands it the same cached candidate list (git's view plus
the included ignored files, or the walk), files only, and ripgrep gets their paths as
arguments. `--max-depth 0` keeps ripgrep to those paths (a listed symlink to a folder is not
walked; a symlink to a file is searched, its target's contents). Paths that are not valid
UTF-8 are left out (a protobuf string cannot carry them).

Measured against letting ripgrep walk with its own rules (`--hidden -g '!.git'`), M3 Pro,
best of 5, full run, a word with no match:

| Repo | Files | ripgrep walks | explicit paths, chunks of 2,000 / 8,000 |
|---|---|---|---|
| code-foundry (main clone) | 5,088 | 53 ms | 75-92 ms |
| a large scratch repo (128,267 files, a Go module cache tree) | 128,267 | 2.0-2.6 s | 4.1-5.0 s |

Walking is up to twice as fast on a huge repo. It was not chosen because its set is not file
search's: it applies `.ignore`, `.rgignore` and its own reading of global excludes, skips the
included ignored files (`.env.local` under the default patterns), and searches binary files
differently. On code-foundry the two file lists happen to be equal today, but nothing keeps
them so; with the explicit list the rule holds whatever the repo has, and
`TestSearchFileSet` pins it (an `.ignore` and an `.rgignore` that name tracked files, a hidden
folder, an included `.env.local` flagged, `node_modules` and `build/` out, a project without
git walked like file search walks it). The cost is in the long full scans of very large
repos, which the timeout bounds; on the large repo the first results still come in about
20 ms, and a common word reaches the line cap long before a full scan.

## Order, chunks and fast first results

Order is sources in the order sent (the GUI sends the primary project first), then a
source's files by path (byte order). Git lists untracked files before tracked ones, so the
candidate list is sorted once per cached listing (`sortedFiles`, built on the first text
search of the entry).

The files are cut into chunks: 128 files first (fast first results), then each chunk 4 times
larger, up to 8,192 files or 256 KiB of paths (the argument list's limit is 1 MiB with the
environment). Two ripgreps run at once: the next chunk is searched while the last one's
results are sent. Each chunk's results are collected whole and put in order before they are
sent, so ripgrep's parallel output order never shows. Chosen over collecting everything then
ordering (no fast first results) and over `--sort path` (single-threaded).

ripgrep writes each file's messages together (begin, matches, end); the parser still keys
its state by path. A file's `end` message carries ripgrep's own count (`matched_lines`) and,
for a file with a NUL, `binary_offset`: such a file is dropped whole. ripgrep searches a
binary file named on its command line in "binary" mode (it does not stop at the NUL as it
does for files it walks), so dropping on `binary_offset` is what keeps binaries out.

## Bounds (textsearch.DefaultLimits)

| Bound | Value | What happens |
|---|---|---|
| lines sent per file | 50 | the rest are counted, not sent (`file_capped`); a match message past 50 is skipped by its prefix without decoding |
| lines counted per file | 999 | `--max-count 1000`: one more than counted, so `line_count_capped` is exact |
| lines per search | 2,000 | the stream stops (`total_capped`), the file there is cut; unsearched chunks are not started, a running one is killed |
| characters per line | 300 code points | cut around the first match, up to 40 (a third of the window at most) before it; `cut_start`, `cut_end` |
| query | 500 code points, one line | InvalidArgument |
| time | 15 s | the search ends with what it found (`timed_out`), not an error |
| sources | 16 | as SearchFiles |
| JSON message | 32 MiB | a longer one (a minified line) is dropped; the file's count still holds it |

A chunk keeps at most 2,000 lines in memory: once its kept files hold that many, the files
latest in order are dropped as others arrive (they could never be sent).

## ripgrep's arguments and process

`--json --no-config --max-depth 0 --max-count 1000 (--case-sensitive|--ignore-case)
[--fixed-strings] [--word-regexp] --regexp=<query> -- <paths>`, run in the checkout with
`RIPGREP_CONFIG_PATH=` cleared (as `Binary.Check`) and stdin from `/dev/null`.
`exec.CommandContext` kills it when the request ends (the client cancels, a newer query, the
search's own deadline or cap, or the daemon's shutdown, which cancels every request context
before closing the listeners); `Search` waits for every ripgrep before it returns, so none is
left behind. Exit 1 is no match; exit 2 is a file that went away since it was listed, and the
search goes on.

ripgrep is found and checked once per daemon (`ripgrep.Engine`): the startup check is the
first `Get`, and every search after it reuses the outcome. The check is not bound to the
first caller's context (a cancelled keystroke must not mark ripgrep broken for good). A
missing or broken ripgrep stays so until the daemon restarts, which an update does.

## Lines and ranges

ripgrep reports byte offsets into the line; the daemon sends code points. A line that is not
UTF-8 comes from ripgrep as `{"bytes": base64}`; each byte that does not start a valid rune
becomes one U+FFFD, so offsets map one to one. The line break (`\n` or `\r\n`) is dropped.
ripgrep transcodes UTF-16 files with a BOM; their offsets are into the transcoded UTF-8, which
is what the daemon converts.

## Timings

M3 Pro, the scratch daemon over Connect (a Python client on the unix socket), this repo's main
clone (5,088 files), candidate list cached, four runs each (the machine was busy with other
worktrees' checks, hence the spread):

| Query | First result | Stream end | Summary |
|---|---|---|---|
| `the` | 64-138 ms | 64-153 ms | 2,000 lines in 80 files, total and file capped (the first chunk fills the cap) |
| `func` | 18-67 ms | 181-245 ms | 2,000 lines in 165 files, capped |
| `Search` (case-sensitive) | 18-76 ms | 143-233 ms | 2,000 lines in 253 files, capped |
| `zqxjvk` (no match, full scan) | - | 157-404 ms | 0 |

The first listing of a checkout adds 40-105 ms (git ls-files plus the ignored listing).
Counting each file's lines to 999 costs a common word's first result about a factor of two
over counting to 50 (ripgrep then prints up to 1,000 JSON lines per file; 33-45 ms vs
60-90 ms for `the` in a Go loop), and nothing for a rare one; kept for the "N in this file"
count. On the large scratch repo (128,267 files): first result 16-20 ms with the list cached,
`the` hits the cap after 1.8-2.9 s, a full scan with no match 4.2-5.7 s; its first listing took
0.5-3.9 s.

## Mock

`gui/frontend/mock/textSearch.ts` implements the RPC over the mock's files: the same file set
as its SearchFiles (`sourceEntries`: a project's files plus the ignored files its patterns
include, flagged), the same smart case (escapes skipped in a regex), caps, cut lines,
code-point ranges, order (sources as sent, paths in UTF-8 byte order), binary skip (a NUL)
and summary. One message per source with matches, then the summary. Contents: `POST
/__mock/text?project=…&path=…&text=…` (repeat `path=`/`text=`), else the mock disk
(`mock/files.ts`, so code-foundry's README.md is its fixture), else `DEFAULT_TEXT` for the
default files and the default ignored `.env` files, else one line naming the file. `POST
/__mock/text/delay?ms=N` delays each message, for a spec that wants to see a slow or
cancelled search. `GET /__mock/files/calls` records `text <project,…> <query>`.

Where it differs, on purpose: a regex is a JavaScript `RegExp` (flag `u`), so syntax only one
of Rust and JavaScript has differs, and an invalid one's message is JavaScript's after
"invalid regular expression: " (the lone trailing backslash has the daemon's message); whole
word is a lookaround on `[\p{L}\p{N}_]`, close to ripgrep's Unicode `\w`; there is no timeout
(use the delay); `total_capped` is set only when a match was left unsent, where the daemon
also sets it when the cap is reached exactly with chunks left. `mock/textSearch.test.ts` pins
the shared rules.

## Gotchas

* ripgrep with no path argument searches stdin when stdin is not a terminal, and a
  measurement script under a harness hung on it. The daemon always passes paths (and
  `/dev/null` for the regex check), and `exec.Cmd` gives `/dev/null` as stdin.
* A `CODE_FOUNDRY_HOME` for a scratch daemon must stay short (socket path limit).
* The scratch daemon's children include the project store's own git and helper processes;
  check ripgrep by its command name (`code-foundry-rg`), not "any child".
* The tests that need ripgrep call `ripgreptest.Real`, which fails (never skips) without
  one: `make go-test` (and so `make check` and CI, whose setup action runs `make ripgrep`)
  sets `CODE_FOUNDRY_RG_BIN` to the pinned binary; a plain `go test` finds it through
  `scripts/ripgrep.sh --print-bin` once `make ripgrep` has fetched it.

## Tests

* Go `internal/textsearch`: `TestCaseSensitive`, `TestQueryCheck`, `TestRegexError`,
  `TestMakeLine` (code points, U+FFFD bytes, CRLF, empty match, cuts at start, middle, end,
  a clipped match, non-ASCII windows), `TestPlan`, and against the real ripgrep:
  `TestSearchMatching` (smart case both ways, match case, whole word, phrases, `.*[`, `-v`,
  `--regexp=x`, regex, non-ASCII ranges, empty query), `TestSearchInvalidRegex`,
  `TestSearchFileSet`, `TestSearchSourcesInOrder`, `TestSearchStableOrder` (1,500 files over
  three chunks, three runs, same order), `TestSearchLimits` (per file, count at and over its
  cap, total, line length), `TestSearchNonUTF8AndBinary`, `TestSearchCancelKillsRipgrep` (the
  process is gone when Search returns), `TestSearchTimeout`, `TestSearchMissingRipgrep`
  (looked for once; broken too). `internal/fsx`: `TestFileIndexFiles`. `internal/api`:
  `TestSearchText` (two sources over Connect, order, ignored flag, checkout, ranges, summary
  last and alone, the error codes), `TestSearchTextMissingRipgrep`.
* Vitest: `mock/textSearch.test.ts`.

## Verified end to end

`make build`, a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/cfts`, `daemon --dev`), a scratch git
repo under home with an ignored `.env.local` and `node_modules`, registered with `project
add`, `SearchText` over Connect on the unix socket: `needle` found `.env.local` flagged
`ignored` and `src/app.ts`, nothing from `node_modules`; `Needle` matched case
(`caseSensitive: true`), `home` both `Home` and `home`; `ne+dle` as a regex matched;
`(needle` as a regex was `invalid_argument` "invalid regular expression: unclosed group".
A full scan of the large repo, its client closed after 1.5 s: two `code-foundry-rg` children
while it ran, none 200 ms after the close. The daemon stopped (SIGTERM to its pid) during a
search: no `code-foundry-rg` left anywhere. The startup log named the bundled ripgrep once.
Scratch repos and home deleted.
