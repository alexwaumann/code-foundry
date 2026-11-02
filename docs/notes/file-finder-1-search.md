# File finder 1: SearchFiles over several checkouts

Status: PR 1 of 2 for the cmd+P file finder, on branch `cf/file-finder-1-search`. Daemon,
proto and mock only; PR 2 builds the dialog. The finder searches a thread's checkouts (one
per project, several for a workspace thread) and shows one flat list, best match first
whatever the project, each row labelled with its project.

## What landed

| Path | What |
|---|---|
| `proto/codefoundry/v1/filesystem.proto` | `FileSource`; `SearchFilesRequest.sources`, `files_only`; `FileMatch.project_id`, `checkout`, `path_positions`, `project_positions`; the ranking and project-word rule in the RPC comment |
| `internal/fuzzy/fuzzy.go` | `Positions`, `Words`, `ScoreWords`, `PositionsWords`, `Splits`, `RankSources` (replaces `Rank`); the query matches word by word; the matcher works on runes for non-ASCII text |
| `internal/fsx/files.go` | `Source`, `Match`, `FileIndex.SearchSources` (lists the checkouts concurrently, one ranked list, files only); `Search` is its one-checkout form; `MaxSearchSources` = 16 |
| `internal/api/filesystem.go` | `SearchFiles` takes `sources` or the old `project_id`/`path`, removes duplicate checkouts, fills the new match fields; `resolve` returns the project and the named path too |
| `gui/frontend/mock/filesystem.ts`, `mock/server.ts` | the same request, words, rule, ranking (bonus included) and positions; `POST /__mock/files` sets several projects in one call |

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

## Words

The query is split into words at whitespace (`strings.Fields`), and every word must match
the path on its own: a case-insensitive subsequence, in any order, overlapping allowed, like
VS Code's quick open. `comp tsx` finds `gui/frontend/src/components/compose/Composer.tsx`;
`tsx comp` finds the same; `comp zzz` finds nothing. This holds with one source too: the
spaces used to be literal characters, so `comp tsx` matched nothing. The composer's `@`
completion never sends a space, so its one-word queries rank and position as before.

## Ranking

Each word gets internal/fuzzy's tier against the path (exact base name > base-name prefix >
base-name subsequence > path subsequence) and, within the subsequence tiers, the boundary
and run bonus. A path's words combine as:

1. the weakest word's tier: a path where every word lands in the base name beats any path
   where some word matches only across directories, even when that path has an exact base
   word (`comp tsx`: `x/y/Composer.tsx` above `src/components/tsx`);
2. the sum of the words' tiers (more exact and prefix words);
3. the sum of their bonuses;

then the shorter path, then the path, then the earlier source (the GUI sends the primary
project first). An empty query ranks by depth, then path, then source. With one word the
three parts are its tier, its tier and its bonus: exactly Score's order.

The three parts are packed into one int (`fuzzy.ScoreWords`: tier in bits 50-52, tier sum
capped at 1023 in 40-49, bonus sum capped at 2^40-1 below), under 2^53, so the mock's
JavaScript number holds it exactly and compares the same way.

Rejected: the sum of the word scores (an exact base word plus a directory-only word would
outrank two base-name subsequence words, against "base-name words beat directory words");
the weakest word's whole score alone (drops the other words, so a prefix word counts for
no more than a subsequence one); the count of base-name words first (with project words it
makes dropping a word to the name always worse, so `ghostty tree` would rank code-foundry's
`docs/ghostty-tree.md` above ghostty-playground's `src/tree.zig`).

## The project-word rule

Only with more than one source. A run of words at the **start or end** of the query that
leaves **at least one** word for the path may go to the source's project name instead, each
of the run's words on its own a case-insensitive subsequence of the name (in any order,
like the path words). The rest match the path word by word. A file's score is its best
over these splits (`fuzzy.Splits`: all words on the path, then runs of 1, 2, ... words,
leading before trailing), scored over the path words alone; on equal scores the earlier
split wins, the one with more words on the path.

Because only the path words count and the weakest one leads, a word goes to the name only
when that lifts the weakest path word: `src index` in a project named `src` drops `src` (a
directory-only match) and ranks `index` alone; `index ts` in a project named `index` keeps
both words on the path (moving `index`, a prefix word, would leave `ts` as weak as before
and lower the tier sum), so no name letters are bold.

* `tree`: one word, never touches the name. Exactly as before.
* `ghostty tree`: in ghostty-playground the path is matched against `tree`, so
  `src/tree.zig` ranks as a base prefix and comes first. In code-foundry `ghostty` isn't in
  the name, so both words must match the path: `docs/ghostty-tree.md` does now (it didn't
  when the path query was the literal `ghostty tree`) and comes second, both words in its
  base name, above ghostty-playground's `src/subtree/x.zig` (`tree` only in a directory).
* `tree gp`, `readme ghostty`: the run can trail. `code foundry readme` and `foundry code
  readme`: a run of two words, each in `code-foundry` (the old rule joined the run, in
  order, so the second needed the two words in the name's order).
* `gh zig tree`: `gh` on the name, `zig` and `tree` on the path in either order.
* A word in the middle (`readme foundry tree`) is never a project word: leading and
  trailing runs cover how people type a qualifier. A run stops at the first word not in the
  name (`code src foundry`: `code` may lead, `foundry` may trail, `src` stays).
* Every word in the name (`code foundry`) still needs one on the path, so it matches
  nothing in code-foundry rather than everything.
* Cost: each word is scored once per path (cached across splits, lazily, so a word that
  misses ends the one-source case at once; a repeated word, `tree tree`, shares its first
  copy's score); the at most 2n-1 splits only combine those scores.
* At most 8 words (`fuzzy.MaxWords`); more is InvalidArgument, from the daemon and the
  mock. The splits make the cost grow faster than the word count: 256 one-letter words
  took 17 s over three 50,000-path checkouts. `BenchmarkRankSources` (M3 Pro, three
  checkouts of 50,000 paths): `composer` 35 ms, `comp tsx` 34 ms, `src comp tsx` 48 ms,
  eight distinct one-letter words 165 ms, `s` eight times 100 ms. One checkout is about a
  third of that, and one word is as fast as before the word split.

Rejected: any word anywhere may go to the name (cheap now that words score independently,
but a short path word like `src` fits `resources` far more often than it means the
project, and the middle of a query is where people put path words); a greedy "any word that
fits the name goes to the name" (the word then disappears from the path even when it was a
strong path match); joining a run's words in the name's order (the path words are in any
order, so the name words being ordered was a second rule to learn).

## Positions

`path_positions` and `project_positions` are code-point indices (Go runes, JavaScript
`Array.from(s)` indices), ascending. Not bytes (the GUI would have to re-encode) and not
UTF-16 units (Go would). They are the alignment the daemon scored, not a re-match in the
GUI: the base name's leading characters for an exact or prefix match, else the alignment
with the best boundary/run bonus (ties: the nearest earlier character). With several words,
every path word's positions, merged (sorted, without repeats: overlapping words share
characters). The project's positions are each project word's alignment over the name,
merged the same way; empty when every word matched the path.

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
* Review: the mock kept `İ` as is (JavaScript lowers it to `i` plus U+0307), Go lowers it to
  `i`; the mock now takes the first code point. Go breaks ties by byte length and byte order,
  the mock compared UTF-16 `.length` and `<`; it now compares UTF-8 bytes. A throwaway
  cross-check (20,000 random Score/Positions cases, 3,000 random multi-source searches with
  non-ASCII names, paths and multi-word queries) then agreed everywhere. The rest of the
  per-code-point lowering differs only for letters newer than Go's Unicode tables.
* Words split at Go's `unicode.IsSpace` (`strings.Fields`). JavaScript's `\s` has U+FEFF
  and lacks U+0085, so the mock splits at an explicit class of Go's spaces, and decides
  "empty query" by the word count rather than `trim()` (which strips U+FEFF too).
* A word that misses a path is scored once per path, not once per split: RankSources
  caches each word's Score for the path and evaluates the splits lazily.
* Review: a failed listing names its checkout (`list <dir>: ...`); with several sources the
  bare git or walk error didn't say which one.

## Verified

* `make check` green.
* A scratch daemon (`CODE_FOUNDRY_HOME=/tmp/...`, `make build`) with two scratch git repos
  under home, registered with `project.add`, `SearchFiles` called over Connect JSON with
  curl: the old fields (project id, checkout and positions filled), two sources for `tree`
  (one list, interleaved by score), `ghostty tree` (ghostty-playground's tree files first,
  project positions 0-6), `readme` (ties in the order of the sources sent), directories
  without `files_only`, and the refusals (both field sets InvalidArgument, a source outside
  home InvalidArgument, an unknown project NotFound). Scratch repos deleted afterwards.
* The mock against the Go tests' cases (same order and positions, through a throwaway
  script), and the e2e specs that use SearchFiles through it (`composer-files`,
  `composer-skills`, `no-project`, `file-tabs`).
* Per-word matching: a throwaway cross-check of Go against the mock, two runs of 4,000
  random searches over one to three sources (non-ASCII names and paths, multi-word queries
  with odd whitespace: tab, NBSP, U+0085, U+3000, U+2028, U+FEFF), the second with queries
  built from slices of the sources' names and paths (641 searches used project words), plus
  20,000 random ScoreWords/PositionsWords cases: identical order, scores and positions
  everywhere. The four e2e specs above pass with it.
* Per-word matching through a scratch daemon (`CODE_FOUNDRY_HOME=/tmp/...`, two scratch
  repos named code-foundry and ghostty-playground, curl): `comp tsx` and `tsx   comp` find
  `.../compose/Composer.tsx` first and `.../components/Thread.tsx` second, positions across
  both words; `comp zzz` nothing; `composer` as before; `tree` unchanged; `ghostty tree`
  ghostty-playground's `src/tree.zig` first (project positions 0-6), then code-foundry's
  `docs/ghostty-tree.md`, then `src/subtree/x.zig`; `gh zig tree` both zig files with name
  positions 0-1; `readme gp` README.md with name positions 0 and 8; `code foundry` nothing.
