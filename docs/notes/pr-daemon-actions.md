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
  (no method, `--off` with a method, a `--head-sha` that is not a full commit SHA) is
  refused without asking first. The SHA check is the daemon's own (`gh.IsCommitSHA`,
  exported for it), run in the command too so the question is never asked for a
  request the daemon would refuse.
- `auto_merge_allowed` is a plain bool: a cached row from before this change reads
  false. Rows read back from SQLite start stale, so the panel's first read refetches,
  and the store refetches before refusing anyway.

## Manual links

- Parsed in the thread store (`ParsePullRequestLink`, now also behind
  `ParsePullRequestTarget`): a github.com pull request URL (anything after the number
  ignored) or `owner/name#N`; issues, other hosts and bare slugs are INVALID_ARGUMENT.
  The URL is `https://github.com/<slug>/pull/<n>`. The slug is GitHub's (the one in
  the URL the GitHub store's cache has, through `Options.PullRequest`: GitHub's case
  and current name) when the cache holds the pull request, else as typed.
- Every place that deduplicates links compares URLs case-insensitively
  (`thread.SamePullRequestURL`): `mergeLinks` (Claude's records, branch links, child
  copies up the chain, the startup child fold), the daemon's branch matcher, and the
  manual link. Before, only the manual link did, so `thread pr link O/R#5` followed by
  Claude's record or the branch match for `o/r/pull/5` left a second row on the thread
  and on every creator, for good. A known pull request returns the existing row with
  `linked` false and publishes nothing: first source wins, with one exception below.
- `loadLinks` keeps the first row per URL ignoring case. Before this change only
  Claude's records could differ in case from the GitHub store's URLs (a record for a
  pull request named in a prompt), so case duplicates on disk are unlikely but
  possible; a read-time dedup is cheap and destroys nothing, so no migration. The later
  row stays on disk unread (it reappears only if the first is removed, and it is a real
  link from another source).
- A manual link over a row the daemon may remove (`branch`: member removal,
  `SettleBranchLinks`; `child`: removed up the chain with a settled branch link) makes
  that row `manual` (via and head cleared, persisted). Source, via and head are not on
  the API, so nothing is published; the snapshot is rebuilt. A `claude` row stays
  `claude` (never removed). So the user's explicit link is never dropped.
- Copied up the CreatedBy chain like every link. A creator that already had the pull
  request as its own `branch` row keeps that row (first source wins at each hop).
- `thread_pull_requests.source` is unconstrained TEXT (migration 0039), so `manual`
  needs no migration. The source is still not on the API (`LinkedPullRequest` has no
  field for it).

## Gotchas

- The code-foundry repository itself has "Allow auto-merge" off on GitHub (checked with
  a GraphQL read): its detail reports `auto_merge_allowed` false, so the GUI should say
  why there is no Auto-merge rather than hide it silently.
- The guide's soft size limit (`internal/guide/topics_test.go`) went from 25,700 to
  25,950 bytes (25,888 used, on top of main's pr.task): three `pr.*` names in the topic
  list plus `thread.pr.link`, which the guide lists in full with the other Thread verbs.
  Its description was cut short for it.

## Verification

- Go table tests: the store mutations against the fake GitHub
  (`pr_draft_test.go`: refusals before and after a fresh look, the clean status, head
  guards, FORBIDDEN, events, the detail afterwards), decoding, the API mapping
  (`gh_draft_test.go`), the commands (`commands_pr_state_test.go`,
  `commands_thread_prlink_test.go`), and the manual link (`prlink_manual_test.go`:
  parsing, dedup, first source wins, propagation, persistence across a restart; every
  order of a manual link in another case, Claude's record and the branch link leaves
  one row on the thread and one on its creator; GitHub's slug from the cache; a manual
  link over a branch row and a child copy survives `SettleBranchLinks` and member
  removal; case duplicates on disk read back as one). The branch matcher skips a URL
  linked in another case (`linked_prs_branch_test.go`).
- Scratch daemon (`CODE_FOUNDRY_HOME` under /tmp) and the CLI: `pr.ready`, `pr.draft`,
  `pr.auto-merge` (on and off) refused cleanly for an unknown repository, bad args, and
  a merged pull request (refused before any mutation); `pr.refresh --json` shows the
  new fields; `thread pr link` on a scratch no-project thread linked a URL, answered a
  differently cased repeat quietly, refused an issue URL and an unknown thread, and the
  rows read back with source `manual`. No mutation was sent to GitHub.
- Mock daemon: the same verbs over Connect (state flips, the refusals listed in the
  mock header, `thread.pr.link` and `ThreadService.LinkPullRequest`).
