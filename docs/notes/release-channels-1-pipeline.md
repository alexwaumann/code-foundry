# Release channels 1: the pipeline

PR 1 of two for release channels. Design record:
[release-channels-handoff.md](release-channels-handoff.md) (decisions 1, 2, 4–7 and the
release-dir half of 9 are built here). PR 2 (daemon `update.channel`, channel-aware
source, migration guard, GUI `vX.Y.Z (tip N)`) is not started.

## What changed

| File | Change |
|---|---|
| `scripts/next-version.sh` | `--tip` prints `<next version>-tip.<N>`; `--tip-count N` supplies N without git (tests) |
| `scripts/release.sh` | `--channel stable\|tip` (default stable). Tip: version from `next-version.sh --tip`, `gh release create --prerelease`; `--local DIR` writes `DIR/latest-tip`. Stable: `--notes-start-tag <previous stable>` |
| `.github/workflows/release.yml` | push → tip; `workflow_dispatch` gains a `channel` choice (default stable); a prune step keeps the five newest tip releases |
| `scripts/install.sh` | `--channel stable\|tip` (default stable); tip takes the highest semver release |
| `Makefile` | `make promote [VERSION=vX.Y.Z]` |

## The tip tag

`N = git rev-list --first-parent --count <last stable>..HEAD`, where the last stable is
the highest `vMAJOR.MINOR.PATCH` tag merged into HEAD (the rule next-version.sh already
used; tip tags never count). On main every merged PR is one first-parent commit and one
push, so N is the number of tip releases since that stable. From v0.14.41: `fix:` →
v0.14.42-tip.1, `feat:` → v0.15.0-tip.2, `chore:` → v0.15.0-tip.3, promote → v0.15.0,
`fix:` → v0.15.1-tip.1. `TestNextVersionTipFromGit` replays this on a real repo built
from `--no-ff` merges.

Nothing to publish, in which case `release.sh` exits 0: no commits since the stable (the
base is empty, or N is 0), or HEAD carries a stable tag (checked before computing, so a
manually tagged HEAD never gets a tip as well).

## Decisions and gotchas

* **The counter lives in `next-version.sh --tip`**, not a sibling: it needs the same
  last-stable lookup, and the existing no-git test flags extend naturally.
* **Channel and tag must agree.** `release.sh --channel tip v0.15.0` and
  `release.sh v0.15.0-tip.1` (stable) both fail: pruning finds tips by their `-tip.N`
  suffix plus the prerelease flag, and a stable must never be a `-tip.` tag.
* **Tip notes** use plain `--generate-notes` (GitHub starts at the previous release,
  which is usually the previous tip). Stable notes start at the previous stable merged
  into HEAD (none for the very first release).
* **Pruning** is a workflow step, not in `release.sh`: it runs only on GitHub, after the
  release step, for pushes and `channel=tip` dispatches. It sorts tips by `createdAt`
  (newest five kept), filters on `isPrerelease` and a `-tip.[0-9]+$` tag, and deletes with
  `gh release delete --cleanup-tag --yes`. Stables and other prereleases (`-rc`) are never
  touched. `shell: bash` gives it `pipefail`, so a failed listing fails the step.
* **Concurrency drops pending runs.** GitHub keeps one pending run per concurrency group;
  a newer queued run cancels the older pending one. Several quick merges therefore skip
  tip numbers (harmless: the next run counts every commit), and a `make promote` that is
  still pending when a push arrives is cancelled and has to be dispatched again.
* **The local release dir's tip channel takes the higher of `latest-tip` and `latest`**
  in `install.sh`, mirroring the GitHub rule (highest semver of all releases, so a stable
  promoted after the last tip wins). `release.sh --local` writes only the channel's own
  pointer; it does not touch the other. PR 2's `DirSource` should resolve tip the same way.
* **Semver in bash 3.2.** `install.sh`'s `highest_tag` is an awk comparator with semver
  precedence (prerelease below its release, numeric identifiers numerically: tip.10 >
  tip.9, numeric below alphanumeric). `sort -V` gets prereleases wrong.
* **`install.sh --channel tip` on GitHub** runs `gh api --paginate
  repos/<repo>/releases?per_page=100 --jq '.[] | select(.draft | not) | .tag_name'`.
  The tests drive it with a fake gh (`fakeGh` in `install_test.go`) that prints tags.
* **PLAN.md** no longer had a "workflow is disabled" open item; the Packaging line now
  says how channels publish.

## Verified (this machine, 2026-10-12)

* `make check` green.
* `scripts/release.sh --dry-run --channel tip` on this branch (one docs commit plus five
  commits since v0.14.44, two of them `feat:`) printed `v0.15.0-tip.6` and a
  `gh release create … --generate-notes --prerelease`; `--dry-run` (stable) printed
  `v0.15.0` with `--notes-start-tag v0.14.44`.
* A real `scripts/release.sh --local /tmp/cf-release-test --channel tip` ran `make
  package` and wrote `v0.15.0-tip.6/` plus `latest-tip`, and no `latest`.
* That release's `install.sh --channel tip --yes --skip-path` with
  `CODE_FOUNDRY_RELEASE_DIR=/tmp/cf-release-test` and a temp `CODE_FOUNDRY_HOME`
  installed it (`code-foundry version` → `v0.15.0-tip.6`). The default channel against
  the same dir failed with "missing …/latest", as it should.
* The prune `--jq` filter ran read-only against the live repo (no tips yet: nothing
  listed) and against sample JSON (keeps five, skips stables and `-rc`).

Not verified: the workflow itself (`gh workflow run`, a real tip release, pruning on
GitHub, `make promote`). Alex merges and watches the first tip release; then promotes
once by hand to confirm N resets.
