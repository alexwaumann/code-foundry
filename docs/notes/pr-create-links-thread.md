# pr.create links its pull request to the thread (2026-11-16)

A thread that runs `code-foundry pr create` now has the pull request linked at once. Before,
it was linked only if Claude Code happened to write a `pr-link` record to its transcript
(`linked-prs.md`), later by the branch match (`linked-prs-branch.md`), or by hand with
`thread pr link` (`pr-daemon-actions.md`). An agent can now rely on the link right after the
command returns.

## What changed

- `internal/command/pr_link_caller.go`: `linkCallerPR` calls
  `ThreadService.LinkPullRequest` (the path `thread.pr.link` uses) for
  `Context.CallerThreadID` and the URL the command got back; `withThreadLink` adds the
  result to the command's message and JSON.
- `pr.create` (`commands_gitops.go`, `GitOpsDeps.Link`, which `all.Register` fills with
  the thread backend) links after a successful create, and also when `gh` answers that
  the branch's pull request already exists (the store returns that one's URL).
- `pr.revert` (`commands_pr.go`, `RegisterPullRequest` takes the link backend) links the
  revert pull request it opens the same way.
- Mock: `pr.create` links to the context's thread (`MockGitOps.entries`'s `linkPR`,
  `World.linkCallerPR`). The mock's `pr.revert` does not link.
- Skill `code-foundry`: `pr.create` links its own pull request; use it, not
  `gh pr create`.

## Decisions

- **Which thread.** `CallerThreadID`: the thread whose CLI ran the command
  (`$CODE_FOUNDRY_THREAD`), or, from the app, the selected thread (the palette or a
  button with a thread selected; the Projects page's rows send no thread). A page's call
  carries its thread, so it links there too. No thread: nothing is linked, as before.
  `pr.create` has no thread argument, so `CallerThreadID` and `ActiveThreadID` agree.
- **Source `manual`, no new one.** The rows the daemon may remove are `branch` (a member
  leaving, `SettleBranchLinks`) and `child` copies that go with them. `manual` is never
  removed, and `LinkPullRequest` already turns an existing `branch` or `child` row into
  `manual` (`keepManualLocked`), which is right here: the thread made the pull request, so
  the link must outlive its branch row. A new source would behave exactly like `manual`
  and nothing reads the difference (the source is not on the API). Dedup by URL ignoring
  case and the copy up the `CreatedBy` chain come with the path.
- **Failure.** A failed link never fails the command: the pull request exists. It is
  logged (`slog.Warn`), the message gets `could not link <url> to thread <id>: <why>`,
  and the JSON's `threadLink.error` says why. A create with no URL in gh's output links
  nothing (nothing to link); a failed create links nothing.
- **Result.** The message gets a second line in `thread.pr.link`'s words:
  `linked owner/name#N to thread <name> (<id>)`, or `thread <name> (<id>) already has
  owner/name#N linked`. The JSON stays the op (or `pr.revert`'s response) with one more
  field, `threadLink` (`threadId`, `linked`, `slug`, `number`, `url`, `error`), so a reader
  of the existing fields sees no change; it is absent when nothing was linked.
- **Other verbs checked.** `pr.revert` opens a pull request and left the thread unlinked
  the same way: fixed. `pr.task`, `pr.fix.findings`, `pr.ask` and `pr.explain` open no
  pull request: they start (or message) a thread about an existing one, in its head's
  worktree when there is one (the branch link) with the URL in the prompt (Claude's
  `pr-link` record covers a pull request named in the prompt). Left as they are.
  `project.github.publish` makes a repository, not a pull request.
- **The log line** of `LinkPullRequest` still reads "pull request linked by hand"; it is the
  same path and the thread id and URL say which.

## Verified

- `internal/command/pr_link_caller_test.go` (tables): `pr.create` with no thread, a
  thread's CLI, the app's selected thread, an existing pull request already linked and not
  yet linked, a failed link, no URL, a failed create; `pr.revert` with and without a thread.
  JSON keeps the op's fields and adds `threadLink`.
- `mock/world.test.ts`: the mock's `pr.create` links once, says so the second time, and
  links nothing without a thread.
- End to end with a dev daemon on a scratch `CODE_FOUNDRY_HOME`, a scratch repository
  whose origin reads as `github.com/me/repo` and pushes to a local bare repository, and a
  fake `gh` first on `PATH` (no GitHub call): from a thread's CLI the message said
  `linked me/repo#4 to thread prlink-e2e (s-…)` and `thread get` listed it; the
  "already exists" answer gave `threadLink.linked: false`; outside a thread nothing was
  linked; a stale `$CODE_FOUNDRY_THREAD` printed `could not link … thread not found` with
  exit 0; a child thread's `pr create` linked #5 to the child and its creator.
