#!/usr/bin/env bash
# Reports the sweep (the ci workflow on a push to main, docs/notes/ci-rethink.md) as one
# GitHub issue labelled "main-red": opened when a sweep is red, commented on while main
# stays red, closed by the next green sweep. Run by the ci workflow's `report` job.
#
#   RESULTS="go-test=failure go-lint=success frontend=success" scripts/sweep-report.sh
#
# Environment (all set by GitHub Actions but RESULTS): RESULTS (each sweep job's result),
# GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GITHUB_SERVER_URL,
# GH_TOKEN (issues: write, actions: read).
#
# A red sweep's issue or comment carries the jobs that failed, the failing tests pulled
# from their logs, a link to the run, and the pull requests merged since the last green
# sweep. The log and the pull request list are best effort: without them the report still
# goes out with the link.
set -euo pipefail

LABEL=main-red
TITLE="main is red"
WORKFLOW=ci.yml
MAX_LINES=40

repo="${GITHUB_REPOSITORY:?}"
sha="${GITHUB_SHA:?}"
run_id="${GITHUB_RUN_ID:?}"
attempt="${GITHUB_RUN_ATTEMPT:-1}"
run_url="${GITHUB_SERVER_URL:-https://github.com}/$repo/actions/runs/$run_id"

red=()
for r in ${RESULTS:?}; do
  case "${r#*=}" in
    success) ;;
    *) red+=("$r") ;;
  esac
done

issue="$(gh issue list --repo "$repo" --label "$LABEL" --state open --limit 1 --json number --jq '.[0].number // empty')"

if [ "${#red[@]}" -eq 0 ]; then
  if [ -n "$issue" ]; then
    gh issue close "$issue" --repo "$repo" --comment "Green again at ${sha:0:9} ([sweep]($run_url))."
    echo "closed #$issue: the sweep is green at ${sha:0:9}"
  else
    echo "the sweep is green at ${sha:0:9}; no $LABEL issue is open"
  fi
  exit 0
fi

# api <gh api args>: the response on success, nothing on failure (gh prints the error's
# JSON body on stdout, which must not end up in the report).
api() {
  local out
  out="$(gh api "$@" 2>/dev/null)" || return 1
  printf '%s\n' "$out"
}

# failing_lines <job id>: the lines of a job's log that name what failed, without the
# runner's timestamps and colour codes. curl, not `gh api`: gh refuses to print a response
# with terminal escape sequences, and vitest's output has them.
failing_lines() {
  curl -fsSL -H "Authorization: Bearer ${GH_TOKEN:-$(gh auth token)}" -H "Accept: application/vnd.github+json" \
    "${GITHUB_API_URL:-https://api.github.com}/repos/$repo/actions/jobs/$1/logs" 2>/dev/null |
    sed -E -e $'s/\x1b\\[[0-9;]*m//g' -e 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z //' |
    grep -E '^(--- FAIL: |    --- FAIL: |FAIL[[:space:]]|panic: |WARNING: DATA RACE| FAIL  |##\[error\])' |
    grep -v -E '^##\[error\]Process completed with exit code' |
    awk '!seen[$0]++' | head -n "$MAX_LINES" || true
}

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
{
  echo "The sweep on main failed at ${sha:0:9}: [run $run_id]($run_url)."
  echo
  echo "| Job | Result |"
  echo "|---|---|"
  for r in $RESULTS; do echo "| ${r%%=*} | ${r#*=} |"; done

  jobs="$(api "repos/$repo/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" \
    --jq '.jobs[] | select(.conclusion == "failure" or .conclusion == "cancelled" or .conclusion == "timed_out") | "\(.id) \(.name)"' || true)"
  while read -r id name; do
    [ -n "$id" ] || continue
    lines="$(failing_lines "$id")"
    echo
    echo "**$name**"
    echo
    if [ -n "$lines" ]; then
      echo '```'
      echo "$lines"
      echo '```'
    else
      echo "No failing test found in its log (it may have been cancelled or timed out); see the run."
    fi
  done <<<"$jobs"

  green="$(api "repos/$repo/actions/workflows/$WORKFLOW/runs?branch=main&event=push&status=success&per_page=1" \
    --jq '.workflow_runs[0].head_sha // empty' || true)"
  if [ -n "$green" ]; then
    echo
    # shellcheck disable=SC2016 # the backticks are Markdown in a jq string
    if merged="$(api "repos/$repo/compare/$green...$sha" \
      --jq '.commits[].commit.message | split("\n")[0] | select(startswith("Merge pull request #")) | capture("^Merge pull request (?<n>#[0-9]+) from [^/]+/(?<b>.+)$") | "- \(.n) (`\(.b)`)"')"; then
      if [ -n "$merged" ]; then
        echo "Merged since the last green sweep (${green:0:9}):"
        echo
        echo "$merged"
      else
        echo "No pull request merged since the last green sweep (${green:0:9})."
      fi
    else
      echo "The last green sweep was ${green:0:9}; the pull requests merged since could not be listed."
    fi
  fi

  echo
  echo "Tips are not published while main is red. Check for a timing flake first (\`docs/notes/flaky-ci-tests.md\`): \`gh run rerun $run_id --failed\` re-runs the failed jobs, and a green re-run closes this issue and publishes the tip."
} >"$body"

if [ -n "$issue" ]; then
  gh issue comment "$issue" --repo "$repo" --body-file "$body"
  echo "commented on #$issue: the sweep is still red at ${sha:0:9}"
else
  gh label create "$LABEL" --repo "$repo" --color B60205 --description "The sweep on main is red" >/dev/null 2>&1 || true
  gh issue create --repo "$repo" --title "$TITLE" --label "$LABEL" --body-file "$body"
  echo "opened a $LABEL issue: the sweep is red at ${sha:0:9}"
fi
