# Search 3: the daemon's search index and thread.search

Status: PR 3 of 6 in the thread search series, on branch `cf/search-3-index`. Daemon, proto
and CLI only. PR 4 (the cross-thread Find dialog) and PR 5 (Agent search, whose hidden run
calls `thread.search`) build on it. Needs a daemon restart (migration 0054, new RPC).

## What landed

| Path | What |
|---|---|
| `internal/db/migrations/0054_thread_search.sql` | `search_docs`, `search_fts` (FTS5 trigram, contentless), `thread_items_item_id` index (item id, thread, subagent), the `thread_items_search_gone` trigger, `search_backfill` filled with every thread |
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
  startup the store indexes them in the background, at most 500 indexed items per
  transaction (`searchBackfillChunk`; read and write in the same transaction, so a live
  save never gets overwritten by older text). `next_ordinal` records the first item not
  done yet, and the row goes when the thread is done, so a stop resumes where it left off,
  inside a thread too. A chunk holds the write lock for about 100 ms however long the
  thread: one transaction per thread would hold it past the 5 s busy timeout for a thread
  of about 25k indexed items (Ember's chat), and a live `saveItem` that times out is only
  logged, so that item would never reach the database. A thread that fails (a row whose
  `data` is not JSON) is logged and dropped from the list, and the others go on: the
  backfill runs once, and one bad thread must not keep the most recent ones (last in the
  list) unindexed on every start. Threads go least recently active first, so the most
  recent ones get the highest rowids (see "Reading at most 5,000 matches"). Only the
  indexed kinds are read (`kind IN (...)`): tool calls are most of the bytes, and reading
  them made the backfill twice as slow.

## What is indexed

The registry `searchTexts` (by `ItemKind`). Text that stays visible when a turn folds:

* **user_message**: the text the timeline shows (`promptText`: the composer text with
  tags as their chips read, else the typed text), except thread tags: those read as the
  label they were sent with (`storedLabel`), not the thread's current name, both in the
  index and in the text check. Matching the current name against text indexed under an
  older one lost the message after a rename (a provisional name replaced by auto-naming
  too). Steers and messages from other threads count. Wakes do not: they are drawn as
  lineage notes, not messages.
* **assistant_text**: Claude's text, except an API error (drawn as an error).
* **question**: each question's text, then its answer once answered, one per line. An
  option nobody chose is not indexed.

Every kind's text is indexed on one line (white space runs one space, like the query
side's `searchLine`), so a phrase across a line break or a run of spaces is found:
markdown, and every question, whose question and answer are joined by a line break.

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
  end). Other control characters (a NUL, an escape) are dropped: FTS5 refuses a NUL in a
  string, which surfaced as an internal error. Each term goes to FTS5 as a quoted string,
  so `NOT`, `OR`, `NEAR(`, `*`, `-`, `^` and `col:` are plain text (a regression table
  tests them). Every term must occur, in any order, as a substring (like the file finder's words).
* **Smart case**: case-insensitive unless the query has an upper-case letter
  (`unicode.IsUpper`), then exact. The index is always case-insensitive; the store checks
  each candidate's text in Go.
* **Short terms**: the index sees terms of three characters and more. A term under three
  is checked in Go against the candidates the long terms found. A query with only short
  terms (`ui`, `go db`) searches **thread names only** (`names_only`), which is cheap and
  still useful for the dialog's first keystrokes. Thread names always match every term,
  short or long.
* **Text check**: every candidate's own text (the holder's copy, through the extractor) is
  matched in Go. That covers case, short terms,
  and a document saved from another copy of the item (see Gotchas).
* **Scope** (default = what the sidebar can show): threads no plugin owns that are in the
  sidebar (`InSidebar`: no creator, or a creator that is gone), archived and snoozed ones,
  Ember's chat (a top-level thread with no creator), and their own items, not their
  subagents'. `--include children` adds hidden children, `subagents` adds subagent items,
  `owned` adds plugins' threads, and `--all` adds all three. `--project` keeps threads whose
  project set has one of the projects. An `Unindexed` thread is never in scope.
* **Forks**: one hit per item id, attributed to the **oldest thread in scope** whose own
  copy matches (`CreatedAt`, then id): each holder is decoded and matched first, so an
  older copy that differs (a question answered only in the fork) does not hide the
  younger copy's match. The original wins while it exists, archived or not; once it is
  removed its rows are gone and the fork's copy is the holder, with nothing re-indexed
  (the document and its rowid stay). "In scope" matters: a user who forks a hidden child
  to take its work over finds the hit under the fork, not hidden under the child. The
  spec said the oldest holder overall; the oldest holder in scope was reviewed and kept as
  better. Tests: original alive, archived, removed; fork of a hidden child; an older copy
  that does not match.
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
  highest-rowid matching documents **in scope** (`ORDER BY rowid DESC LIMIT 5001` inside
  the FTS subquery; the 5,001st only says there are more, `truncated`). The scope is
  inside that subquery: a document counts only when a thread of the scope holds it (its
  own item, or a subagent's with `subagents`), checked by an `EXISTS` over
  `thread_items_item_id`, which covers item id, thread and `parent_tool_use_id`. The
  first version took the newest 5,000 of the whole index and filtered after, so newer
  subagent or child text could take every place and hide the user's own hit while
  `truncated` said "among the newest". I chose the scope in SQL over paging rowid windows
  with a budget: it is exact (`truncated` means more than 5,000 in-scope documents
  matched), one query, and measured fast enough (below). Rowids grow with a
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
| thread_items_item_id index (item_id, thread_id, parent_tool_use_id) | 11 MB (7 MB on item_id alone) |
| building that index in migration 0054 | 0.62 s (0.31–0.44 s on item_id alone); the whole migration 0.64 s |
| backfill | 30–34 s (69 s before reading only indexed kinds), in the background; one run under load took 61 s |
| backfill chunk (500 indexed items) | longest 143–508 ms of write lock across runs |
| one 25k-item thread (Ember's long chat) | 6.0–8.1 s in 51 chunks, longest 189–288 ms (one transaction: about 5 s, the busy timeout) |
| save of an indexed item | 0.46 ms (0.05 ms for a row alone); other kinds unchanged |

Queries (warm, median of 5; `searchHits`, the SQL and the Go text check), after the 5,000
cap and tiers. Before them, the same queries took 0.4–4.8 s. The database for these has
scopes: every fifth thread is a child of a live creator (hidden by default) and about 15%
of the items are a subagent's. "Narrow" is a scope of 10 of the 1,000 threads (a small
project's filter), where nearly every match is out of scope and gets probed:

| query | default | all (`--all`) | narrow | cap before scope (old), any scope |
|---|---|---|---|---|
| `the` | 83 ms, truncated | 76 ms, truncated | 206 ms, 1,312 hits | 58 ms |
| `The` (case-sensitive) | 65 ms | 62 ms | 203 ms | 52 ms |
| `login redirect` | 161 ms, truncated | 137 ms, truncated | 164 ms, 150 hits | 122 ms |
| `"login redirect"` | 139 ms, 82 hits | 134 ms, 107 hits | 203 ms | 138 ms |
| `saveItem` / `TestSearchForks` | 100 / 124 ms, truncated | 87 / 98 ms | 161 / 294 ms, 325 / 337 hits | 75 / 89 ms |
| `"login redirect session"` (no match) | 169 ms | 166 ms | 169 ms | 172 ms |
| `zzqx` (no trigram match) | 0.1 ms | 0.1 ms | 0.1 ms | 0.0 ms |

The scope costs about 25 ms on the default scope. Narrow scopes cost the most because the
`EXISTS` runs for every match until 5,000 are in scope; the old query was fast there only
because it read the newest 5,000 of everything and then found almost nothing in scope.
Two traps measured on the way: without the unary `+` on `thread_id`, SQLite probed the
`(thread_id, item_id)` unique index once per thread of the scope for every match (53 s for
`the`); and with `thread_items_item_id` on `item_id` alone, the narrow scope took
0.36–0.82 s (table row reads). Names-only queries (`ui`) are unchanged (1 ms).

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
* A thread tag is found by the label it was sent with, not by the tagged thread's
  current name (see "What is indexed"). The timeline shows the current name, so a message
  that tags a renamed thread is found by the old name only. Accepted: the index and the
  check agree, and nothing has to be re-indexed on a rename.
* `searchBackfillChunk` is a package variable too, for the resume test.
* Times are milliseconds, so two items saved in the same millisecond tie on recency; the
  later document (higher rowid) wins the tie.
* `maxSearchCandidates` is a package variable so a test can lower it. Tests in the package
  do not run in parallel.
* Searches during the backfill see what is indexed so far.
* `make gen` regenerates the Wails bindings too. Only the proto outputs changed here.

## Left for later PRs

* **(PR 5)** A save that races the snapshot indexes a thread that is not in the snapshot
  yet (`searchIndexFor` cannot see it, so `Unindexed` cannot either). Hidden runs must
  decide Unindexed from something persisted when the thread is created, not from the
  snapshot.
* **(PR 4)** Match ranges are code points; the TS side must convert them to UTF-16 before
  slicing (an emoji or any astral character before a match shifts them).

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
* After the review fixes, end to end in a new scratch home: a thread whose prompt and
  reply hold "alpha bravo" and "charlie delta" on two lines was found live by
  `"bravo charlie"` (both items); `NEAR(` and `"unbalanced` returned no matches, not an
  error. With the documents deleted and the thread listed in `search_backfill` again, a
  restart logged `indexed threads for search threads=1 failed=0 items=2`, emptied the list
  and found both again. (That run caught the log's `failed` and `items` swapped.)
