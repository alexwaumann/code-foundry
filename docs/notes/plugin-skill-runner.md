# Plugin skill: ask for the CI runner, one release script, pinned actions (2026-10-19)

The plugin example shipped `ci.yml` and `release.yml` on `ubuntu-24.04` with actions by
major tag. Users at companies often may not use GitHub's hosted runners (only a
self-hosted or organization label), and some do not know which runner they have yet.

## What changed

- **The runner question.** `SKILL.md` step 1 now asks the user which runner to use:
  hosted `ubuntu-24.04` or a self-hosted/org label, set as `runs-on` in both workflows.
  Not known: `rm -rf .github` and tell the user the by-hand commands.
  `reference/publishing.md` gains "Runners": the three answers, label list and runner
  group forms, what a self-hosted runner needs on PATH (`git`, `make`, `tar`, `shasum`,
  `gh`; Go comes from setup-go), and how to restore the workflows later.
- **One implementation.** `scripts/release.sh` (POSIX sh, checked with shellcheck and
  run under dash and macOS sh) is the release: tag check (the tag on HEAD or
  `$GITHUB_REF_NAME` must be `v` + `plugin.json`'s version), clean tree, `go test ./...`,
  `make dist`, `gh release create --verify-tag` with the tarballs and `SHA256SUMS`, then
  `make registry-entry`. `make release` runs it; `DRY_RUN=1` stops before publishing
  (a dirty tree only warns in a dry run). `make check` is vet plus race tests.
  `release.yml` is now checkout, setup-go, `make release`; `ci.yml` is checkout,
  setup-go, `make check`. The README template documents both paths.
- **Pinned actions.** Both workflows use full commit SHAs with the version as a comment.
  Looked up with `gh api repos/actions/<a>/git/ref/tags/<tag>` on 2026-10-19 (both are
  lightweight tags pointing at commits; the floating `v5` / `v6` tags point at the same
  commits):
  - `actions/checkout` v5.1.0: `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`
  - `actions/setup-go` v6.5.0: `924ae3a1cded613372ab5595356fb5720e22ba16`

  Newer majors exist (checkout v7.0.1, setup-go v7.0.0); the brief fixed v5/v6, so the
  majors did not move. publishing.md says how to look a SHA up when updating one.
- This repository's own `.github/workflows` are untouched.

## Decisions and gotchas

- **The SKILL cap is 120 lines, not 160.** `internal/skills/skills_test.go` caps the
  plugin skill at 120 (160 is the orchestrate skill's). It was at 120, so the new text was
  paid for: step 1's intro and step 9 were tightened and two pairs of reference lines
  were merged (the precedent from plugin-skill-user-registry). Detail lives in
  publishing.md.
- **jq dropped.** The old release step read `plugin.json` with `jq`; the script uses the
  same `sed` the Makefile does (top-level lines, two-space indented), so a Mac without
  jq or a bare self-hosted runner works.
- **`--verify-tag`.** By hand, `gh release create` would otherwise create a missing tag
  from the default branch; the script requires the tag to be pushed first.
- **Registry entry in CI.** `make release` ends with `make registry-entry` in the
  workflow too; there it only prints the entry to the log (the author still runs it
  locally for the registry PR), and it always reads the release's own `SHA256SUMS`.
- The script is invoked as `sh scripts/release.sh`, not executed directly: the skill
  installs its files 0644, so an exec bit would not survive the copy.
- The example's `.gitignore` already ignores `bin/` and `dist/`, so the clean-tree check
  passes after `make dist` and in CI.

## Verification

- `go test ./plugins/ ./internal/skills/`: new `TestExampleWorkflows` (every `uses:` is
  `owner/repo@<40 hex> # vX.Y.Z`; the workflows run `make check` / `make release`; the
  Makefile has the targets) and `TestReleaseScriptChecksTheTag` (a wrong tag fails
  before tests or builds); the skill's example is still byte for byte the repo's.
- A scratch copy of the example as an author would make it (`go mod init`, SDK via a
  local replace, `git init`, commit): untagged `make release DRY_RUN=1` refuses
  ("tag 'none on HEAD'"); `make check` passes; after `git tag v0.1.0`,
  `make release DRY_RUN=1` tests, builds both tarballs and SHA256SUMS and prints what it
  would publish; `make build` works; tarball holds `plugin.json`, `bin/minimal`; a dirty
  tree without `DRY_RUN` refuses. With a stub `gh` on PATH, `make release` called
  `gh release create v0.1.0 <both tarballs> dist/SHA256SUMS -R octo/... --verify-tag
  --title v0.1.0 --notes "Minimal v0.1.0 for Code Foundry: …"`, then `gh release
  download … SHA256SUMS` and wrote `dist/minimal.json`.
- Not exercised: a real GitHub release or an Actions run on a hosted or self-hosted
  runner (it would publish a repository).
