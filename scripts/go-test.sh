#!/usr/bin/env bash
# Runs the Go tests (`make go-test`): go test -race over both modules, with the slow
# packages split (docs/notes/check-speed.md).
#
# go test runs packages side by side but one package's tests one after another, and three
# packages hold most of the suite's time in hundreds of short tests. Each of those is run
# as several `go test -run` processes at once, every test in exactly one of them: the
# isolation packages already have from each other, with no change to a test. The groups
# go through `go test`, not a compiled test binary, so an unchanged package's results stay
# cached.
#
#   GO_TEST_SPLIT="pkg:groups ..."   the packages to split and into how many groups on a
#                                    12-core machine; fewer cores get fewer groups, and
#                                    one group is the plain run. Empty: no splitting.
set -euo pipefail

SPLIT="${GO_TEST_SPLIT-internal/store/thread:4 internal/store/plugin:4 internal/store/project:3}"
cores="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# job <name> <command...>: run the command in the background, its output kept for the
# end so that concurrent jobs do not interleave.
names=()
job() {
  local name="$1"
  shift
  names+=("$name")
  (
    if "$@" >"$tmp/$name.log" 2>&1; then echo 0 >"$tmp/$name.rc"; else echo $? >"$tmp/$name.rc"; fi
  ) &
}

split_pkgs=()
n=0
for entry in $SPLIT; do
  pkg="${entry%%:*}"
  want="${entry##*:}"
  groups=$(((want * cores + 6) / 12))
  [ "$groups" -gt "$want" ] && groups="$want"
  [ "$groups" -lt 2 ] && continue # one group is the plain run below
  # Every test, example and fuzz seed go test would run in the package. A listing that
  # fails (the package does not compile) leaves the package to the plain run, which
  # reports it.
  if ! list="$(go test -race -list '^(Test|Example|Fuzz)' "./$pkg" 2>/dev/null | grep -E '^(Test|Example|Fuzz)')"; then
    continue
  fi
  split_pkgs+=("$pkg")
  total="$(printf '%s\n' "$list" | wc -l | tr -d ' ')"
  covered=0
  for i in $(seq 0 $((groups - 1))); do
    group="$(printf '%s\n' "$list" | awk -v n="$groups" -v i="$i" 'NR % n == i')"
    [ -n "$group" ] || continue
    covered=$((covered + $(printf '%s\n' "$group" | wc -l)))
    n=$((n + 1))
    job "split-$n" go test -race -run "^($(printf '%s\n' "$group" | paste -sd'|' -))\$" "./$pkg"
  done
  if [ "$covered" -ne "$total" ]; then
    echo "go-test: $pkg: the groups hold $covered of $total tests" >&2
    exit 1
  fi
done

# Everything else, as one go test.
rest="$(go list ./...)"
for pkg in ${split_pkgs[@]+"${split_pkgs[@]}"}; do
  rest="$(printf '%s\n' "$rest" | grep -v -E "/$pkg\$")"
done
# shellcheck disable=SC2086 # one argument per package
job rest go test -race $rest
# pluginsdk/ is its own module, so ./... does not reach it.
job pluginsdk sh -c 'cd pluginsdk && go test -race ./...'

wait
failed=0
for name in "${names[@]}"; do
  cat "$tmp/$name.log"
  if [ "$(cat "$tmp/$name.rc" 2>/dev/null || echo 1)" != 0 ]; then failed=1; fi
done
exit "$failed"
