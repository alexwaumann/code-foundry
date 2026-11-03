# Search 3: the daemon's search index and thread.search

Status: PR 3 of 6 in the thread search series, on branch `cf/search-3-index`. Daemon, proto
and CLI only. PR 4 (the cross-thread Find dialog) and PR 5 (Agent search, whose hidden run
calls `thread.search`) build on it. Needs a daemon restart (migration 0054, new RPC).

## What landed

| Path | What |
|---|---|
| `internal/db/migrations/0054_thread_search.sql` | `search_docs`, `search_fts` (FTS5 trigram, contentless), `thread_items_item_id` index, the `thread_items_search_gone` trigger, `search_backfill` filled with every thread |
| `internal/store/thread/search_extract.go` | the registry of indexed kinds (`searchTexts`): user message, assistant text, question |
| `internal/store/thread/search_index.go` | writing a document on save, the startup backfill, the `Options.Unindexed` hook |
| `internal/store/thread/search_match.go` | the query language, smart case, match ranges, snippets, hit tiers (pure) |
| `internal/store/thread/search.go` | `Store.Search`: scope, candidates, fork attribution, groups |
| `internal/store/thread/items_db.go` | `saveItem`/`saveItems` write the row and its document in one transaction; `decodeItem`, `scanItems` |
| `proto/codefoundry/v1/thread_search.proto`, `thread.proto` | `ThreadService.Search` |
| `internal/api/thread_search.go`, `internal/command/commands_thread_search.go` | the handler; `thread.search` (CLI and model verb, NoPalette, read-only) |
| `internal/skills/files/code-foundry/SKILL.md` | one routing row: earlier threads go to `thread search`, then `thread read --since` |

## The index

* One FTS5 document per **item id**, not per row. A fork's log starts with a copy of its
  parent's items under the same ids (`fork.go`), so a forked conversation is indexed once,
  and a query picks the holder itself. `search_docs (id, item_id, hash)` maps the FTS rowid
  to the item id; `hash` (FNV-1a of the indexed text) makes a save with unchanged text,
  such as each of a fork's copies, write nothing.
* **Contentless** (`content=''`, `contentless_delete=1`): the text is not stored twice.
  Snippets and the text checks read `thread_items.data` and run the extractor again.
* **Trigram**, case-insensitive (`tokenize='trigram'`): substrings of three characters
  and more, so `gin.g` finds `login.go` and `saveItem` finds `saveItem()`.
* **Write path**: every `saveItem` of an indexed kind writes the row and the document in
  one transaction (new items, and rewrites in place: a question's answers). Other kinds
  skip the transaction and the index. Fork copies go through `saveItems` the same way.
* **Removal**: an `AFTER DELETE ON thread_items` trigger drops a document when no row
  holds its id any more. Removing a thread cascades to its rows, and the trigger fires for
  cascaded deletes too, so a fork keeps the documents it shares and the store has no
  removal code. The migration test covers the cascade.
* **Backfill**: the migration lists every existing thread in `search_backfill`; at
  startup the store indexes them in the background, one transaction per thread (read and
  write in the same transaction, so a live save never gets overwritten by older text),
  deleting each row as it finishes, so a stop resumes where it left off. Threads go least
  recently active first, so the most recent ones get the highest rowids (see "Reading at
  most 5,000 matches"). Only the indexed kinds are read (`kind IN (...)`): tool calls are
  most of the bytes, and reading them made the backfill twice as slow.

## What is indexed

The registry `searchTexts` (by `ItemKind`). Text that stays visible when a turn folds:

* **user_message**: the text the timeline shows (`promptText`: the composer text with
  tags as their chips read, else the typed text; thread tags as the thread's name at save
  time). Steers and messages from other threads count. Wakes do not: they are drawn as
  lineage notes, not messages.
* **assistant_text**: Claude's text, except an API error (drawn as an error).
* **question**: each question's text, then its answer once answered, one per line. An
  option nobody chose is not indexed.

Never indexed: tool calls, their input and output, thinking, permission requests, notes,
errors, turn ends, compactions, command output, HTML and theme cards. Subagent items,
child threads, plugins' threads and forks are indexed; queries filter them.

**Hidden runs (PR 5)**: nothing that is not a thread can be indexed, because only the
thread store writes `thread_items` and every row references a thread. A run that never
becomes a thread needs nothing. If PR 5 makes its hidden run a thread, set
`thread.Options.Unindexed` in the daemon (e.g. by the thread's `Owner`). An unindexed
thread's saves write no document (`searchIndexFor`), and queries never attribute a hit to
it (`searchScope`). The predicate is checked against the snapshot on every save, so it
must be cheap; a thread not in the snapshot yet is indexed.

## Query semantics

* **Terms**: split at white space; `"a phrase"` is one term (an unclosed quote runs to the
  end). Every term must occur, in any order, as a substring (like the file finder's words).
* **Smart case**: case-insensitive unless the query has an upper-case letter
  (`unicode.IsUpper`), then exact. The index is always case-insensitive; the store checks
  each candidate's text in Go.
* **Short terms**: the index sees terms of three characters and more. A term under three
  is checked in Go against the candidates the long terms found. A query with only short
  terms (`ui`, `go db`) searches **thread names only** (`names_only`), which is cheap and
  still useful for the dialog's first keystrokes. Thread names always match every term,
  short or long.
* **Text check**: every candidate's own text (the holder's copy, through the extractor) is
  matched in Go, white space runs counted as one space. That covers case, short terms,
  and a document saved from another copy of the item (see Gotchas).
* **Scope** (default = what the sidebar can show): threads no plugin owns that are in the
  sidebar (`InSidebar`: no creator, or a creator that is gone), archived and snoozed ones,
  Ember's chat (a top-level thread with no creator), and their own items, not their
  subagents'. `--include children` adds hidden children, `subagents` adds subagent items,
  `owned` adds plugins' threads, and `--all` adds all three. `--project` keeps threads whose
  project set has one of the projects. An `Unindexed` thread is never in scope.
* **Forks**: one hit per item id, attributed to the **oldest thread in scope** that holds
  it (`CreatedAt`, then id). The original wins while it exists, archived or not; once it is
  removed its rows are gone and the fork's copy is the holder, with nothing re-indexed
  (the document and its rowid stay). "In scope" matters: a user who forks a hidden child
  to take its work over finds the hit under the fork, not hidden under the child.
  Tests: original alive, archived, removed; fork of a hidden child.
* **Order**: each hit has a tier (every term a whole word somewhere, then at the start of
  a word, then inside one; the worst term counts). Groups are ordered by their best hit:
  tier, then the newest. Within a group the best `per_thread` hits (tier, then newest)
  are shown in conversation order. Thread names are ordered most recently active first.
  I first used FTS5's bm25 `rank`. It cost about 300 ms on a large database, it never
  tied, so "then recency" never applied, and it ranks by trigram statistics, which users
  cannot predict. Tiers are cheap, coarse and readable.
* **Limits**: `limit` (default 50, max 500) caps the hits shown in all and the thread
  names; `per_thread` (default 5) caps each group. `total_hits`/`total_threads` count all.
* **Reading at most 5,000 matches** (`maxSearchCandidates`): a search reads the 5,000
  highest-rowid matching documents (`ORDER BY rowid DESC LIMIT 5001` inside the FTS
  subquery; the 5,001st only says there are more, `truncated`). Rowids grow with a
  document's first save, so these are the most recently indexed. That is chronological for
  live saves, and per thread by last activity for the backfill. A rare word never hits the
  cap. A common one returns the recent matches and says the totals are partial. Without the
  cap, a common word took 2 to 5 s on the 400k-item database (see measurements).

## API

`ThreadService.Search(SearchThreadsRequest{query, include[], project_ids, limit,
per_thread}) → SearchThreadsResponse{threads[], groups[], case_sensitive, names_only,
total_hits, total_threads, truncated}`.

* `SearchThreadName{thread_id, name, ranges, archived, last_activity_at}`.
* `SearchThreadGroup{thread_id, thread_name, archived, total_hits, hits[]}`.
* `SearchHit{thread_id, item_id, ordinal, speaker (USER/ASSISTANT/QUESTION), created_at,
  snippet, ranges, parent_tool_use_id}`.
* `ranges` are `[start, end)` in **code points** (like the file finder's positions), into
  `snippet` or `name`. The snippet is the item's text on one line, cut to about 160 code
  points starting up to 48 before the first match, at word boundaries, with `…` where it
  was cut.
* To show the whole item (PR 4's preview): `ListItems(thread_id, query{since: ordinal-1,
  last: 1})`, or find `item_id` in the thread's snapshot. A subagent hit (only with
  SUBAGENTS) has its `parent_tool_use_id`.
* Store side: `thread.Store.Search(ctx, thread.SearchQuery) (thread.SearchResult, error)`;
  the fake answers `SetSearch` and records `Search <query> [children] [subagents] [owned]
  [projects=…] [limit=…] [per=…]`.
* CLI: `code-foundry thread search <words…> [--include children,subagents,owned | --all]
  [--project p,…] [--limit 50] [--per-thread 5] [--json]`. The text output lists thread
  names, then per thread `#<ordinal> <you|claude|question> <age> <snippet>` and a
  `thread read --since` hint. `thread.search` is in the guide (Thread commands are
  detailed; the guide ratchet went to 26,500 bytes) and not in the palette.

## Measurements

Synthetic database (a scratch test, not committed): 1,000 threads × 400 items = 400k
items. Per 10 items: 1 user message (20–60 words), 3 assistant texts (40–200 words), a
thinking, a turn end, and 4 tool calls with 100–500 words of output. A 300-word vocabulary
plus file names and identifiers, Apple Silicon laptop, modernc SQLite 3.53.4.

| | |
|---|---|
| thread_items | 689 MB (495 MB of `data`) |
| indexed text | 112 MB in 161k documents |
| search_fts (trigram, detail=full) | 317 MB, 2.8× the indexed text, 46% of thread_items |
| search_docs + its index | 10 MB |
| thread_items_item_id index | 11 MB |
| backfill | 33 s (69 s before reading only indexed kinds), in the background |
| save of an indexed item | 0.46 ms (0.05 ms for a row alone); other kinds unchanged |

Queries (warm, default scope), after the 5,000 cap and tiers. Before them, the same queries
took 0.4–4.8 s:

| query | time | |
|---|---|---|
| `the` | 73 ms | truncated |
| `The` (case-sensitive) | 56 ms | |
| `login redirect` | 97 ms | truncated |
| `"login redirect"` | 86 ms | 746 hits in 539 threads |
| `saveItem` / `TestSearchForks` | 72 / 80 ms | truncated |
| `ui` (names only) | 1 ms | |
| `zzqx` (no match) | 1 ms | |

Where the time went before the cap: the FTS lookup itself is cheap (all 154k rowids of
`the` in 36 ms; a two-term AND in 140 ms). bm25 `rank` added about 300 ms, and joining
every match to its `thread_items` rows took 0.5–0.8 s.

**Trigram is reasonable.** The index is about 3× the indexed text. On this synthetic data
that is 46% of thread_items; real tool output is larger, so the ratio should be lower.
The alternative measured on the same data: `detail=none` is 67 MB (4.7× smaller) and
fills in 11 s, but FTS5 then refuses phrase queries, so a substring of four or more
characters would have to be an AND of its trigrams with false positives filtered in Go.
Those false positives would also eat into the 5,000 cap. Not worth it unless the size
becomes a complaint; it is the fallback. `detail=column` is 196 MB with the same phrase
problem.

## Gotchas

* **Last write wins** per document. A fork's copy that differs from its original (a
  question pending at fork time, cancelled in the fork and answered in the original) indexes
  whichever copy was saved last. The Go text check uses the holder's own copy, so a hit is
  never shown for text its holder does not have. The other direction can miss a match
  until the next save of that item.
* User messages are indexed with thread tags as the thread's name at save time. A renamed
  thread's tag matches its new name in the text check but not in the index, so the new name
  finds the message only when another term finds it as a candidate.
* Times are milliseconds, so two items saved in the same millisecond tie on recency; the
  later document (higher rowid) wins the tie.
* `maxSearchCandidates` is a package variable so a test can lower it. Tests in the package
  do not run in parallel.
* Searches during the backfill see what is indexed so far.
* `make gen` regenerates the Wails bindings too. Only the proto outputs changed here.

## Verification

* `make check` green. While two binaries were building at the same time, four
  daemon-startup tests in `internal/client` and `internal/daemon` hit their 5 s readiness
  timeout under `-race`. They pass when run alone and in a quiet `make check`.
* End to end, migration included, in a scratch home (`CODE_FOUNDRY_HOME=/tmp/…`, real
  Sonnet 5.5 medium threads without a project, replying without tools):
  1. A build of main (no index) made two threads, a question answered "Amber", and a fork
     of the first thread with a message of its own.
  2. The new build started on that home, migrated, and logged `indexed threads for
     search threads=3 items=11`; `search_backfill` was empty afterwards.
  3. `thread search login` showed the original's two messages once, under the original,
     and the fork's own reply under the fork. `Kerberos` matched exact case; `KERBEROS`
     found nothing. `amber` found the prompt, the question with its answer (speaker
     question) and the reply. `ex` returned thread names only.
  4. A new message was indexed live. A child thread's message was found only with
     `--include children`. `--json` had code-point ranges, ordinals and item ids.
  5. With the original archived, the hits stayed under it, marked archived. Once it was
     removed they moved to the fork's own copies (#1, #2), with no re-indexing. The
     documents matched the distinct indexed item ids (13).
