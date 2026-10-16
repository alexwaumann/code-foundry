#!/usr/bin/env bash
# Local check attestation (docs/notes/ci-attest.md).
#
#   attest.sh record   Called by `make check` on success: remembers the tree hash the
#                      checks ran against (the working tree, via a temporary index).
#   attest.sh post     Called by `make attest` after the commit is pushed: if HEAD's tree
#                      is the recorded one and the working tree is clean, posts a
#                      "local-check" commit status on HEAD carrying the tree hash. The ci
#                      workflow skips its jobs for a pull request whose head has that
#                      status with a matching tree hash.
#
# The record lives in the per-worktree git dir, so parallel worktrees do not share it.
set -euo pipefail

CONTEXT=local-check
record_file="$(git rev-parse --git-dir)/code-foundry-check"

# Hash of the working tree (tracked files with their current contents, plus untracked
# files not ignored), not of HEAD: that is what the checks actually saw.
working_tree_hash() {
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  cp "$(git rev-parse --git-path index)" "$tmp"
  GIT_INDEX_FILE="$tmp" git add -A >/dev/null
  GIT_INDEX_FILE="$tmp" git write-tree
}

case "${1:-}" in
  record)
    tree="$(working_tree_hash)"
    printf '%s %s\n' "$tree" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$record_file"
    echo "recorded passing check for tree $tree"
    ;;
  post)
    if [ ! -f "$record_file" ]; then
      echo "attest: no passing \`make check\` recorded in this worktree; run it first" >&2
      exit 1
    fi
    read -r recorded recorded_at <"$record_file"
    if [ -n "$(git status --porcelain)" ]; then
      echo "attest: working tree is not clean; commit or discard changes first" >&2
      exit 1
    fi
    head_tree="$(git rev-parse 'HEAD^{tree}')"
    if [ "$head_tree" != "$recorded" ]; then
      echo "attest: HEAD tree $head_tree differs from the tree \`make check\` passed on ($recorded at $recorded_at); run \`make check\` again" >&2
      exit 1
    fi
    sha="$(git rev-parse HEAD)"
    if ! git branch -r --contains "$sha" | grep -q .; then
      echo "attest: $sha is not on any remote branch; push first" >&2
      exit 1
    fi
    gh api --silent "repos/{owner}/{repo}/statuses/$sha" \
      -f state=success -f context="$CONTEXT" \
      -f description="tree $head_tree" \
      -f target_url="https://github.com/${GITHUB_REPOSITORY:-alexwaumann/code-foundry}/blob/main/docs/notes/ci-attest.md"
    echo "attested $sha (tree $head_tree, checked $recorded_at)"
    ;;
  *)
    echo "usage: attest.sh record|post" >&2
    exit 2
    ;;
esac
