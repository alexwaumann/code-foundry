#!/usr/bin/env bash
# Local check attestation (docs/notes/ci-attest.md).
#
#   attest.sh start    Called by `make check` before the checks: remembers the tree hash
#                      they are about to run against (the working tree, via a temporary
#                      index).
#   attest.sh record   Called by `make check` on success: records that hash as checked,
#                      provided the working tree still has it. A tree edited while the
#                      checks ran is not recorded.
#   attest.sh post     Called by `make attest` after the commit is pushed: if HEAD's tree
#                      is the recorded one and the working tree is clean, posts a
#                      "local-check" commit status on HEAD carrying the tree hash. A
#                      pull request's only check, the ci workflow's `attested` job, is
#                      green when the head has that status with a matching tree hash and
#                      red otherwise. A run that went red because the PR was opened or
#                      pushed before `make attest` is re-run.
#
# The record lives in the per-worktree git dir, so parallel worktrees do not share it.
set -euo pipefail

CONTEXT=local-check
CI_WORKFLOW=ci.yml
record_file="$(git rev-parse --git-dir)/code-foundry-check"
start_file="$record_file.start"

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

# sync_ci <sha>: make the pull request's `attested` job for <sha> honour the status just
# posted. The job reads the status once, when it starts, and is red without it; a run
# that started before `make attest` (the PR was opened or pushed first) has therefore
# failed or is about to. It takes seconds, so wait for it to finish and re-run it unless
# it passed. Best effort: it never fails the attestation, which is already posted.
sync_ci() {
  local sha="$1" id status conclusion
  id="$(gh run list --commit "$sha" --workflow "$CI_WORKFLOW" --event pull_request --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null)" || return 0
  if [ -z "$id" ]; then
    echo "no pull request CI run for $sha yet; its attested job will pass when it starts"
    return 0
  fi
  status="" conclusion=""
  for _ in $(seq 1 60); do
    read -r status conclusion <<<"$(gh run view "$id" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>/dev/null)" || return 0
    [ "$status" = completed ] && break
    sleep 2
  done
  if [ "$status" != completed ]; then
    echo "CI run $id has not finished; if its attested job ends red, re-run it: gh run rerun $id"
    return 0
  fi
  if [ "$conclusion" = success ]; then
    echo "CI run $id is green"
    return 0
  fi
  if gh run rerun "$id" >/dev/null 2>&1; then
    echo "re-ran CI run $id; its attested job now finds the attestation"
  else
    echo "attest: could not re-run CI run $id; re-run it from the Actions tab" >&2
  fi
}

case "${1:-}" in
  start)
    working_tree_hash >"$start_file"
    ;;
  record)
    if [ ! -f "$start_file" ]; then
      echo "attest: no check start recorded; run \`make check\`" >&2
      exit 1
    fi
    started="$(cat "$start_file")"
    rm -f "$start_file"
    tree="$(working_tree_hash)"
    if [ "$tree" != "$started" ]; then
      echo "attest: the tree changed during the check; not recorded (run \`make check\` again)" >&2
      exit 1
    fi
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
    sync_ci "$sha" || true
    # The order is attest, then open: a pull request opened first shows a red check
    # until the re-run above.
    if ! gh pr view --json number >/dev/null 2>&1; then
      echo "no pull request for this branch yet; next: gh pr create"
    fi
    ;;
  *)
    echo "usage: attest.sh start|record|post" >&2
    exit 2
    ;;
esac
