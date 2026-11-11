# CI rethink: attestation is the PR check, the sweep gates tips (2026-11-11)

Five to ten agents work on this codebase at once and about a hundred pull requests merge
in a week. CI was slowing that down more than it was catching anything, so the checks moved
to where they pay: before the push on the agent's Mac, and after the merge on the merged
tree, with fast follow-up instead of a gate in between.

## What the week before showed (2026-11-04 to 2026-11-11, 114 merges)

| | Runs | Skipped by attestation | Green full run | Red | Cancelled |
|---|---|---|---|---|---|
| Pull requests | 186 | 107 | 47 (about 15 min) | 19 | 13 |
| Pushes to main | 114 | n/a | 50 (about 14 min) | 23 | 41 |

- Main was red in 23 of the 73 runs that finished, and 41 more were cancelled by the next
  merge (`cancel-in-progress`), so most merged commits never had a full run.
- By failing test name, about 30 of the 42 red runs were a dozen timing tests
  (`TestDictationAudioLostEndsTheSession` in 9 runs, the `internal/store/plugin` surface
  tests in 9).
- The real failures were on pull request branches that had not been attested, on things
  `make check` catches (the tooltip guard, `TestRenderPagesSkill`, `TestAllowedTools`,
  plugin view model tests).
- Main's runs caught at most one real break in 114 merges (not confirmed).
- Nothing told anyone main was red, and at that flake rate a real break looked like the rest.

## Decisions

- **A pull request's only check is `attested`.** Green when the head commit has a
  `local-check` status naming its tree (`make attest`, `docs/notes/ci-attest.md`), red
  otherwise. The suite does not run on a pull request and there is no fallback run: the
  fallback was the path that produced the flake reds. A clean-machine run of any branch is
  still one command away: `gh workflow run ci.yml --ref <branch>`.
- **`make attest` re-runs a red `attested`.** The job reads the status once. When the PR
  was opened or pushed before `make attest`, the job has failed or is about to; it takes
  seconds, so `attest.sh` waits for the run to finish and re-runs it unless it passed. This
  replaced the cancel-and-re-run of a 15 minute run. `make attest` before `gh pr create`
  needs none of it.
- **The sweep.** A push to main runs go-test, go-lint and frontend on the merged tree.
  Runs queue: one running, one pending, and a newer pending run replaces an older pending
  one, whose commits its tree includes. So a sweep always finishes, and at most about four
  an hour run instead of one per merge half of which were cancelled. It is the one check
  attestation cannot make: the tree two green pull requests produce together, from a clean
  checkout.
- **A green sweep publishes the tip; a red one publishes nothing.** `release.yml` starts
  on `workflow_run` of `ci` for main and releases the sweep's commit
  (`workflow_run.head_sha`), not the head of main, which may have moved on unchecked. The
  next green sweep covers every merge since. Tips were published on every push before,
  whether or not the tree was good.
- **`make promote` tags the newest sweep-green commit.** With queued sweeps the head of
  main often has no run of its own, so "the head must be green" would refuse most of the
  time. The workflow looks up the newest successful `ci` run for a push to main and
  releases that commit, which is the one the newest tip was built from. `make promote`
  prints it and how many commits main is ahead of it.
- **Release concurrency moved to the job.** `workflow_run` also fires for red sweeps and
  replaced pending ones; those runs skip the job. A workflow-level concurrency group would
  let such a skipped run take a pending release's place.
- **One `make check` at a time per machine.** The local check is now the gate, and five to
  ten worktrees run it at once. While this change was being built, three concurrent checks
  failed four runs in a row on `internal/store/project` alone (FSEvents tests waiting 10 s
  for an event that came late or never, the package taking 300 to 470 s instead of about
  180), in three different worktrees, with no change to that package; each test passed
  alone. The same happened on 2026-11-03 with six checks (load 169, timing tests failing
  at random, agents re-running into the load). `make check` now takes a machine-wide
  `lockf` lock in `~/Library/Caches/code-foundry/` and a second check waits its turn; the
  kernel frees the lock when a check dies. A queue of checks that pass beats parallel
  checks that fail and re-run. `CHECK_LOCK=` runs without it.
- **Every change is still a pull request.** Pushing to main directly was considered and
  dropped: once the check is the attestation a pull request costs seconds, and it keeps the
  readable record (what, why, before and after), the link from a merge back to its thread,
  and this repository's use of the app's own PR surfaces.
- **Workers open, the lead merges, and merging is the default.** The lead reads the diff,
  asks for follow-ups and merges when ready without asking; "don't merge yet" is the
  explicit instruction. Review by the user happens after the merge, by reading pull
  requests and sending a follow-up. A UI change must match what was agreed on intent, not
  pixel for pixel, and the body lists every difference with its reason.
- **Screenshots are attached, not served from a branch.** `gh pr create --attach` and
  `gh pr edit --attach` (gh 2.99+) upload the file and write it into the body. The
  `cf/*-shots` branches are retired.

## Not built

- A review agent before the merge or once a day over what landed, and the fuzz routine
  (per series plus weekly): the user starts those.
- Whether the daemon itself loses file events under that kind of load (a stale worktree
  panel while many agents build) was not looked into; the tests wait on the same stream
  the daemon uses.
- An override to promote a commit whose sweep is red. A flake is re-run
  (`gh run rerun --failed <run>`), which makes the sweep green and publishes.

## Gotchas

- While a flaky test keeps main red, tips stop. That is intended: a new flake gets fixed
  instead of ignored. The flake fixes landed before this change for that reason.
- A re-run of a failed sweep that turns green fires `workflow_run` again, so it publishes.
- `workflow_run` uses the workflow file on main, and its `branches` filter is the
  triggering run's branch, so pull request runs never start a release run.
- The `attested` job needs the PR head checked out (not the merge commit): the status
  names the head's tree.
- Workflows cannot be exercised locally. `actionlint` and `shellcheck` pass; the first
  pull request and the first sweep after the merge are the end-to-end check.
