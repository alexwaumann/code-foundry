# Pull request reviews and comments, 1: daemon

Status: proto, store, API and commands. The GUI (review composer, comment box, mock
daemon) is the next PR. `make check` is green. Real GitHub ran only the refusal paths,
on this PR (#120) through a scratch daemon. Successful reviews and comments ran against
the fake GitHub, `ghtest`, and `commandtest`. Nothing was posted on GitHub.

## RPCs (GhService, additive)

| RPC | GitHub | Cache |
|---|---|---|
| `SubmitPullRequestReview(repo_slug, number, event, body)` → id, url, state, author, submitted_at | `queries/add_pull_request_review.graphql` | invalidates the detail (event); polls soon |
| `AddPullRequestComment(repo_slug, number, body)` → id, url, created_at | `queries/add_comment.graphql` | invalidates the detail (event) |

`PullRequestReviewEvent` is APPROVE, REQUEST_CHANGES, COMMENT, without GitHub's DISMISS.
The response reuses `PullRequestReviewState`.

```graphql
mutation AddPullRequestReview($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $id, event: $event, body: $body }) {
    pullRequestReview { id url state submittedAt author { login } }
  }
}

mutation AddComment($id: ID!, $body: String!) {
  addComment(input: { subjectId: $id, body: $body }) {
    commentEdge { node { id url createdAt } }
  }
}
```

`$id` is the pull request's node id. It never changes, so `nodeID` reads it from the
cached detail (memory, then SQLite) whatever the entry's age or staleness. A panel that
is showing the PR, or showed it last week, costs no extra request. Only a PR with
nothing cached is fetched (one `pull_request_full`), and that fetch must succeed: its
error fails the write. Review fix 3 changed this. The first cut went through
`FullPullRequest`, which refetched an aged entry and wrote even when that fetch failed.

## Commands

| Command | Args | Result |
|---|---|---|
| `pr.review` | `repo-slug`, `number`, `[body]` (positional), `--verdict approve\|request-changes\|comment` (required) | "Approved #N", "Requested changes on #N", "Commented on #N (review)" |
| `pr.comment` | `repo-slug`, `number`, `body` (positional, required) | "Commented on #N" |

Both have `When: hasPullRequest` and no confirmation. They are registered from
`RegisterPullRequest` through `reviewCommands` (`commands_pr_review.go`), the same way
`pr.merge` comes from `commands_pr_merge.go`. On the CLI:
`code-foundry pr review o/r 7 "LGTM" --verdict approve`.
`pr review request …` still resolves to `pr.review.request`, because the CLI matches
the longest command name and a slug always contains a slash.

## Decisions

* **Validation (INVALID_ARGUMENT)** is in `gh.NormalizeReview` and `gh.NormalizeComment`.
  The ghtest fake uses the same two functions.
  * The body is trimmed.
  * A body is required for REQUEST_CHANGES, COMMENT, and a plain comment. It is
    optional for APPROVE. An approval with no text sends `body: null`, not `""`.
  * Bodies over 65536 characters (`MaxCommentChars`, counted with
    `utf8.RuneCountInString`) are refused. GitHub's message is "Body is too long
    (maximum is 65536 characters)". The first cut counted bytes, which refused long
    non-ASCII text that GitHub accepts (review fix 2).
  * An UNSPECIFIED or unknown event is refused: the handler checks the proto enum and
    the store checks the string.
  * The commands do not repeat these checks: `pr.review` and `pr.comment` send the body
    as typed, and the daemon's INVALID_ARGUMENT comes back (review fix 6).
* **GitHub decides who may review.** The daemon does not check authorship, write access
  or state. A merged PR can still get a comment or a COMMENT review. The GUI hides the
  buttons that make no sense.
* **Error mapping** goes through `writeRefused` (`pr_review.go`). It is the generic part of
  merge's refusal mapping, which `mergeRefused` now calls before its head and base
  checks.

  | GitHub | Connect |
  |---|---|
  | UNPROCESSABLE ("Review Can not approve your own pull request"), no type, an unknown type | FAILED_PRECONDITION with GitHub's message |
  | FORBIDDEN | PERMISSION_DENIED (as merge; a 403 over HTTP is too) |
  | NOT_FOUND | NOT_FOUND |
  | RATE_LIMITED | RESOURCE_EXHAUSTED |
  | 502/504, network error | UNAVAILABLE: "GitHub did not confirm the review, and it may have been posted; check GitHub before trying again" |

  The brief asked for "no write access" to come back as FAILED_PRECONDITION. I followed
  merge instead: GitHub's FORBIDDEN stays PERMISSION_DENIED. For a public repository,
  any viewer can review and comment, so FORBIDDEN means a token or SSO problem, not a
  refusal by policy. GitHub's own refusals, such as self-approval, are typed
  UNPROCESSABLE and become FAILED_PRECONDITION.
* **Invalidation runs on the worker**, after GitHub has answered. A caller that gave up
  waiting still leaves clients re-reading. The detail is invalidated, and
  `pull_request_detail_updated` sent, in three cases:
  * the write succeeded
  * GitHub refused it with FAILED_PRECONDITION (the PR may have changed: closed or
    locked) or NOT_FOUND (deleted since it was cached; review fix 4)
  * the outcome is unknown

  A PERMISSION_DENIED or rate-limit refusal leaves the detail alone. Merge used a
  closure variable read after `submitFunc`, which races when the caller's context ends
  first. The new code does not do that.
* **The same write within 2 minutes posts once** (review fix 1). The first cut only
  coalesced jobs that were still queued together. The worker pops a job off the queue
  before running it, so a double click, or a retry after the caller gave up waiting,
  arriving while the first was in flight posted a second review.
  * The memo key is the pull request plus `review|EVENT` or `comment` plus a sha256
    prefix of the trimmed body. Memos are `writeMemos[writeKey, T]`: `writeMemos` gained
    a key type parameter, and revert and merge use `fullKey`.
  * The memo is checked before submitting, then checked again and written on the
    serial worker. A duplicate queued behind the first runs after it and finds its
    outcome.
  * A success is remembered, with its result.
  * An unknown outcome (502/504, network, deadline) is remembered as its error. The
    error says the write may have been posted and that the same text gets this error
    until the window ends.
  * A posted write whose answer could not be decoded is remembered as an error too, so
    it is never posted again.
  * Refusals are not remembered: nothing was posted.
  * Different text, another verdict, a plain comment against a COMMENT review, or
    another pull request all post.
  * Posting the very same text twice within `writeMemoTTL` (2 minutes) returns the
    first comment. That is deliberate.
  * The job id still carries the hash, never the body.
* **Poll soon after a review.** A review moves the PR between the viewer's dashboards
  (awaiting review → reviewed). A comment does not, so it does not poll.
* **Bodies stay out of the debug log.** `callDoc` logs a request's variables at debug
  level. `loggedVars` replaces a string `body` with `<N bytes>`. Without it, the
  smoke test logged the review text.

## Tests

* `pr_review_test.go`:
  * `NormalizeReview` and `NormalizeComment` tables: every event, blank bodies,
    trimming, exactly 65536 characters and one over, and characters counted rather
    than bytes (65536 × "é" and 65535 × "🙂" pass)
  * decoders from the `testdata/add_pull_request_review_synthetic.json` and
    `add_comment_synthetic.json` fixtures, plus null and malformed shapes
  * `writeRefused`, from `add_pull_request_review_own_synthetic.json` and every type
  * every variable declared in the two documents is used, and every variable sent is
    declared
  * store tables against the fake GitHub, checking:
    * the sent vars (an empty approval sends null)
    * self-approval refused by GitHub
    * an untyped refusal, FORBIDDEN, and RATE_LIMITED
    * NOT_FOUND after caching (detail invalidated)
    * 502 and network errors (the "may have been posted" message)
    * unknown PRs and bad input, which send no mutation
    * which outcomes send the detail event
  * a posted comment appears in the next read, and the mutation reused the cached node id
  * `TestReviewWritesIdempotent` table, where each row sends two writes:
    * the same comment or review again (also with other whitespace): 1 mutation, same
      answer
    * other text, another PR, another verdict, a review against a comment: 2
    * the same text after the window: 2
    * a refusal: 2
  * `TestReviewWriteOutcomeUnknownRemembered`: a 504 answers repeats with its error for
    the window, other text goes through, and the same text posts after the window
  * `TestReviewWriteDuplicatesInFlight`: the first caller cancels while its mutation is
    in flight, then four concurrent retries arrive. One mutation is sent and all four
    get `PRR_1`.
  * `TestReviewWriteNodeID`: an aged and stale cache sends no detail fetch, an uncached
    PR is fetched once, and a failed fetch sends no mutation
  * `loggedVars`
* `fakegithub_review_test.go`: the fake GitHub answers both mutations, including
  self-approval and refusals.
* `internal/api/gh_review_test.go`: both RPCs over Connect, checking:
  * every response field
  * the event mapping, with UNSPECIFIED rejected before the store is called
  * each code: INVALID_ARGUMENT, NOT_FOUND, FAILED_PRECONDITION with GitHub's message,
    PERMISSION_DENIED, RESOURCE_EXHAUSTED
  * the Watch event
  * the comment in the re-read detail
* `internal/command/commands_pr_review_test.go`: availability, no confirmation, and the
  positional order. Also:
  * the requests sent, with the body as typed
  * the messages
  * arg errors for `number` and `verdict`, which the Enum rejects
  * the daemon's INVALID_ARGUMENT for a missing body, and other backend codes, passed
    through
* `commands_test.go`: the full command list includes `pr.review` and `pr.comment`.

## End to end (2026-10-15, scratch daemon `CODE_FOUNDRY_HOME=/tmp/cf-review-home`, Alex's gh)

| Call | Result |
|---|---|
| `pr review --help`, `pr comment --help` | usage `pr review <repo-slug> <number> [<body>]` with `--verdict approve\|request-changes\|comment`; `pr comment <repo-slug> <number> <body>` |
| `pr comment alexwaumann/code-foundry 1 "   "` | `body is required`, exit 2, no request (before review fix 6; now the daemon answers `invalid argument: a body is required`) |
| `pr review … 1 --verdict comment` | `body is required to comment`, exit 2 (likewise, now the daemon's message) |
| `pr review … 1 --verdict lgtm` | `argument "verdict": want one of approve, request-changes, comment` |
| `pr review … 999999 --verdict approve`, `pr comment … 999999 hello` | `not found on github: Could not resolve to a PullRequest with the number of 999999.` (detail fetch; no mutation) |
| buf curl `SubmitPullRequestReview` without event | `invalid_argument: event is required: approve, request changes, or comment` |
| buf curl REQUEST_CHANGES with a blank body | `invalid_argument: invalid argument: a body is required` |
| buf curl `AddPullRequestComment` with 65537 × "x" | `invalid_argument: … the body is 65537 bytes, GitHub accepts at most 65536` (before review fix 2; the message now says characters) |
| `pr review alexwaumann/code-foundry 120 --verdict approve` (own PR) | `failed precondition: Review Can not approve your own pull request` (GitHub typed it UNPROCESSABLE; 650 ms) |
| `pr review … 120 "needs work" --verdict request-changes` (own PR) | `failed precondition: Review Can not request changes on your own pull request` |
| afterwards | #120 has 0 reviews and 0 comments; the second call refetched the detail (the refusal had invalidated it) |

## Gotchas

* GitHub's messages begin with "Review " ("Review Can not approve your own pull
  request"). They are passed through unchanged.
* `go test` outside `make` in a fresh worktree fails to link: a stale pkg-config entry
  points at another worktree's `libghostty-vt.a`. Run `make ghostty-vt` once, then set
  `PKG_CONFIG_PATH=$PWD/third_party/ghostty-vt/share/pkgconfig` (the Makefile does
  this).
* The CLI gets command help from the daemon. An installed daemon that is older than the
  binary answers `unknown command "pr review"`. Use a scratch `CODE_FOUNDRY_HOME`.

## Review fixes (2026-10-15)

1. A duplicate sent while the first was in flight posted twice: the queue only
   coalesced jobs that were waiting together. It now uses a per-write memo checked on
   the worker (above).
2. The 65536 limit counted bytes; GitHub counts characters.
3. The node id came through `FullPullRequest`, which could run the heavy detail query
   and wrote even when that fetch failed. It now comes from the cache at any age, with
   one fetch only when nothing is cached, and that fetch must succeed.
4. A NOT_FOUND refusal left the cached detail alone; it is invalidated now.
5. `pr.review` had a dead branch for an unknown verdict, which the Enum arg already
   rejects. Removed.
6. The commands repeated the daemon's body checks. Removed: the daemon's
   INVALID_ARGUMENT passes through.
