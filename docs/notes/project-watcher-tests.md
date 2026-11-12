# Project watcher tests and a slow fseventsd (2026-11-11)

On 2026-11-11 six `make check` runs in a row failed only in `internal/store/project`, in
three worktrees, on branches that did not touch it. Each failure was a 10 to 20 s wait
for a file event that came late or never (`TestStreamFilesEvent` saw no event in 20 s,
`TestRemoteChangesAreDetected` timed out on `origin added`, `TestStreamBurstIsBounded`
counted 10 status runs against a limit of 9, and seven more). `fseventsd` sat at about
100% of a core with nothing of ours running; after a reboot it idled at about 6% and the
check passed. This change answers two questions: which of those tests should depend on
`fseventsd` at all, and whether the daemon itself goes stale when it is slow.

## What each failing test was waiting on

The store's one FSEvents stream (`fsevents.go`) is the only place events come from. With
an event source that sends nothing, exactly ten tests in the package fail, and they are
the ten from the failing runs. Every other test already ran without the stream.

| Test | Waited on | Is it about |
|---|---|---|
| `TestWorktreeLifecycleAndWatcher` | a file, a commit and a fetch reaching the store as events | what those events lead to |
| `TestOperationStateThroughWatcher` | rebase and merge markers in the admin dirs | what they lead to |
| `TestRemoteChangesAreDetected` | `.git/config` rewritten by `git remote add/remove` | what it leads to |
| `TestExternalWorktreeAddAndRemoveAreDetected` | `.git/worktrees/<name>` appearing and going | what it leads to |
| `TestInitGit` (both subtests) | a commit after `InitGit` | that the routes switched to a git project |
| `TestStreamSeesGitInit` | `.git` created in a plain project | what it leads to |
| `TestMissingProjectReportsErrorAndRecovers` | the project dir moved away (the error came from the stream, the recovery from the poll) | the poll's recovery |
| `TestStreamBurstIsBounded` | 2000 file events, and a wall-clock bound on status runs | the debounce |
| `TestStreamSeesNestedEdits` | nested edits in three kinds of stream root, and the stream's paths | FSEvents delivery, and stream paths |
| `TestStreamFilesEvent` | real FSEvents flags (cumulative, a stale `ItemCreated`) through the files job | FSEvents flags |

Eight of the ten test the store's logic and only used FSEvents to deliver the event.
Their wait was a wait on `fseventsd`, so a slow daemon on the machine failed them however
right the store was. Before this change the package had 26 waits on FSEvents delivery
across those tests, and every store test (87 harnesses) started a real stream over its
fixture.

## What changed in the tests

- **The seam.** `fsWatcher` takes a `streamSource` (start a stream over paths that sends
  on the store's channel; return its stop). The store's is `fseventsSource`; `Options`
  has an unexported `streams` field for tests. Everything after the source is the real
  code: the channel, `dispatch`, `onEvents`, the debouncers and the scheduler.
- **`fakeStream`** (`fakestream_test.go`) is every harness's source unless the test asks
  for real FSEvents. It sends nothing on its own. After a change on disk the test calls
  `h.fsChanged()`, which rescans the running stream's roots, diffs against the last scan
  and sends what FSEvents would report: one event per file, `ItemCreated`,
  `ItemRemoved`, `ItemModified`, `ItemRenamed` for a new inode at the same path (git's
  lock file renamed onto `index` or `config`), `ItemInodeMetaMod` for attributes only,
  and directories only when created or removed (`FileEvents` reports the entry, not its
  parent). A root's files when its stream starts are its baseline, as with a stream
  started since now. `TestDiffScans` covers the diff. `h.waitStreamRunning` waits for
  the stream the store actually started, not for `streamPaths()`: the routes change
  before `sync` restarts the stream, so the old `waitStreamPaths` could pass early.
- **The eight logic tests** call `h.fsChanged()` after each change. Their remaining waits
  are on the store's own git commands.
- **`TestStreamPathsFollowTheWorktrees`** (fake) takes over the stream-path half of the
  old `TestStreamSeesNestedEdits`: the managed root, the project, a hand-made worktree
  gained after a reconcile and lost after its removal, the project gone after
  `Unregister`, and edits in each root.
- **`TestTreeBurstCostsOneStatusPerWindow`** replaces `TestStreamBurstIsBounded`. The old
  limit (`burst / window + 3` status runs) compared the test's own measure of how long
  it wrote with when timers fired after `fseventsd` delivered: a late or spread delivery
  spans more windows than the writes did, so the count rose with no change in the store.
  What the store promises is per window: `onEvents` triggers the tree debouncer once per
  key per batch, the debouncer fires a key once per window, and the scheduler runs one
  status per fire. The debouncer's timers are now injectable (`debouncer.setClock`); the
  test feeds 2000 events in batches of 32 straight to `onEvents`, fires a manual clock,
  and asserts exactly one timer and one status run, then three windows and three runs,
  then no timer once events stop.
- **`TestPollReconcilesWithoutEvents`** (new, below) and the poll-only
  `TestMissingProjectReportsErrorAndRecovers` cover the safety net.
- **`ignoreStream` is gone.** It existed so tests could drop the real stream's late
  deliveries of their own setup; the fake sends nothing unasked.

### The real-stream tests that stay

Two, with six delivery waits between them (from 26):

- `TestStreamSeesNestedEdits`: a real stream over the main checkout, a managed worktree
  and a hand-made worktree outside both (gained when a refresh lists it) delivers a nested
  edit in each, and the store refreshes it.
- `TestStreamFilesEvent`: real FSEvents flags through the files job.

That is what only a real stream can show: that the paths the store computes are ones
FSEvents reports under (resolved `/private/var` paths, nested roots), and how its flags
really look. Routing, classification and debounce are covered against the fake and in
the table tests of `watch_test.go`.

Their source is a `streamRecorder`: real FSEvents, with every delivered path logged on
the way to the store. Each wait is split in two. `waitDelivered` waits for the event
itself and, on a timeout, says FSEvents delivered nothing for the path, how many other
events it delivered meanwhile and `fseventsd`'s CPU: the store was never asked to act.
The store's reaction is then a separate wait. `catchUp` first writes a probe into `.git`
(no route acts on it) and waits for it: FSEvents delivers a stream's events in order, so
a late event from the fixture's setup cannot stand in for the test's own afterwards.

These two still fail when `fseventsd` takes over 10 s to deliver, and should: the
product is degraded then too. The failure now says which side was slow.

## What the daemon does when events are late or lost

Measured with a probe program (a stream with the store's flags and latency, writing a
marker file every 200 ms and timing its delivery), right after a reboot:

| Load | fseventsd CPU | Markers delivered | Latency p50 / p99 / max | Rescan events |
|---|---|---|---|---|
| none, 5 s | under 2% | 25 of 25 | 142 / 250 / 257 ms | 0 |
| 4 writers in a sibling (unwatched) dir, 20 s, 664k ops | 292 to 313% | 100 of 100 | 124 / 244 / 247 ms | 0 |
| 4 writers inside the watched dir, 20 s, 642k ops | 218 to 384% | 99 of 100 | 7 / 49 / 152 ms | 13, all `0x3` at the root |
| 8 goroutines creating and stopping streams, 20 s, 5148 cycles | 11 to 14% | 100 of 100 | 115 / 253 / 257 ms | 0 |

- **High CPU alone does not make delivery late.** At three cores busy with churn, marker
  latency was the stream's 250 ms latency, as when idle, and `fseventsd` was back under
  2% seconds after the writers stopped. I could not reproduce late delivery with
  bounded load.
- **Late events are only late.** The store has no timeout on events; when one arrives it
  is routed and acted on.
- **Events are lost, flagged, when a watched tree churns.** With the writers inside the
  watched dir, `fseventsd` dropped events for the stream and said so:
  `MustScanSubDirs | UserDropped` (flags `0x3`) on the stream root, 13 times. One marker
  in a dropped range was never delivered. The store acts on that flag: `eventKeys`
  reconciles every project with a known directory at, above or below the path (a stream
  root covers every project in it), and a reconcile re-lists worktrees and metadata,
  then re-resolves the base and refreshes every status. In a scratch daemon (`--dev`,
  isolated `CODE_FOUNDRY_HOME`) with 4 writers inside a registered project's worktree for
  15 s, the log had 21 `fs events need a rescan ... flags=3` lines and 5 reconciles,
  and an edit to a tracked file made during the churn was in the snapshot afterwards
  (`modified: 1`). This is the load the app exists for (agents building in worktrees),
  so these lines are expected under builds, and handled. (The `flags=32` lines seen
  before are `RootChanged`: a stream root created, moved or removed, such as the managed
  worktree root appearing or a hand-made worktree deleted. Same handling.)
- **Events can be lost without a flag** in two ways. A stream that is replaced (the
  store starts the new one since now, then stops the old) drops what the old one had not
  delivered: up to its 250 ms latency buffer, and a batch whose callback is running when
  `Stop` removes the stream's registry entry (the fsevents package logs `failed to
  retrieve registry` and drops it; 4 times in the 5148 cycles above). And a stream that
  fails to start delivers nothing.
- **The safety net had a hole.** The backstop poll (2 min for a live project, 10 min
  idle) only requested `jobBase` for a git project: it refreshed the status of the
  worktrees the store already knew, but never re-listed worktrees, re-read remotes or the
  default branch, noticed a moved project, or retried a stream that failed to start
  (`sync` ran only from a reconcile whose routes changed). A lost event about any of
  those stayed stale until something else reconciled the project: a fetch (only projects
  with an origin), a manual refresh, or a restart. A project without an origin had none
  of those on its own. Both `TestPollReconcilesWithoutEvents` and
  `TestMissingProjectReportsErrorAndRecovers` time out against the old poll.

### The fix

- **The poll reconciles.** `poll` requests `jobReconcile`, which ends in `jobBase` and
  every status as before. The extra cost is four small git commands per project per
  round (`worktree list`, `remote`, `remote get-url`, `symbolic-ref`). Nothing the stream
  should have reported stays stale past one poll interval, whatever happened to its
  event.
- **Every reconcile syncs the stream.** `sync` recreates the stream only when its paths
  differ, so when they match it is a round trip to the watcher goroutine; a stream that
  failed to start is now retried at the next reconcile (the poll's included), as the
  comment in `run` already claimed.

Verified end to end in the same scratch daemon: in the project without an origin,
`git checkout -b trunk` in the main checkout moved the worktree's branch to `trunk` at
once (a `HEAD` event, a status job), while the project's default branch, which only a
reconcile reads, stayed `main` until the idle poll.

## What put fseventsd in that state

Not established. What the measurements say:

- `fseventsd`'s CPU follows the write rate: 300% while 4 writers churn, under 2%
  seconds after they stop. A steady 100% with nothing of ours running points at
  something still writing, more than at a state `fseventsd` keeps on its own: a process
  left over from a test (the 890 `TestMisbehavingPluginsflood*` directories were failed
  `t.TempDir` cleanups, a flood plugin's log recreated after close, fixed in #655;
  whether any of those plugin processes outlived their test was not checked before the
  reboot), or Spotlight (`mds`, `mds_stores` were busy) indexing the 6.5 GB of new files.
  A reboot ends both, which fits.
- Stream churn is cheap for it: 5148 stream starts and stops in 20 s cost 11 to 14%.
- Our own test load on it is now lower: store tests no longer start a real stream over
  every fixture, only the two real-stream tests and `requireFSEvents` do.

If it happens again, before a reboot: `sudo fs_usage -w -f filesys | head` (who is
writing), `ps -o %cpu -p $(pgrep -x fseventsd)`, `ls $TMPDIR | wc -l`, and
`mdutil -s /System/Volumes/Data`.

## Not fixed

- **The replaced-stream gap.** Starting the new stream from the old one's last delivered
  event id (instead of since now) would close it, but it replays history from
  `fseventsd`'s database, more work for a daemon that may already be struggling, and the
  poll now bounds the staleness. Streams are replaced only when a project is added or
  removed or a worktree outside the roots appears or goes.
- **Staleness is bounded by the poll interval**, 2 min live and 10 min idle, for an event
  lost without a flag. A thread's own edits do not depend on FSEvents: its edit-tool
  results and turn ends refresh its worktree directly (`Touch`, `TouchNow`).
- **Log volume under builds.** Each rescan batch logs one `fs events need a rescan` line
  at info: 21 lines in 15 s of churn in one worktree.
- **The two real-stream tests** still fail when `fseventsd` takes over 10 s, with a
  message that says so.
