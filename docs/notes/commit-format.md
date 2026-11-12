# Commit format

The release version is read from commit subjects (`scripts/next-version.sh`), and the
subjects had drifted: `Docs: ...`, `e2e: ...`, `Remove ...`. Each of those counted as a
patch whatever it shipped, so releases with new features went out as patches.

## Decisions

- One shape, `type(scope): summary`, written down in CLAUDE.md with the test for `feat`:
  something a user, plugin author or agent can now do that they could not. A change to how
  an existing thing looks or behaves is a `fix` or a `refactor`.
- `scripts/check-commits.sh` checks the non-merge commits a branch adds to `origin/main`.
  `make check` runs it first, so a bad subject fails in a second and not after the suite.
  `make attest` runs it again, because the usual order is check, then commit: the commit
  the pull request carries did not exist when the check ran.
- A breaking change is a minor release while the version is 0.x. 1.0.0 is released only
  by naming it (`VERSION=v1.0.0`).
- `next-version.sh` names on stderr every subject it cannot read. It still counts it as a
  patch: a release is not held up by an old subject.
- History is left alone. Commits before this one are not reworded and no version is
  forced to make up for the minors that were missed.

## Gotchas

- Rewording a subject does not change the tree, so `make attest` still vouches for the
  amended commit without another `make check`.
- Merge commits are skipped by both scripts; pull requests land as merge commits, so the
  branch's own subjects are what a release reads.
- On main itself `origin/main..HEAD` is empty and the check passes; in a clone without
  `origin/main` it says so and checks nothing.
