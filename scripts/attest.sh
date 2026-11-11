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
#                      "local-check" commit status on HEAD carrying the tree hash. The ci
#                      workflow skips its jobs for a pull request whose head has that
#                      status with a matching tree hash. A pull request run that had
#                      already decided to run them (the PR was opened or pushed before
#                      `make attest`) is cancelled and re-run, so it skips them too.
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

# jobs_state <run id>: "<attested job status> <real jobs: skipped|running|pending|none>"
# (the real jobs are every job but attested).
jobs_state() {
  gh run view "$1" --json jobs --jq '
    ([.jobs[] | select(.name == "attested") | .status] | first // "pending") as $a
    | [.jobs[] | select(.name != "attested")] as $real
    | ( if ($real | length) == 0 then "none"
        elif any($real[]; .conclusion == "skipped") then "skipped"
        elif any($real[]; .status == "in_progress" or (.status == "completed" and .conclusion != "skipped")) then "running"
        else "pending" end ) as $r
    | "\($a) \($r)"'
}

# sync_ci <sha>: make the pull request CI run for <sha> honour the status just posted.
# The run's attested job reads the status once; if it ran before `make attest`, the real
# jobs run (and can go red on a flake the local check did not hit). Such a run is
# cancelled if still going and re-run, and its new attested job skips them. A run that
# already finished green is left alone. Best effort: it never fails the attestation.
sync_ci() {
  local sha="$1" id state attested real i status conclusion
  id="$(gh run list --commit "$sha" --workflow "$CI_WORKFLOW" --event pull_request --limit 1 \
    --json databaseId --jq '.[0].databaseId // empty' 2>/dev/null)" || return 0
  if [ -z "$id" ]; then
    echo "no pull request CI run for $sha yet; it will skip its jobs when it starts"
    return 0
  fi
  # Until the attested job finishes and the real jobs are skipped or picked up, the run
  # has not shown what it decided. Skipped jobs resolve within seconds of attested;
  # real jobs still queued after that are waiting for a runner.
  for i in $(seq 1 30); do
    state="$(jobs_state "$id" 2>/dev/null)" || return 0
    read -r attested real <<<"$state"
    case "$attested" in
      queued | waiting | pending | requested)
        echo "CI run $id has not checked for the attestation yet; it will skip its jobs"
        return 0
        ;;
    esac
    if [ "$attested" = completed ]; then
      case "$real" in skipped | running) break ;; esac
      [ "$i" -ge 15 ] && break
    fi
    sleep 2
  done
  if [ "$real" = skipped ]; then
    echo "CI run $id skipped its jobs"
    return 0
  fi
  read -r status conclusion <<<"$(gh run view "$id" --json status,conclusion --jq '"\(.status) \(.conclusion)"')"
  if [ "$status" = completed ] && [ "$conclusion" = success ]; then
    echo "CI run $id already passed with its jobs run; leaving it"
    return 0
  fi
  if [ "$status" != completed ]; then
    echo "CI run $id started before the attestation; cancelling it"
    gh run cancel "$id" >/dev/null 2>&1 || true
    for i in $(seq 1 30); do
      [ "$(gh run view "$id" --json status --jq .status 2>/dev/null)" = completed ] && break
      sleep 2
    done
  fi
  if gh run rerun "$id" >/dev/null 2>&1; then
    echo "re-ran CI run $id; its jobs are skipped against the attestation"
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
    ;;
  *)
    echo "usage: attest.sh start|record|post" >&2
    exit 2
    ;;
esac
