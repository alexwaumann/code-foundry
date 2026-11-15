#!/usr/bin/env bash
# Says whether `make check` needs its frontend phase: exit 0 to run it, 1 to skip it.
# The phase takes about 100 s whatever changed, and a branch that only touches Go
# cannot change its result. The sweep on main runs every phase regardless.
#
#   scripts/check-scope.sh frontend               # the branch's changes since origin/main
#   scripts/check-scope.sh frontend --base REF    # ... since REF
#   scripts/check-scope.sh frontend --files FILE  # tests: one changed path per line, no git
#
# The phase runs when a changed path is one of its inputs (scripts/frontend-inputs.txt),
# when nothing changed, when there is no base to compare with, or when CHECK_ALL is set
# (CHECK_ALL=1 make check). A changed path is anything that differs from the merge base
# with the base ref: committed, staged, unstaged or untracked, and both names of a
# rename.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
PHASE="${1:-}"
[ $# -gt 0 ] && shift
BASE="origin/main"
FILES=""
while [ $# -gt 0 ]; do
	case "$1" in
	--base)
		BASE="$2"
		shift 2
		;;
	--files)
		FILES="$2"
		shift 2
		;;
	*)
		echo "check-scope: unknown argument $1" >&2
		exit 2
		;;
	esac
done
if [ "$PHASE" != frontend ]; then
	echo "check-scope: usage: check-scope.sh frontend [--base REF] [--files FILE]" >&2
	exit 2
fi

if [ -n "${CHECK_ALL:-}" ]; then
	exit 0
fi

if [ -n "$FILES" ]; then
	changed="$(cat "$FILES")"
elif base="$(git merge-base HEAD "$BASE" 2>/dev/null)"; then
	changed="$(
		git diff --name-only --no-renames "$base"
		git ls-files --others --exclude-standard
	)"
else
	echo "check-scope: no $BASE to compare with; running the frontend phase" >&2
	exit 0
fi

if [ -z "$changed" ]; then
	exit 0
fi

inputs="$(grep -Ev '^[[:space:]]*(#|$)' "$here/frontend-inputs.txt")"
while IFS= read -r path; do
	[ -n "$path" ] || continue
	while IFS= read -r input; do
		case "$input" in
		*/) case "$path" in "$input"*) exit 0 ;; esac ;;
		*) [ "$path" = "$input" ] && exit 0 ;;
		esac
	done <<<"$inputs"
done <<<"$changed"

echo "make check: frontend phase skipped: the branch touches none of its inputs (scripts/frontend-inputs.txt; CHECK_ALL=1 runs it)" >&2
exit 1
