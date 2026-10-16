# CI: local attestation and split jobs

A CI run on the macOS runner took about 15 minutes: 3 of setup, 0:50 `go vet`, 2:20
staticcheck, 5:15 `go test -race` (3:36 of it `internal/store/session`), 3:10 frontend.
The product is macOS-only and every change is already checked with `make check` on a Mac
before it is pushed, so CI mostly repeats a result we have.

## Decisions

- **`make check` records, `make attest` vouches.** On success `make check` writes the
  working tree's hash (a `git write-tree` of a temporary index with `git add -A`, so
  untracked files count) to `$(git rev-parse --git-dir)/code-foundry-check`, per worktree.
  `make attest` requires a clean working tree whose `HEAD^{tree}` equals that hash and a
  HEAD that exists on a remote, then posts a `local-check` commit status with
  `description: tree <hash>` via `gh api`. Hashing the tree, not the commit, means a
  rebase or amend that does not change content still attests; any content change after
  the check refuses and asks for another `make check`.
- **CI's `attested` job decides.** On `pull_request` it checks out the PR head (not the
  merge commit), reads the combined status for that SHA, and compares the description to
  the head's tree hash. Match: the three real jobs are skipped. On `push` to main the
  real jobs always run, so the merged tree gets one honest run (today main went red once
  on a test that passed on the PR).
- **Three jobs.** `go-test` and `go-lint` (gofmt, vet, staticcheck) on macOS,
  `frontend` on ubuntu-latest; nothing in typecheck/lint/vitest needs macOS, and the
  Linux runner starts in seconds. The Go setup (setup-go + cached libghostty-vt) moved to
  a composite action `.github/actions/setup-go-ghostty` shared with release.yml.
- **Trust model.** Anyone with push access can post the status, so this is an honesty
  signal for the people and agents working in the repo, not a security boundary. No
  branch protection exists, so a skipped job blocks nothing; the point is the fast green.

## Gotchas

- `make check` must finish green before committing a docs note or any other file, or the
  tree changes and `make attest` refuses. Order: edit, `make check`, commit, push,
  `make attest`.
- The record is per git dir, so a second worktree needs its own `make check`.
- `gh api` uses the caller's `gh` login; the daemon's sessions have `gh` on PATH already.

## Follow-ups

- `pnpm/action-setup` spent 2:16 on the macOS runner doing nothing visible; worth
  replacing with `packageManager` + corepack or a cached download.
- The session package took 216 s under `-race`. It was not sleeps: see
  docs/notes/fake-claude-binary.md (done).
