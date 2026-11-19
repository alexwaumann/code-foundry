# Close, reopen and copy branch name (PR page redesign, daemon slice)

The daemon, mock and store side of three actions the redesigned ⋯ menu on the pull
request page gains: Close pull request, Reopen pull request, Copy branch name. The menu
items themselves land in a later PR (another worker owns `PrMenu.tsx`).

## What shipped

- `GhService.SetPullRequestClosed` (`closed` true/false: GitHub's `closePullRequest` /
  `reopenPullRequest`), answering the state GitHub reports afterwards and a message.
  Store: `internal/store/gh/pr_close.go`; API: `internal/api/gh_close.go`.
- `PullRequestDetail.viewer_can_close` / `viewer_can_reopen` (GitHub's `viewerCanClose`
  and `viewerCanReopen`, selected in `pull_request_full.graphql`), mapped to
  `viewerCanClose` / `viewerCanReopen` in `src/api/gh.ts`.
- Commands `pr.close` (confirmed) and `pr.reopen`
  (`internal/command/commands_pr_close.go`), NoPalette like every `pr.*` verb, PageState
  like `pr.ready`/`pr.draft`. CLI: `code-foundry pr close|reopen <owner/name> <n>`.
- `src/stores/prClose.ts`: `closePullRequest(ref, source?)`, `reopenPullRequest(ref, source?)`
  with a busy flag per pull request (`usePrCloseStore.closing`, `usePullRequestClosing`),
  `canClosePullRequest(detail)` / `canReopenPullRequest(detail)`, and
  `copyPullRequestBranch(branch)`.
- Mock (`mock/prDetail.ts`, `mock/server.ts`) and the vitest fake world
  (`src/test/prWorld.ts`): the same verbs and RPC with the daemon's refusals.

## Decisions

- One RPC with a bool, as `SetPullRequestDraft`: closed/open is one setting.
- Permission is GitHub's own `viewerCanClose` / `viewerCanReopen`, not derived from
  `viewer_permission`: a pull request's author may close and reopen it with read access
  only, which the repository permission does not say. Checked on real pull requests:
  `viewerCanClose` is true on a merged pull request too (it is a permission, not a state
  check), `viewerCanReopen` is false unless it is closed and unmerged. So the helpers
  check the state first, then the flag.
- Refusals up front follow `pr.draft` (`freshFor`): closing what is not open ("is
  closed, not open", "is merged, not open"), reopening what is open ("is already open")
  or merged ("a merged pull request cannot be reopened") are FAILED_PRECONDITION; a
  viewer without the flag is PERMISSION_DENIED with "it takes the author, or triage
  access or more". A cached copy that would refuse, or lacks the flag, gets one fresh
  look first (a row cached before this change reads both flags false, so the first
  close or reopen on it refetches rather than refusing).
- Same merge lock, worker, `stateWrite` (detail invalidated on success, a refusal in the
  pull request's state, or no answer) and `pollSoon` as the draft change, so every
  surface re-reads at once and the dashboards follow soon. No write memo: a repeat is
  refused as already done once the detail shows it.
- `pr.close` asks, naming the pull request by its title from the cached detail ("Close
  #N “title” in owner/name without merging it? It can be reopened later."; the static
  "Close #N in owner/name without merging it?" when there is no detail), with the button
  "Close pull request". Bad args are refused without asking (`ConfirmIf`). `pr.reopen`
  does not ask.
- Copy branch name mirrors `copyPullRequestLink`: a store function, not a command, with
  its toast ("Branch name copied"). Copy link's chord belongs to the surface's `onKey`;
  nothing in its pattern requires a second chord, so none was added.
- The busy flag is its own store (`prClose.ts`) rather than a new `PrChange` in
  `prPanel.ts`, so this slice does not edit the parts of that file another worker is
  changing. The only edit there is `export` on `settled`. The daemon serialises a close
  with a draft or auto-merge change anyway (the merge lock).
- Success is toasted with the daemon's message unless the caller passes `inView`; the
  menu will leave it (a menu closes onto the page, which shows the new state).

## Gotchas

- GitHub answers `closePullRequest` on an already closed pull request without an error
  (the fake does the same), so the store's own refusal is what says "is closed". When
  the cached copy says open but GitHub merged it meanwhile, the mutation goes out and
  the message reports GitHub's state ("GitHub accepted closing it (#1), but reports it
  merged").
- A scratch daemon's `CODE_FOUNDRY_HOME` under the session scratchpad is too long for
  the socket path (103 bytes on macOS): use a short `/tmp/cf-…` directory.

## Verification

- Go: `pr_close_test.go` (every refusal before and after a fresh look, the stale
  permission refetch, FORBIDDEN, GitHub's other refusals, events, the detail afterwards,
  decoding), `gh_close_test.go` (API mapping, codes, the detail's new fields),
  `commands_pr_close_test.go` (requests, the confirmation with and without a title,
  refusals passed through, bad args without asking).
- vitest: `src/stores/prClose.test.ts` (busy until the detail settles, a second call
  sends nothing, failures toasted and freeing at once, quiet with `inView`, the
  allowed-when table, copying).
- Scratch dev daemon (`make drive DAEMON=dev DRIVE_HOME=/tmp/cf-close.XXXX`) and the CLI,
  refusals only so nothing was sent to GitHub: `pr close` on a merged pull request asked
  with its title, then with `--yes` was refused as merged; `pr reopen` on it was refused;
  `pr close` on a closed one was refused as closed; on another owner's repository both
  were PERMISSION_DENIED from the flags; `pr refresh --json` showed `viewerCanClose` and
  `viewerCanReopen` on a closed one.
- Mock (`make drive`) through the GUI's store actions (`window.__cfModule`) and the real
  confirm dialog: #142 asked with its title, closed after "Close pull request", read back
  closed with `viewerCanReopen`; reopened without a question; a second reopen toasted
  "already open"; #140 (read access) toasted the permission refusal. The mock's
  invocation log showed each call.
