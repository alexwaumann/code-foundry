#!/usr/bin/env bash
# Checks that every commit a branch adds to main has a conventional subject
# (CLAUDE.md, Commits): scripts/next-version.sh reads these subjects to pick the next
# release's version, and one it cannot read counts as a patch whatever it shipped.
#
#   scripts/check-commits.sh                # non-merge commits on HEAD that origin/main lacks
#   scripts/check-commits.sh --base REF     # ... that REF lacks
#   scripts/check-commits.sh --log FILE     # tests: one subject per line, no git
#
# A subject is `type(scope): summary` or `type: summary`, at most 72 characters:
#   type    feat fix perf refactor test docs build ci chore revert
#   scope   the area, lower case (gui, thread, plugin, api, pages, ...); optional
#   !       before the colon marks a breaking change
# Merge commits are not checked. Run by `make check` and `make attest`. With no base to
# compare with (a clone without origin/main) it checks nothing and says so.
set -euo pipefail

BASE="origin/main"
LOG_FILE=""
while [ $# -gt 0 ]; do
	case "$1" in
	--base)
		BASE="$2"
		shift 2
		;;
	--log)
		LOG_FILE="$2"
		shift 2
		;;
	-h | --help)
		sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "check-commits: unknown argument $1" >&2
		exit 2
		;;
	esac
done

MAX=72
SUBJECT='^(feat|fix|perf|refactor|test|docs|build|ci|chore|revert)(\([a-z0-9][a-z0-9 ._/-]*\))?!?: [^ ].*$'

if [ -n "$LOG_FILE" ]; then
	subjects="$(cat "$LOG_FILE")"
elif git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
	subjects="$(git log --no-merges --format='%s' "$BASE..HEAD")"
else
	echo "check-commits: no $BASE to compare with; commit subjects not checked" >&2
	exit 0
fi

bad=0
while IFS= read -r s; do
	[ -n "$s" ] || continue
	why=""
	if ! printf '%s' "$s" | grep -Eq "$SUBJECT"; then
		why="not type(scope): summary"
	elif [ "${#s}" -gt "$MAX" ]; then
		why="${#s} characters, over $MAX (the rest belongs in the body)"
	fi
	if [ -n "$why" ]; then
		[ "$bad" = 1 ] || echo "check-commits: these commit subjects need rewording (git commit --amend for the last one; the tree does not change, so the check need not run again):" >&2
		bad=1
		printf '  %s\n    %s\n' "$s" "$why" >&2
	fi
done <<EOF_SUBJECTS
$subjects
EOF_SUBJECTS

if [ "$bad" = 1 ]; then
	cat >&2 <<'EOF_HELP'
A subject is `type(scope): summary`, e.g. `feat(pages): a page can save a file` or
`fix(gh): a retried merge shares the first one's outcome`. Types: feat (something a user,
plugin author or agent can now do that they could not: a new verb, setting, panel, page
ability or SDK API), fix, perf, refactor, test, docs, build, ci, chore, revert. See
CLAUDE.md, Commits.
EOF_HELP
	exit 1
fi
