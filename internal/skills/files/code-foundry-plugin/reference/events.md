# Events

{{cf.provenance}}

Subscribe and OnEvent: the daemon's events (permission `events`).

```go
pluginsdk.Plugin{
	Init: func(ctx context.Context, h *pluginsdk.Host) error {
		_, err := h.Subscribe(ctx, "threads", "gh")
		return err
	},
	OnEvent: func(ctx context.Context, h *pluginsdk.Host, ev pluginsdk.Event) {
		var e struct {
			ThreadList *struct {
				Updated *struct{ ID, Name, Branch, Status string } `json:"updated"`
			} `json:"threadList"`
		}
		if json.Unmarshal(ev.Event, &e) == nil && e.ThreadList != nil && e.ThreadList.Updated != nil { … }
	},
}
```

- Sources (each must be in `permissions.events`): `threads` (the thread list: every
  thread's state), `thread` (threads' pending questions and permissions), `project`
  (projects and worktrees), `workspace`, `gh` (GitHub polling: pull requests, checks),
  `gitops` (git operations per worktree), `settings`, `update`, `action` (project
  actions and their runs), `plugin`.
- `ev.Event` is the event as JSON, exactly what `code-foundry events --json --source
  <source>` prints for the same source: one object keyed by the source with one change
  inside, plus `seq` and `epoch` (enums are their full names, `THREAD_STATUS_IDLE`):
  ```json
  {"threadList":{"updated":{"id":"s-1f2e3d4c5b6a","name":"Fix the login redirect","status":"THREAD_STATUS_IDLE", …}},"seq":"42","epoch":"c85aff6ef6fc"}
  {"threadList":{"removedId":"s-1e06a2c44e99"},"seq":"43","epoch":"c85aff6ef6fc"}
  {"gitops":{"finished":{…}},"seq":"44","epoch":"c85aff6ef6fc"}
  ```
  `updated` carries the whole object after the change, `removedId` (or `removedName`)
  the id of what went. The table below lists every change. See real payloads before
  decoding them: capture a few seconds of `events` (it streams until killed; macOS has
  no `timeout`) while producing the events:
  ```
  code-foundry events --json --source thread-list > /tmp/events.json & pid=$!; sleep 5; kill $pid
  ```
  (`--source` takes the second column of the table below; `h.Subscribe` the first.)
  `code-foundry thread get <id> --json` shows a thread's fields. Decode only what you
  need.
- Each source starts with its snapshot (`ev.Snapshot` true), then live events in order.
  Most snapshots are one object replacing everything
  (`{"threadList":{"snapshot":{"threads":[…]}}}`; `thread`: `pendingSnapshot`); `gh`'s
  are ordinary events (`viewerUpdated`, `polled`, `dashboardUpdated`,
  `repoActivityUpdated`), `update`'s its `status`. Events may reach OnEvent before
  Subscribe returns.
- OnEvent runs on the notification goroutine: keep it short (hand work to a goroutine).
  A plugin that falls behind loses the oldest events (the host keeps 2,048 or 8 MiB) and
  then gets that source's snapshot again: a snapshot after the first means events were
  lost, so replace or rescan what you know.
- Subscriptions end with the process: subscribe in Init. At most 16 at once;
  `h.Unsubscribe(ctx, id)` ends one.

Every source and the changes it sends (this build):

{{cf.eventVariants}}

**The payloads.** protojson: lowerCamel fields, enums by full name, and empty lists,
`false`, `0` and `""` left out (an empty snapshot is `{"threadList":{"snapshot":{}}}`,
with no `threads`). The useful fields:

| Change | Fields |
|---|---|
| `threadList.snapshot` | `threads`: a list of threads |
| `threadList.updated` (a thread) | `id`, `projectId`, `workspaceId`, `worktreePath` (its cwd), `branch`, `name`, `state` (`THREAD_STATE_CONNECTED`, …), `status` (`THREAD_STATUS_BUSY`, `_IDLE`, `_NEEDS_ATTENTION`, `_ERROR`), `statusReason`, `lastActivityAt`, `linkedPullRequests` (`[{slug, number, url}]`), `archivedAt` |
| `threadList.removedId` | the removed thread's id (a string). Archiving is not removal: it arrives as `updated` with `archivedAt` set |
| `project.snapshot` | `projects`: each with `id`, `name`, `path`, `githubSlug`, `defaultBranch`, `git`, `worktrees` |
| `project.worktreeUpdated` (a worktree) | `projectId`, `path`, `branch`, `head`, `isMain`, `detached`, `status`: `{modified, staged, untracked, conflicted, dirty, ahead, behind, upstream, baseRef, baseAhead, baseBehind, operation, error, refreshedAt}` |
| `project.worktreeRemoved` | `{projectId, path}` |
| `project.worktreeFilesChanged` | `{projectId, path, files: [{path, op}], truncated}`: `path` is the worktree root, each file's `path` worktree-relative; `op` is `FILE_OP_CREATED`, `_MODIFIED`, `_REMOVED` or `_RENAMED` |
| `project.projectUpdated` / `projectRemovedId` | a whole project (with its worktrees) / an id |
| `gh.branchPullRequestsUpdated` | `{repoSlug, headRef, fetchedAt}`: a watched branch's pull requests changed |
| `gh.pullRequestDetailUpdated` | `{repoSlug, number}`: re-read with `pr.checks` |
| `gh.pullRequestChanged` | one pull request that changed, one event per pull request per poll (coalesced): `repoSlug`, `number`, `url`, `headRef`, `pullRequest` (the summary after the change: `title`, `author`, `state`, `headSha`, `draft`, `reviewDecision`, `checks` `{state, total, passed, failed, pending, skipped}`, `commentCount`, `reviewCount`, `reviewRequests`, …) and `changes`: a list of `{kind, …}` with the old and new values of that kind. Kinds (`PULL_REQUEST_CHANGE_KIND_` + ): `APPEARED` (new in the viewer's scope; not sent for what was there before a restart or a newly watched branch), `MERGED` / `CLOSED` / `REOPENED` (`oldState`, `newState`), `HEAD_PUSHED` (`oldHeadSha`, `newHeadSha`), `CHECKS` (`oldChecks`, `newChecks`: rollups; `newChecks.state` `CHECK_ROLLUP_STATE_SUCCESS` or `_FAILURE` after `_PENDING` means the run finished), `REVIEW_DECISION` (`oldReviewDecision`, `newReviewDecision`), `REVIEWS` and `COMMENTS` (the count rose: `oldCount`, `newCount`), `REVIEW_REQUESTED` (`requested`: new logins and `org/team` slugs; `viewerRequested`), `DRAFT` (`oldDraft`, `newDraft`), `TITLE` (`oldTitle`, `newTitle`). Counts only, never comment or review text: fetch those with `gh`. No `CHECKS` for a rerun ending with the rollup it had (failure 1/1 → 1/1) or a run that starts and ends between two polls: follow a run you reran yourself. Just after a push, a `when` on `pr.checks.*` can read "not known yet" for seconds the first time it is asked with no GUI: retry |
| `gitops.queued` / `started` / `finished` | a git operation on a worktree (fetch, pull, push, …) |

**Per-file events.** `project.worktreeFilesChanged` lists the files that changed in a
worktree, so a plugin that reacts to edits (a test watcher) needs no polling:

- **One per worktree per second at most.** Edits are collected from the first one for
  1 s, then sent as one event; a burst (a build, a checkout, an untar) arrives as one
  event per second while it lasts.
- **`files`** is sorted by path, each path at most once per event, with what is there
  when the second ends: `created` (new), `modified` (was there before), `removed` (gone,
  also the old side of a rename), `renamed` (moved onto this path). Paths use forward
  slashes, relative to `path` (the worktree root). A directory ends in `/` and appears
  only when removed or renamed: `rm -rf sub` lists `sub/` and every file under it; one
  moved in or out lists only itself (rescan it). An atomic save (`sed -i`, editors: a
  temp file renamed onto the file) is one entry: a never-listed path created and gone
  within the second is left out. Treat `created`, `modified` and `renamed` alike when
  all you need is "this file changed".
- **`truncated: true`**: more changed than listed (the list stops at 500, by path).
  Still a change: a watcher can just re-run; one that needs the list runs `git status`.
- **Left out:** gitignored paths (git's own rules, so a tracked file always counts),
  anything under a `.git` directory, and paths inside a submodule. A second in which
  only ignored files changed (build output, `node_modules`) sends nothing, so re-running
  on every event cannot loop on your own outputs.
- **Live worktrees only:** ones with a thread that is not archived or snoozed. An idle
  worktree sends no file lists (its `worktreeUpdated` status summaries still come).
- It is never in a snapshot. The `project` snapshot at startup is not a resync; a later
  one means events were lost: rescan what you watch once.

Keep using `project.worktreeUpdated` for head, branch, checkout and status-count changes:
a commit sends no files event (only `.git` changes), its new head comes as
`worktreeUpdated`; a `git checkout` changes files, but `worktreeUpdated` says what
happened.
`worktreeDetailUpdated` is sent only for worktrees whose detail someone asked for in the
last 10 minutes (while the app shows it), so a plugin cannot rely on it.

