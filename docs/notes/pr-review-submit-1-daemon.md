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

`$id` is the pull request's node id. As with revert and merge, it comes from the cached
detail (`FullPullRequest`), so a panel that is showing the PR costs no extra request. A
CLI call on an uncached PR fetches the detail once. A detail served stale with
`last_error` still has the id, which never changes.

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
  * Bodies over 65536 bytes are refused. GitHub's limit is in characters, so counting
    bytes is stricter, and that is safe.
  * An UNSPECIFIED or unknown event is refused: the handler checks the proto enum and
    the store checks the string.
  * The commands check the same rules first, so the CLI can name the arg ("body is
    required to request changes").
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
    locked)
  * the outcome is unknown

  A PERMISSION_DENIED or rate-limit refusal leaves the detail alone. Merge used a
  closure variable read after `submitFunc`, which races when the caller's context ends
  first. The new code does not do that.
* **No 2-minute memo.** Revert and merge remember outcomes so that a repeat cannot open
  a second PR or merge twice. A duplicate comment is only noise, and a person may well
  post the same short text twice on purpose. So:
  * identical writes queued at once coalesce: the job id is `review|EVENT|slug#n|<sha256
    prefix of the body>` or `comment|slug#n|<…>`, never the body itself
  * after a timeout the error says the write may have been posted
  * the GUI should disable its button while a write is in flight
* **Poll soon after a review.** A review moves the PR between the viewer's dashboards
  (awaiting review → reviewed). A comment does not, so it does not poll.
* **Bodies stay out of the debug log.** `callDoc` logs a request's variables at debug
  level. `loggedVars` replaces a string `body` with `<N bytes>`. Without it, the
  smoke test logged the review text.

## Tests

* `pr_review_test.go`:
  * `NormalizeReview` and `NormalizeComment` tables: every event, blank bodies,
    trimming, exactly 65536 bytes and one over, and bytes counted rather than runes
  * decoders from the `testdata/add_pull_request_review_synthetic.json` and
    `add_comment_synthetic.json` fixtures, plus null and malformed shapes
  * `writeRefused`, from `add_pull_request_review_own_synthetic.json` and every type
  * every variable declared in the two documents is used, and every variable sent is
    declared
  * store tables against the fake GitHub, checking:
    * the sent vars (an empty approval sends null)
    * self-approval refused by GitHub
    * an untyped refusal, FORBIDDEN, and RATE_LIMITED
    * 502 and network errors (the "may have been posted" message)
    * unknown PRs and bad input, which send no mutation
    * which outcomes send the detail event
  * a posted comment appears in the next read, and the mutation reused the cached node id
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
  positional order. Also the requests sent, the messages, arg errors naming `body`,
  `number` or `verdict`, and backend codes passed through.
* `commands_test.go`: the full command list includes `pr.review` and `pr.comment`.

## End to end (2026-10-15, scratch daemon `CODE_FOUNDRY_HOME=/tmp/cf-review-home`, Alex's gh)

| Call | Result |
|---|---|
| `pr review --help`, `pr comment --help` | usage `pr review <repo-slug> <number> [<body>]` with `--verdict approve\|request-changes\|comment`; `pr comment <repo-slug> <number> <body>` |
| `pr comment alexwaumann/code-foundry 1 "   "` | `body is required`, exit 2, no request |
| `pr review … 1 --verdict comment` | `body is required to comment`, exit 2 |
| `pr review … 1 --verdict lgtm` | `argument "verdict": want one of approve, request-changes, comment` |
| `pr review … 999999 --verdict approve`, `pr comment … 999999 hello` | `not found on github: Could not resolve to a PullRequest with the number of 999999.` (detail fetch; no mutation) |
| buf curl `SubmitPullRequestReview` without event | `invalid_argument: event is required: approve, request changes, or comment` |
| buf curl REQUEST_CHANGES with a blank body | `invalid_argument: invalid argument: a body is required` |
| buf curl `AddPullRequestComment` with 65537 bytes | `invalid_argument: … the body is 65537 bytes, GitHub accepts at most 65536` |
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
