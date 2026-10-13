#!/usr/bin/env bash
# Prints the next release version from conventional commits, or nothing when there is
# nothing to release. Shared by scripts/release.sh and .github/workflows/release.yml.
#
#   scripts/next-version.sh                 # from git: latest v* tag reachable from HEAD
#   scripts/next-version.sh --tip           # the tip channel's tag, vX.Y.Z-tip.N
#   scripts/next-version.sh --last-tag v0.3.1 --log commits.txt [--tip-count N]   # tests: no git
#
# Rules, over every non-merge commit since the latest release tag reachable from HEAD:
#   type! (e.g. "feat!:", "fix(api)!:") or a "BREAKING CHANGE:" footer  -> major
#   feat                                                               -> minor
#   anything else (fix, chore, refactor, docs, non-conventional)       -> patch
# The biggest bump wins. No release tag yet -> v0.1.0. No commits since the tag -> "".
# Release tags are vMAJOR.MINOR.PATCH; pre-release tags (v1.0.0-rc.1, v1.0.0-tip.3) are
# ignored.
#
# --tip prints the tip prerelease tag <next version>-tip.<N> instead (release channels,
# docs/notes/release-channels-handoff.md): the stable this commit would become if
# promoted now, and N = first-parent commits since the latest release tag
# (`git rev-list --first-parent --count <tag>..HEAD`), which is the number of tip
# releases since that stable because every push to main publishes one. The base can move
# between pushes (a feat: bumps it) while N keeps climbing; N resets at each promotion.
# Nothing to release, or N = 0 -> "". --tip-count N supplies N without git (implies --tip).
#
# --log FILE holds full commit messages separated by ASCII RS (0x1e), as printed by
# `git log --format=%B%x1e`.
set -euo pipefail

LAST_TAG=""
LOG_FILE=""
FROM_GIT=1
TIP=0
TIP_COUNT=""
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
	--tip)
		TIP=1
		shift
		;;
	--tip-count)
		[ $# -ge 2 ] || { echo "next-version: --tip-count needs a number" >&2; exit 2; }
		TIP=1
		TIP_COUNT="$2"
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
	if [ "$TIP" = 1 ] && [ -z "$TIP_COUNT" ]; then
		# Merge commits count here: on main each merged PR is one first-parent commit,
		# and one push, so one tip release.
		TIP_COUNT="$(git rev-list --first-parent --count "${LAST_TAG:+$LAST_TAG..}HEAD")"
	fi
elif [ -n "$LOG_FILE" ]; then
	cat "$LOG_FILE" >"$LOG"
fi

if [ "$TIP" = 1 ]; then
	printf '%s' "$TIP_COUNT" | grep -Eq '^(0|[1-9][0-9]*)$' || {
		echo "next-version: tip count '$TIP_COUNT' is not a number" >&2
		exit 2
	}
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

# emit prints the version, or with --tip its tip tag. A tip count of 0 means HEAD is the
# release tag itself: nothing to publish.
emit() {
	if [ "$TIP" = 0 ]; then
		echo "$1"
	elif [ "$TIP_COUNT" != 0 ]; then
		echo "$1-tip.$TIP_COUNT"
	fi
}

if [ -z "$LAST_TAG" ]; then
	[ "$BUMP" = 0 ] || emit "v0.1.0"
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
3) emit "v$((MAJOR + 1)).0.0" ;;
2) emit "v$MAJOR.$((MINOR + 1)).0" ;;
1) emit "v$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac
