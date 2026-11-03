# pr.task: the pull request panel's "have the thread handle it" actions

PR C of the pull request panel redesign: the daemon side of the readiness box's issue
rows ("Fix in this thread", "Address in this thread", "Resolve in this thread", "Update
in this thread", "Review in new thread"). The GUI wiring follows in its own PR.

Code: `internal/command/commands_prtask.go` (the command and its routing),
`internal/command/prtaskprompt.go` (one pure prompt builder per kind), shared machinery in
`commands_prthread.go` (`readPR`, `checkPRPromptSize`, `pickPRWorktree`,
`createPRWorktree`). Mock: `gui/frontend/mock/prTask.ts`.

## Command

`code-foundry pr task <repo-slug> <number> <kind> [--thread <id> | --worktree <path>] [--model] [--effort] [--focus]`

| kind | Task | Pushes | Detail refreshed |
|---|---|---|---|
| `checks` | fix the failing (and cancelled, timed out, ...) checks | yes | yes |
| `review` | address the reviews requesting changes | yes | yes |
| `conversations` | address the unresolved review threads, reply, resolve settled ones | yes | yes |
| `conflicts` | resolve conflicts with the base | yes | yes |
| `behind` | bring the branch up to date when the repository requires it | yes | yes |
| `review-request` | review someone's pull request, read-only, submit nothing | no | no |

* Registered by `RegisterPullRequestThreads` with pr.ask, pr.explain and pr.fix.findings,
  NoPalette like them (palette_test.go), category "Pull Request". The kinds are a map
  (`prTasks`), not a switch.
* `pr.task` is in `threadStarters` (`internal/daemon/settings.go`): model and effort
  default from the thread settings, as for its siblings. The guide lists it on its own
  (the guide size check moved to 25,700 bytes).
* Result JSON (`PRTaskResult`): `{threadId, sent, projectId?, worktreePath?,
  createdWorktree?, cloned?}`. Messages: `Sent to <thread label>`, `Started thread <label>
  for PR #N`, or `Cloned <slug> and started thread <label> for PR #N`.

## Routing

* `--thread <id>` (routing rule 1, and the ▾ of rule 2): `Thread.Get` (an unknown id fails
  with NotFound before anything is sent), then `Thread.Send` with the follow-up prompt,
  exactly thread.send's path: delivered mid-turn when the thread works, a stopped thread
  starts with it. No focus intent: the window keeps its selection. From a thread's CLI
  the message carries `by_thread_id` (the caller), so the user's prompt history leaves it
  out, as thread.send's `--by`; from the GUI it is the user's own message.
* No `--thread` (rule 3): the projects are listed; a clone of the slug runs the task in
  the worktree on the head (`headWorktree`, the same match as fix.findings: a
  same-repository head by branch name, a fork's by commit or by a non-origin upstream),
  else creates one with `createPRWorktree` (fetch `origin/<head>` in the main worktree,
  `CreateWorktree` on the existing branch; a concurrent create re-lists and reuses).
* Rule 4: no project is a clone of the slug, so it is cloned first with the same
  `CloneFunc` as project.clone (`~/.code-foundry/projects/<owner>/<repo>`; the daemon
  wires `projectAPI.CloneRef`), no prompt and no confirmation. A clone the store returns
  without a slug gets the slug that was cloned. Before cloning, the placement is tried on
  a stand-in clone with no worktrees: a push task on a fork's pull request (or one with no
  head branch) is refused there, since a fresh clone could not place it either.
* A clone that fails (the destination folder exists but is not registered, gh fails)
  keeps its Connect code with the step named: `clone o/r: ...`. Not registering an
  existing folder automatically was deliberate: the folder may be something else.
* `--worktree` runs the thread in that worktree as is, as for the siblings (nothing is
  cloned or created; a project list failure only loses the checkout state in the prompt).
  It is refused together with `--thread`. It exists mainly so the fork refusal's advice
  ("check it out ... and pass --worktree") is true for pr.task too.

### Forks

* Push kinds keep fix.findings' rule (placement `prThreadFix`): a fork's head must already
  be checked out in some worktree of a clone (for example by `gh pr checkout N`), else
  FailedPrecondition with that advice. Code Foundry does not add fork remotes itself.
* `review-request` (new placement `prThreadReview`) needs no push: the head's worktree if
  one exists, else a new worktree for a same-repository head (rule 3), else (a fork, or no
  head branch) the project's main worktree **without switching it**. Its prompt then says
  so and has the agent read the code with `gh pr diff` / `gh pr view` and, for whole
  files, `git fetch origin pull/N/head` + `git show FETCH_HEAD:<path>`. Chosen over
  `gh pr checkout` in the main checkout, which would move the user's own branch.
* With `--worktree`, a review reads "off the head" unless that worktree is registered and
  on the head.

## Prompts

* Every prompt starts with the task and the pull request (`slug#N`, title, URL), then
  `head → base`, then where the checkout stands, then the untrusted-data notice;
  pull-request text is sanitized as in prprompt.go (`@` neutralized, control and format
  characters dropped, 1000-rune cap).
* New thread: push kinds get fix.findings' "make sure the checkout is up to date with
  `origin/<head>`" line (the fork variant names `gh pr checkout N --repo slug`), and the
  worktree's behind/dirty state. Follow-up (`--thread`): "Follow-up task: ..." and a line
  telling the agent the thread's checkout may be on another branch, to check
  `git branch --show-current`, switch if needed, and ask the user rather than move
  unrelated uncommitted work.
* `checks`: each failing check newest first with workflow, conclusion, description and
  URL; a GitHub Actions job URL (`.../actions/runs/<id>/...`) adds
  `gh run view <id> --log-failed --repo slug`. Flaky or unrelated failures are re-run,
  not "fixed".
* `review`: one entry per reviewer whose latest review requests changes (from
  `reviewers`), with that reviewer's latest CHANGES_REQUESTED summary and its inline
  comments (matched by `review_id`; resolved ones marked). A review's inline comments are
  capped at `maxFindings` lines in `maxFindingsBytes` (the worst-case test caught a
  190 KiB prompt without it). No GitHub replies unless the user asks.
* `conversations`: each unresolved review thread with its node id, `path:line`, the
  outdated mark and its comments (first and last two, as fix.findings). The agent fixes,
  pushes, then replies with `addPullRequestReviewThreadReply` and resolves the threads its
  change fully settles with `resolveReviewThread` (so the readiness row clears); the rest
  stay open for the reviewer.
* `conflicts` / `behind`: GitHub gives no file list. Fetch, then merge `origin/<base>`
  if the branch's history or the repository's docs show merges, otherwise rebase; tests;
  `--force-with-lease` after a rebase, a plain push after a merge.
* `review-request`: summary, concerns most serious first with file:line, a suggested
  verdict; read-only, nothing submitted or posted unless the user asks.
* Lists are capped like fix.findings (`maxFindings` items in `maxFindingsBytes`, then
  "N more were omitted."); `MaxPRPromptBytes` is checked before anything changes on disk
  (both off-head variants for a new thread). The worst case of every kind stays under
  128 KiB in tests.

## Mock daemon

`mock/prTask.ts` serves pr.task with the same result JSON and messages: `--thread` sends
through the mock's thread.send path (a user message then a short reply), otherwise the
head's worktree is reused or created, or the repository cloned first (into
`~/.code-foundry/projects/...` via `world.addClone`; `octo-org/already-here` is
AlreadyExists). New threads get the one-line stand-in prompt as their first message.
`POST /__mock/gh/pr-fail?command=pr.task` fails the next run with the fork refusal and
`pr-delay` delays it. A pull request in a repository that is no project:
`POST /__mock/gh/branch-pr?slug=octo-org/Hello-World&head=fix/typo&number=3`. Kept in its
own file so the parallel mock entries in `prDetail.ts` rebase cleanly.

## Verified end to end

Scratch daemon (`CODE_FOUNDRY_HOME=/tmp/...`) with `advanced.claude_path` set to a stub
that records its stdin and never answers, so no Claude turn ran:

* `pr task alexwaumann/code-foundry 493 review-request --thread <scratch>` and
  `... checks --thread <suffix>`: both landed as user messages in the scratch thread
  (`thread.items`), with the follow-up text above; `--json` printed `{"threadId", "sent":true}`.
* Refusals: an unknown thread (NotFound), an unknown kind, `--thread` with `--worktree`,
  and a fork's push task in a repository that is no project (`cli/cli`), refused before
  any clone (no projects folder was created).
* Rule 3 against a registered scratch repository whose origin is
  `ssh://git@github.com/alexwaumann/code-foundry.git` with a repo-local `core.sshCommand`
  serving `git-upload-pack` from a local bare repository (offline fetch, real slug): the
  first run fetched and created the worktree on `cf/move-test-flake`, the second reused it.
  (`url.insteadOf` does not work for this: `git remote get-url` applies it and the slug is
  lost.)

## Follow-ups

* GUI: wire the readiness rows to pr.task (rule 1 sends into the current thread, rule 2's
  ▾ passes `--thread`), toast the message, select the thread on `sent:false`.
* The provisional thread name comes from the first prompt line, so new threads read
  "Fix the failing checks on PR `o/r#7`…" until the namer renames them.
