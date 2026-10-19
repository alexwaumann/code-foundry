# Subtree view: `--descendants-of` (2026-10-19)

REPORT.md item B6 of the 2026-10-19 orchestration battle test (e5 friction 5, candidate
3): `--created-by` is one level, so E5's orchestrator rebuilt its tree by hand twice,
typed 9 ids from memory for "cost by team" (4 Bash calls) and listed Lead B's workers
itself to archive "team B".

## What shipped

| Where | Change |
|---|---|
| `ThreadFilter.descendants_of` | The thread and every thread below it (created by it, by those, ...), up to 8 levels; composes with the other filters. Tree order (each thread before the ones it created, siblings oldest first), `Thread.depth` (optional, 0 for the root) on each row, `ListThreadsResponse.totals {threads, costUsd}` |
| `internal/store/thread/lineage.go` | `Subtree(nodes, root)`: the walk, depth cap `MaxLineageDepth` (8), cycle-safe (each thread once, the root never again); `FilterLineage` = `FilterThreads` plus the tombstones' creator links |
| `thread list --descendants-of <id>` | Rows in tree order, the name indented two spaces per level with `↳ ` (the creator suffix is dropped: the indent says it), the cost after the age, then `total: N threads, $X.XX`. `--json`: the ListThreadsResponse with `depth` and `totals` |
| `thread reports --descendants-of <id>` | The same tree: indented names, the cost before the summary, the total line. `--json`: `depth` on each object |
| `thread archive --descendants-of <id> [--include-root] --yes` | Archives the threads below it (the root too with `--include-root`); `--archived=false` unarchives the archived ones. Always confirms (count, root, ids, then any busy ones as `--ids` says them); nothing to do prints `no threads under <root> to archive` without asking |
| guide | One Conventions line; the per-arg lines are hidden like `--ids` |
| SKILL.md | Leads: a parent runs `thread reports --descendants-of <lead>` (with costs); Archive: a lead and its team with `--descendants-of <lead> --include-root --yes` (160 lines, the cap) |

## Decisions

* **The root is in the subtree** (depth 0) for list and reports: "cost by team" includes
  the lead, and a tree printout starts at its root. Archive leaves it out by default (an
  orchestrator archiving its children must not archive itself), `--include-root` adds it.
* **In the daemon**, like the other filters (agents-5-cli.md): one List call, and the
  answer composes with status, labels, project, `--all`. The traversal walks every live
  thread (archived and plugin-owned ones included) and then the other filters pick the
  rows, so an archived lead's live workers are still listed at depth 2 without it.
* **Limit**: the most recently active N rows of the subtree, then put in tree order. A
  cut tree may miss a parent; the depth still says where a row sits. `thread list`'s 50
  default stays.
* **Removed threads are not listed** (FilterRemoved returns none with descendants_of,
  `--all` adds none) but their tombstones keep the line: a removed lead's workers are
  still under the orchestrator, in the lead's place (tombstones now keep `CreatedAt`).
  A removed root (by suffix too: the A11 fallback) still lists its live children.
* **Totals** are summed by the daemon over the listed rows (`totals`), and by the text
  over the same rows. `formatUSD` is the shared one: two decimals from $0.01, four
  below, so the total of six Haiku threads reads `$0.01` while rows read `$0.0018`;
  `--json` has the exact sum.
* **Archive always confirms with descendants-of**, unlike `--ids` (which asks only when a
  thread is busy): the caller has not seen the ids, so the question lists them. With
  `--ids` it is an argument error; `--include-root` without it too.
* **`--descendants-of` is an id arg** (`ID: ThreadID`, not context-bound): suffixes and
  removed ids resolve like any thread id. `--created-by` stays a one-level filter and
  composes (`--descendants-of <orch> --created-by <lead>`: the lead's workers).
* **Guide budget.** It was 28,982 of 29,000 bytes. Showing the three args per line cost
  ~660 bytes; instead `guideShowsArg` hides `descendants-of` and `include-root` and the
  Conventions "Your children" item gets one line. Paid for by `thread.list` dropping
  "the most recently active first" (the Conventions say it) and shortening its creator
  and `(you)` phrases, and `thread.reports` dropping "for the thread that created them".
  Now 28,967.

## Gotchas

* Tombstones live in memory (24 h). After a daemon restart a removed lead's workers are
  no longer reachable from the orchestrator (their `created_by` names a thread nobody
  knows); `--descendants-of <removed lead id>` still lists them.
* `Thread.depth` is `optional` so the root's 0 is in the JSON; a List without
  descendants_of leaves it unset.
* The commandtest fake does not filter: the command tests hand it the daemon's answer
  (tree order, depths) and check the filter sent.

## Verified live

Isolated daemon (`CODE_FOUNDRY_HOME=/tmp/cf-build-orch-descendants`), scratch project
`od-todo`, six Haiku 5.5 (medium) threads made from the shell with `thread new
--created-by`: Orchestrator → Lead A → Workers 1, 2; Orchestrator → Lead B → Worker B1.

```
$ thread list --descendants-of 8a064373c5a1
s-8a064373c5a1  attention (finished)  Orchestrator   od-todo@main  13s  $0.0022
s-40eb43821d5c  attention (finished)  ↳ Lead A       od-todo@main  7s   $0.0017
s-c5ac6e63ae29  attention (finished)    ↳ Worker 1   od-todo@main  8s   $0.0018
s-76f5875e75dc  attention (finished)    ↳ Worker 2   od-todo@main  7s   $0.0018
s-84c285d584a1  attention (finished)  ↳ Lead B       od-todo@main  7s   $0.0017
s-b6b439fde340  attention (finished)    ↳ Worker B1  od-todo@main  7s   $0.0018
total: 6 threads, $0.01
$ thread list --descendants-of <Lead A> --json   → totals {"threads": 3, "costUsd": 0.0052…}, depths 0, 1, 1
$ thread reports --descendants-of <Orchestrator>
s-8a064373c5a1  -         Orchestrator   $0.0022
s-40eb43821d5c  progress  ↳ Lead A       $0.0017  2 workers started: s-c5ac6e63ae29, s-76f5875e75dc
s-c5ac6e63ae29  -           ↳ Worker 1   $0.0018
s-76f5875e75dc  done        ↳ Worker 2   $0.0018  Added --json output
s-84c285d584a1  done      ↳ Lead B       $0.0017  Team B finished
s-b6b439fde340  -           ↳ Worker B1  $0.0018
total: 6 threads, $0.01
$ thread archive --descendants-of <Orchestrator>                       # exit 2
Archive 5 threads under Orchestrator? They are closed and listed apart: s-40eb43821d5c, s-c5ac6e63ae29, s-76f5875e75dc, s-84c285d584a1, s-b6b439fde340.
$ thread archive --descendants-of <Lead B> --include-root --yes
archived 2 threads: s-84c285d584a1, s-b6b439fde340
$ thread list --descendants-of <Orchestrator>                          # 4 threads, $0.0074; --all adds Lead B's two [archived]
$ thread remove --id <Lead A> --yes; thread list --descendants-of <Orchestrator>
s-8a064373c5a1  …  Orchestrator
s-c5ac6e63ae29  …    ↳ Worker 1
s-76f5875e75dc  …    ↳ Worker 2
total: 3 threads, $0.0057
```

After the tombstone `CreatedAt` commit (daemon restarted): a removed Lead C's worker sits
after Lead B's team, in Lead C's place; Lead A's workers were no longer reachable (the
restart forgot its tombstone, as above).
