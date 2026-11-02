# File finder 1: SearchFiles over several checkouts

Status: PR 1 of 2 for the cmd+P file finder, on branch `cf/file-finder-1-search`. Daemon,
proto and mock only; PR 2 builds the dialog. The finder searches a thread's checkouts (one
per project, several for a workspace thread) and shows one flat list, best match first
whatever the project, each row labelled with its project.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/filesystem.proto` | `FileSource`; `SearchFilesRequest.sources`, `files_only`; `FileMatch.project_id`, `checkout`, `path_positions`, `project_positions`; the ranking and project-word rule in the RPC comment |
| `internal/fuzzy/fuzzy.go` | `Positions`, `Splits`, `RankSources` (replaces `Rank`); the matcher works on runes for non-ASCII text |
| `internal/fsx/files.go` | `Source`, `Match`, `FileIndex.SearchSources` (lists the checkouts concurrently, one ranked list, files only); `Search` is its one-checkout form; `MaxSearchSources` = 16 |
| `internal/api/filesystem.go` | `SearchFiles` takes `sources` or the old `project_id`/`path`, removes duplicate checkouts, fills the new match fields; `resolve` returns the project and the named path too |
| `gui/frontend/mock/filesystem.ts`, `mock/server.ts` | the same request, rule, ranking (bonus included) and positions; `POST /__mock/files` sets several projects in one call |

## The request

* `sources` (in order, path empty = the main worktree, the same checks as before) or the old
  `project_id`/`path`. Both at once is InvalidArgument, so a caller can't half-migrate by
  accident. The composer's `@` completion still sends `project_id`/`path` and is unchanged.
* Every source must resolve: an unknown project is NotFound and a path outside home
  InvalidArgument, for any source. ListSkills skips a gone source instead; the finder asks
  for the thread's current checkouts, so a failure here is a real error worth showing.
* A checkout named twice (same resolved directory, say through a symlink) is searched once,
  under the first source's name.
* `files_only` drops directories before ranking, so they take no result slots. The cache
  keeps the files-only path list next to the full one (built once per listing).
* The limit (default 50, max 200) counts across all sources. At most 16 sources, below the
  32-entry candidate cache, so one search can't evict its own lists.

## Ranking

One list across sources with internal/fuzzy's existing order: exact base name > base-name
prefix > base-name subsequence > path subsequence, then the boundary and run bonus, then
the shorter path, then the path, then the earlier source (the GUI sends the primary
project first). An empty query ranks by depth, then path, then source.

## The project-word rule

Only with more than one source. Split the query into words at whitespace. A run of words
at the **start or end** of the query that leaves **at least one** word for the path may go
to the source's project name instead: the run's words, in order and with their spaces
dropped, must be a case-insensitive subsequence of the name. The rest, joined by single
spaces, matches the path exactly as a one-source query would. A file's score is its best
path score over these splits (the whole query on the path, then each run that fits the
name). On equal scores the split that leaves more of the query on the path wins, so a
match that didn't need the name never shows bold name letters.

* `tree`: one word, never touches the name. Exactly as before.
* `ghostty tree`: in ghostty-playground the path is matched against `tree`, so its tree
  files rank as if `tree` had been typed there; in code-foundry `ghostty` isn't in the name,
  so the whole `ghostty tree` must match the path (it almost never does).
* `tree gp`, `readme ghostty`: the run can trail. `code foundry readme`: a run of two words
  (`codefoundry` is a subsequence of `code-foundry`).
* A word in the middle (`readme foundry tree`) is never a project word. Leading and trailing
  runs cover how people type a qualifier, and keep the splits at most 2n-1 for n words, so
  a pathological query costs a few passes over the candidates, not 2^n.
* With one source the query is matched as typed, spaces included, exactly as before.

Rejected: a greedy "any word that fits the name goes to the name" (a short path word like
`src` fits `resources`, and then disappears from the path query); any subset of words
(exponential, and harder to explain); joining path words without spaces (`ghostty tree`
would then match `ghostty-tree.md` in every project, and multi-source would disagree with
one-source on the same query); ranking project-word matches in a tier of their own (the
path score already lifts them: dropping the project word makes the path query shorter).

## Positions

`path_positions` and `project_positions` are code-point indices (Go runes, JavaScript
`Array.from(s)` indices), ascending. Not bytes (the GUI would have to re-encode) and not
UTF-16 units (Go would). They are the alignment the daemon scored, not a re-match in the
GUI: the base name's leading characters for an exact or prefix match, else the alignment
with the best boundary/run bonus (ties: the nearest earlier character). The project's
positions are the same alignment over the name of the words it took; empty when the whole
query matched the path.

## Gotchas

* The matcher was byte-based. A non-ASCII query could match bytes of two different runes
  (`é` is C3 A9, `Ã©` is C3 83 C2 A9), and positions in bytes would be wrong for the GUI.
  ASCII still runs byte by byte (no rune slice); anything else runs over runes. The byte
  subsequence prefilter stays: a rune subsequence is always a byte subsequence.
* `strings.ToLower` maps rune to rune, so rune indices of the lowered string are those of
  the original. The mock lowers each code point on its own for the same reason
  (`"İ".toLowerCase()` is two code points in JavaScript).
* `Positions` keeps the whole len(path)·len(query) table to walk back; `Score` still keeps
  two rows. Positions only run for the returned matches (at most 200).
  `TestPositionsMatchScore` checks that the positions add up to Score's bonus.
* The mock used to rank by tier and length only; it now uses the same bonus as the daemon
  (it computes the alignment anyway for positions). The composer e2e specs still pass.
* `checkout` is the source's path as named (cleaned), not the resolved directory, so the
  GUI can key a match by the checkout path it sent.

## Verified

* `make check` green.
* A scratch daemon (`CODE_FOUNDRY_HOME=/tmp/...`, `make build`) with two scratch git repos
  under home, registered with `project.add`, `SearchFiles` called over Connect JSON with
  curl: the old fields (project id, checkout and positions filled), two sources for `tree`
  (one list, interleaved by score), `ghostty tree` (only ghostty-playground's tree files,
  project positions 0-6), `readme` (ties in the order of the sources sent), directories
  without `files_only`, and the refusals (both field sets InvalidArgument, a source outside
  home InvalidArgument, an unknown project NotFound). Scratch repos deleted afterwards.
* The mock against the Go tests' cases (same order and positions, through a throwaway
  script), and the e2e specs that use SearchFiles through it (`composer-files`,
  `composer-skills`, `no-project`, `file-tabs`).
