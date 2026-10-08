#!/usr/bin/env bash
# Prints the next release version from conventional commits, or nothing when there is
# nothing to release. Shared by scripts/release.sh and .github/workflows/release.yml.
#
#   scripts/next-version.sh                 # from git: latest v* tag reachable from HEAD
#   scripts/next-version.sh --last-tag v0.3.1 --log commits.txt   # tests: no git
#
# Rules, over every non-merge commit since the latest release tag reachable from HEAD:
#   type! (e.g. "feat!:", "fix(api)!:") or a "BREAKING CHANGE:" footer  -> major
#   feat                                                               -> minor
#   anything else (fix, chore, refactor, docs, non-conventional)       -> patch
# The biggest bump wins. No release tag yet -> v0.1.0. No commits since the tag -> "".
# Release tags are vMAJOR.MINOR.PATCH; pre-release tags (v1.0.0-rc.1) are ignored.
#
# --log FILE holds full commit messages separated by ASCII RS (0x1e), as printed by
# `git log --format=%B%x1e`.
set -euo pipefail

LAST_TAG=""
LOG_FILE=""
FROM_GIT=1
while [ $# -gt 0 ]; do
	case "$1" in
	--last-tag)
		LAST_TAG="$2"
		FROM_GIT=0
		shift 2
		;;
	--log)
		LOG_FILE="$2"
		FROM_GIT=0
		shift 2
		;;
	-h | --help)
		sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "next-version: unknown argument $1" >&2
		exit 2
		;;
	esac
done

RELEASE_TAG='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

LOG="$(mktemp "${TMPDIR:-/tmp}/next-version.XXXXXX")"
trap 'rm -f "$LOG"' EXIT

if [ "$FROM_GIT" = 1 ]; then
	# Highest release tag merged into HEAD (version order, not date).
	LAST_TAG="$(git tag --merged HEAD --list 'v*' --sort=-v:refname | grep -E "$RELEASE_TAG" | head -n 1 || true)"
	if [ -n "$LAST_TAG" ]; then
		git log --no-merges --format='%B%x1e' "$LAST_TAG..HEAD" >"$LOG"
	else
		git log --no-merges --format='%B%x1e' HEAD >"$LOG"
	fi
elif [ -n "$LOG_FILE" ]; then
	cat "$LOG_FILE" >"$LOG"
fi

# bump: 3 major, 2 minor, 1 patch, 0 nothing. One awk pass over RS-separated messages.
BUMP="$(awk 'BEGIN { RS = "\036"; bump = 0 }
{
	msg = $0
	sub(/^[\n\r\t ]+/, "", msg)
	if (msg == "") next
	split(msg, lines, "\n")
	subject = lines[1]
	b = 1
	if (subject ~ /^[A-Za-z]+(\([^)]*\))?!:/) b = 3
	else if (msg ~ /(^|\n)BREAKING[ -]CHANGE:/) b = 3
	else if (subject ~ /^feat(\([^)]*\))?:/) b = 2
	if (b > bump) bump = b
}
END { print bump }' "$LOG")"

if [ -z "$LAST_TAG" ]; then
	[ "$BUMP" = 0 ] || echo "v0.1.0"
	exit 0
fi
printf '%s' "$LAST_TAG" | grep -Eq "$RELEASE_TAG" || {
	echo "next-version: last tag '$LAST_TAG' is not vMAJOR.MINOR.PATCH" >&2
	exit 2
}
[ "$BUMP" != 0 ] || exit 0

IFS=. read -r MAJOR MINOR PATCH <<EOF
${LAST_TAG#v}
EOF
case "$BUMP" in
3) echo "v$((MAJOR + 1)).0.0" ;;
2) echo "v$MAJOR.$((MINOR + 1)).0" ;;
1) echo "v$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac
