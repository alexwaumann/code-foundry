# PR panel redesign, PR B: daemon actions

The daemon side of the new pull request panel's direct buttons: Ready for review,
Convert to draft, Auto-merge on/off, and linking a pull request to a thread by hand.
The GUI PR that follows builds on these and on the mock.

## What shipped

- `GhService.SetPullRequestDraft` (`draft` true/false: `convertPullRequestToDraft` /
  `markPullRequestReadyForReview`) and `GhService.SetPullRequestAutoMerge` (`enabled`,
  `method`, `expected_head_sha`: `enablePullRequestAutoMerge` /
  `disablePullRequestAutoMerge`). Store: `internal/store/gh/pr_draft.go`.
- Commands `pr.ready`, `pr.draft`, `pr.auto-merge --method merge|squash|rebase [--head-sha]`
  and `pr.auto-merge --off` (`internal/command/commands_pr_state.go`), NoPalette like the
  other `pr.*` verbs.
- `PullRequestDetail.auto_merge_allowed` (`repository.autoMergeAllowed`) and
  `auto_merge_method` (the enabled request's method, UNSPECIFIED while off), mapped to
  `autoMergeAllowed` / `autoMergeMethod` (null while off) in `src/api/gh.ts`.
- `ThreadService.LinkPullRequest` and `thread.pr.link <url|owner/name#N>`
  (`internal/store/thread/prlink_manual.go`, source `manual`). No unlink (decided).
- Mock: the same verbs and RPCs in `mock/prDetail.ts` and `mock/world.ts` (header of
  `mock/prDetail.ts` lists the fixtures).

## Decisions

- Two RPCs with a bool rather than four: ready/draft and on/off are one setting each,
  and the GUI toggles them.
- Refusals up front follow `pr.merge`: the cached detail is used unless it would refuse
  (or the client showed another head); then one fresh fetch decides, and it must
  succeed. Refused: not open, already in the requested state, auto-merge on a draft,
  the repository not allowing auto-merge or the method. Everything else is GitHub's
  call, relayed with its message (FORBIDDEN stays PERMISSION_DENIED).
- Turning auto-merge on while it is on with another method is refused ("turn it off
  first"), not switched behind the user's back. What GitHub does with a second enable
  was not tried against a real pull request.
- GitHub refuses auto-merge on a pull request it could merge right away with
  "Pull request Pull request is in clean status" (sic). The store keeps the text and
  says what to do: "can be merged now, so GitHub will not wait to auto-merge it (…);
  merge it instead".
- `expectedHeadOid` exists on `EnablePullRequestAutoMergeInput` (checked by schema
  introspection), so auto-merge is guarded by the head exactly like a merge: a moved
  head is refused by GitHub ("Head branch was modified") and mapped to the same message.
- No write memo (unlike merge and revert): repeating one of these is harmless, and the
  repeat is refused as already done once the detail shows it. They share the per-pull
  request merge lock, so a merge and an auto-merge change never interleave.
- After a change, or a refusal in the pull request's state, or no answer: the detail is
  invalidated (`PullRequestDetailUpdated`, the open panel re-reads and that read
  fetches) and the poll runs soon (the dashboards show drafts).
- Only turning auto-merge on asks for confirmation (it merges with no further human
  step, like `pr.merge`); off, ready and draft do not. A request Run would refuse
  (no method, `--off` with a method) is refused without asking first.
- `auto_merge_allowed` is a plain bool: a cached row from before this change reads
  false. Rows read back from SQLite start stale, so the panel's first read refetches,
  and the store refetches before refusing anyway.

## Manual links

- Parsed in the thread store (`ParsePullRequestLink`, now also behind
  `ParsePullRequestTarget`): a github.com pull request URL (anything after the number
  ignored) or `owner/name#N`; issues, other hosts and bare slugs are INVALID_ARGUMENT.
  The slug keeps the case as typed and the URL is the canonical
  `https://github.com/<slug>/pull/<n>`.
- Dedup compares URLs case-insensitively against the thread's links (Claude's records
  and GitHub's URLs keep GitHub's case, a typed reference may not). A known one returns
  the existing row (its source, e.g. `claude`) with `linked` false and publishes
  nothing: first source wins.
- Copied up the CreatedBy chain like every link. Never dropped: member removal and
  `SettleBranchLinks` only touch `branch` rows.
- `thread_pull_requests.source` is unconstrained TEXT (migration 0039), so `manual`
  needs no migration. The source is still not on the API (`LinkedPullRequest` has no
  field for it).

## Gotchas

- The code-foundry repository itself has "Allow auto-merge" off on GitHub (checked with
  a GraphQL read): its detail reports `auto_merge_allowed` false, so the GUI should say
  why there is no Auto-merge rather than hide it silently.
- The guide's soft size limit (`internal/guide/topics_test.go`) went from 25,650 to
  25,900 bytes: three `pr.*` names in the topic list plus `thread.pr.link`, which the
  guide lists in full with the other Thread verbs. Its description was cut short for it.

## Verification

- Go table tests: the store mutations against the fake GitHub
  (`pr_draft_test.go`: refusals before and after a fresh look, the clean status, head
  guards, FORBIDDEN, events, the detail afterwards), decoding, the API mapping
  (`gh_draft_test.go`), the commands (`commands_pr_state_test.go`,
  `commands_thread_prlink_test.go`), and the manual link (`prlink_manual_test.go`:
  parsing, dedup, first source wins, propagation, persistence across a restart).
- Scratch daemon (`CODE_FOUNDRY_HOME` under /tmp) and the CLI: `pr.ready`, `pr.draft`,
  `pr.auto-merge` (on and off) refused cleanly for an unknown repository, bad args, and
  a merged pull request (refused before any mutation); `pr.refresh --json` shows the
  new fields; `thread pr link` on a scratch no-project thread linked a URL, answered a
  differently cased repeat quietly, refused an issue URL and an unknown thread, and the
  rows read back with source `manual`. No mutation was sent to GitHub.
- Mock daemon: the same verbs over Connect (state flips, the refusals listed in the
  mock header, `thread.pr.link` and `ThreadService.LinkPullRequest`).
