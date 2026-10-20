# Linked PRs include child threads' links (2026-10-20)

PR 1 of 2. A thread's `LinkedPullRequests` now also hold every pull request linked by the
threads it created (`CreatedBy`), transitively. PR 2 adds links for the pull request whose
head is the thread's worktree branch (`source = 'branch'`, reserved here). Daemon only: no
proto, API, CLI or GUI change. Builds on `linked-prs.md` and `lineage-by-id.md`.

## Decisions

From the brief (agreed with Alex):

* **"Child" is `CreatedBy`, not `ParentID`.** A fork inherits nothing and a fork of a child
  is not a child (a fork has no `CreatedBy`; `Fork` never sets it).
* **The union is materialized.** When a thread gains a link, each ancestor up its
  `CreatedBy` chain gains a copy, under the existing rules: deduplicated by URL (an
  ancestor that already has the URL keeps its row, whatever its source), first-seen
  order, never removed, copy-on-write slices. Every consumer (API mapping, plugin facts,
  wake subscriptions, GUI) reads `LinkedPullRequests` unchanged.
* **Provenance is stored, not surfaced.** Migration `0039_thread_pull_request_source.sql`
  adds `source TEXT NOT NULL DEFAULT 'claude'` (`claude`, `child`, `branch`) and
  `via_thread_id TEXT NOT NULL DEFAULT ''` to `thread_pull_requests`. The store's
  `LinkedPullRequest` has `Source` (`LinkSource`) and `ViaThreadID`; the proto does not.
  `via_thread_id` is the direct child at each hop: a grandchild's link reaches the
  grandparent via the parent.
* **A copy keeps the original's `LinkedAt`.**
* **Archived children count; removed ones leave their copies.** The copies are the
  ancestor's rows, so the `ON DELETE CASCADE` of a removed child does not touch them. A
  removed thread does end the chain for later links (its children's `CreatedBy` points
  at nothing).

Decided while building:

* **The whole new set goes up every hop**, not only what was new at the previous hop. If
  the parent had linked the URL itself, the grandparent still gets it (via the parent).
  Under the invariant the grandparent already has it and nothing changes; without it
  (rows from before this shipped) the chain is mended. Chains are a few threads deep.
* **One `Updated` per thread that changed**, from `addLinksLocked` (the merge, persist
  and publish `linkPullRequests` already did, now shared). A re-emitted record publishes
  nothing anywhere: nothing is new for the thread, so nothing is propagated.
* **Locking unchanged.** `linkPullRequests` already persisted and published under `m.mu`
  (`commitLocked` saves under the lock so the snapshot never runs ahead of the
  database); propagation runs in the same critical section, one `saveLinks` transaction
  per changed ancestor.
* **Cycle and missing-thread guards.** The walk keeps a seen set and stops at a thread
  with no creator, a creator that is gone, its own creator, or a thread it already
  visited. `CreatedBy` is set once at `Create` and never changed, so a cycle cannot
  happen today; the guard is for corrupt rows.
* **Startup fold** (`foldChildLinks`, called in `New` after the threads load and before
  the first snapshot, so it publishes nothing). For each thread with children, in
  `CreatedAt` order: every descendant's links (breadth first, seen set), each tagged with
  the direct child it is under, sorted by `LinkedAt` (stable), merged; only new rows are
  written. The earliest record of a URL wins (the analogue of "first source"); a fold
  appends after the thread's existing rows, so an older backfilled link can sit after a
  newer own one. Idempotent: a second start finds nothing new, writes nothing and logs
  nothing. One `Info` line when it inserted something:
  `linked pull requests folded up from child threads threads=N links=M`. A thread whose
  rows fail to save keeps its loaded list and is folded again on the next start.
* **A thread that later links a URL it already has as `child` keeps the `child` row.**
  Seen live: the parent's own pr-link for #258 after the copy arrived changed nothing.
* **The proto comment** on `Thread.linked_pull_requests` still says "Pull requests Claude
  linked to the conversation"; left alone because the brief rules out proto changes.
  Worth widening with PR 2's surfacing.

## What changed

* `internal/db/migrations/0039_thread_pull_request_source.sql`.
* `internal/store/thread/prlink.go`: `LinkSource` (`LinkClaude`, `LinkChild`,
  `LinkBranch`), `LinkedPullRequest.Source` / `ViaThreadID`, `parsePRLink` sets
  `LinkClaude`, `linkPullRequests` calls `addLinksLocked` then `propagateLinksLocked`.
* `internal/store/thread/prlink_children.go` (new): `asChildLinks`, `addLinksLocked`,
  `propagateLinksLocked`, `foldChildLinks`.
* `internal/store/thread/db.go`: `saveLinks` writes `source` (empty saves as `claude`)
  and `via_thread_id`; `loadLinks` reads them; header comment lists 0039.
* `internal/store/thread/manager.go`: `New` calls `foldChildLinks`.
* `internal/store/thread/thread.go`, `docs/ARCHITECTURE.md`: the field's meaning.

## Tests

* `prlink_children_test.go`:
  * `TestLinksPropagateUpCreatedBy` (table, real `Manager`): one level (a sibling gets
    nothing), two levels (grandparent's via is the parent), parent already has the URL
    (its row stays `claude`, the new one still reaches the grandparent), first-seen order
    across two children, an archived child, a repeat publishing nothing; `Updated` counts
    per thread for the last step; every case re-checked after a restart (source, via and
    time persisted).
  * `TestLinkPropagationStops` (table): two- and three-thread cycles, own creator, creator
    gone, creator gone mid-chain; `CreatedBy` forced on the records, with a timeout so a
    loop fails rather than hangs.
  * `TestLinksNotAcrossForks`: a real `Fork` of a child; the fork's link goes nowhere and
    the child's does not reach the fork.
  * `TestFoldChildLinksAtStartup`: rows written as an older daemon would (own links only)
    for a grandparent, parent, grandchild, a second child, an unrelated thread and a child
    that is then removed; the first start folds in `LinkedAt` order with the right vias
    and logs `threads=2 links=9`; the removed child's copies stay; a second start writes
    no row and logs nothing.
  * `TestSaveAndLoadLinkSource`: an unset source saves as `claude`; `child` with via and
    `branch` round-trip.
* `internal/db/thread_pull_request_source_migration_test.go`: a row written before 0039
  reads back `claude` / `""`; a new row stores its own.

## Verified

* `make check` green (gofmt, vet, staticcheck, `go test -race ./...`, frontend typecheck,
  lint, 4906 vitest tests).
* End to end, 2026-10-20: `make build`, binary copied to a scratch dir, isolated home,
  `CODE_FOUNDRY_HOME=<scratch>/home code-foundry daemon --dev`; the CLI with the same home.
  Threads without a project, Haiku 5.5 at medium effort, prompt "Reply with just the word
  OK.":

```
$ code-foundry thread new --no-project --model 'claude-haiku-5-5[1m]' --effort medium --name "lpc parent" --created-by= --prompt "Reply with just the word OK."
created thread lpc parent (s-1f19506ab6a0) in /Users/alex (no project)
$ code-foundry thread new ... --name "lpc child" --created-by s-1f19506ab6a0 ...
created thread lpc child (s-53c97355f885) ...
$ code-foundry thread new ... --name "lpc grandchild" --created-by s-53c97355f885 ...
created thread lpc grandchild (s-9737376b2d7d) ...
$ code-foundry thread list
s-53c97355f885  attention (finished)  lpc child       no project  now  ↳ lpc parent
s-1f19506ab6a0  attention (finished)  lpc parent      no project  now
s-9737376b2d7d  attention (finished)  lpc grandchild  no project  now  ↳ lpc child
```

  1. Appended a pr-link record for #258 (timestamp 09:00Z) to the grandchild's live
     transcript (`~/.claude/projects/-Users-alex/<session>.jsonl`). Within 2 s
     `thread get <id> --json` listed #258 with `linkedAt 2026-10-20T09:00:00Z` on all
     three threads.
  2. Appended #257 to the child's transcript and #258 to the parent's own: parent
     `[258, 257]`, child `[258, 257]`, grandchild `[258]`.
  3. `thread fork --id s-53c97355f885` (the fork needed a `thread send --wait` before it
     had a transcript); its copied transcript gave it #257; #256 appended to it stayed on
     the fork only.
  4. `thread_pull_requests` (sqlite3): parent 258 `child` via child, 257 `child` via
     child; child 258 `child` via grandchild, 257 `claude`; grandchild 258 `claude`; fork
     257 and 256 `claude`. The parent's own #258 record did not replace its `child` row.
  5. Daemon stopped (SIGTERM); a row for #255 inserted for the grandchild with sqlite3
     (no source: defaulted `claude`), as a pre-propagation daemon would have left it.
     Restart logged `linked pull requests folded up from child threads threads=2 links=2`;
     parent and child listed `[258, 257, 255]`, both `child`, the parent's via the child.
  6. `thread remove` the grandchild, stop, start again: 8 rows before and after, no fold
     line, parent and child still `[258, 257, 255]`. No warnings or errors in the logs.
  7. Threads removed, daemon stopped, scratch home and the four scratch transcripts
     deleted.

Not verified: a pr-link record written by Claude itself (same as `linked-prs.md`, the
e2e appended records in the captured format), and the GUI (unchanged: it reads the same
field).

## Gotchas

* `thread send` takes the text as a positional (or `--text`), not `--message`.
* A fork has no `claudeSessionId` until its first message: send it one before writing
  to its transcript.
* `go test -race` outside `make` needs `PKG_CONFIG_PATH` from
  `./scripts/ghostty-vt.sh --print-prefix` (`/share/pkgconfig`).

## Daemon restart

Needed: the migration and the fold run at startup. The GUI is unchanged and works with
either daemon.
