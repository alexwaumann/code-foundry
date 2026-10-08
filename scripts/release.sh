#!/usr/bin/env bash
# Publishes a GitHub release: the manual fallback for .github/workflows/release.yml,
# which runs this same script.
#
#   scripts/release.sh [--dry-run] [--local DIR] [vX.Y.Z]
#
# Without a version, the next one comes from conventional commits since the last tag
# (scripts/next-version.sh); with nothing new it exits 0 without releasing, unless HEAD
# is already tagged with a version whose GitHub release is missing (a re-run after a
# failure), which it finishes.
#
# Steps: clean tree, gh authenticated, `make package VERSION=<v> RELEASE_REPO=<slug>`,
# annotated tag <v> on HEAD, push the tag, `gh release create <v> --generate-notes` with
# the assets from dist/ (or `gh release upload --clobber` when the release exists).
# Every step is idempotent.
#
#   --dry-run    run the read-only checks, print the commands that change things
#   --local DIR  publish into a local release directory (DIR/<v>/ + DIR/latest, the
#                CODE_FOUNDRY_RELEASE_DIR layout) instead of GitHub: no tag, no push
#
# The repository slug comes from CODE_FOUNDRY_RELEASE_REPO, else `git remote get-url
# origin`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
LOCAL_DIR=""
VERSION=""
while [ $# -gt 0 ]; do
	case "$1" in
	--dry-run)
		DRY_RUN=1
		shift
		;;
	--local)
		[ $# -ge 2 ] || { echo "release: --local needs a directory" >&2; exit 2; }
		LOCAL_DIR="$2"
		shift 2
		;;
	-h | --help)
		sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
		exit 0
		;;
	v*)
		VERSION="$1"
		shift
		;;
	*)
		echo "release: unknown argument $1 (see --help)" >&2
		exit 2
		;;
	esac
done

say() { printf '==> %s\n' "$*"; }
die() {
	printf 'release: %s\n' "$*" >&2
	exit 1
}
# run prints a command that changes something, and runs it unless --dry-run.
run() {
	printf '+'
	printf ' %q' "$@"
	printf '\n'
	[ "$DRY_RUN" = 1 ] || "$@"
}

ASSETS=(dist/CodeFoundry-darwin-arm64.zip dist/code-foundry-darwin-arm64 dist/install.sh dist/checksums.txt)

# slug_from_url turns a GitHub remote URL into owner/name.
slug_from_url() {
	printf '%s\n' "$1" | sed -E -e 's#^(git@|ssh://git@|https://|http://)##' -e 's#^github\.com[:/]##' -e 's#/$##' -e 's#\.git$##'
}

# ---- repository ----------------------------------------------------------------------

SLUG="${CODE_FOUNDRY_RELEASE_REPO:-}"
if [ -z "$SLUG" ]; then
	url="$(git remote get-url origin 2>/dev/null)" || die "no origin remote; set CODE_FOUNDRY_RELEASE_REPO=owner/name"
	SLUG="$(slug_from_url "$url")"
fi
printf '%s' "$SLUG" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "cannot use '$SLUG' as owner/name"
say "repository: $SLUG"

if [ -z "$LOCAL_DIR" ]; then
	if ! gh auth status --hostname github.com >/dev/null 2>&1; then
		if [ "$DRY_RUN" = 1 ]; then
			echo "warning: gh is not authenticated (a real run would stop here)" >&2
		else
			die "gh is not authenticated: gh auth login (or set GH_TOKEN)"
		fi
	fi
fi

# ---- clean tree --------------------------------------------------------------------------

if [ -n "$(git status --porcelain)" ]; then
	if [ -n "$LOCAL_DIR" ] || [ "$DRY_RUN" = 1 ]; then
		echo "warning: the working tree has uncommitted changes" >&2
	else
		git status --short >&2
		die "the working tree is not clean"
	fi
fi

# ---- version -----------------------------------------------------------------------------

release_exists() { gh release view "$1" --repo "$SLUG" >/dev/null 2>&1; }

if [ -z "$VERSION" ]; then
	VERSION="$(scripts/next-version.sh)"
	if [ -z "$VERSION" ]; then
		head_tag="$(git tag --points-at HEAD --list 'v*' | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -n 1 || true)"
		if [ -n "$head_tag" ] && [ -z "$LOCAL_DIR" ] && ! release_exists "$head_tag"; then
			say "HEAD is tagged $head_tag but its release is missing; finishing it"
			VERSION="$head_tag"
		else
			say "no commits since the last release tag; nothing to release"
			exit 0
		fi
	fi
fi
printf '%s' "$VERSION" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$' ||
	die "not a release version: $VERSION"
say "version: $VERSION"

# ---- build -------------------------------------------------------------------------------

run make package VERSION="$VERSION" RELEASE_REPO="$SLUG"

if [ -n "$LOCAL_DIR" ]; then
	run mkdir -p "$LOCAL_DIR/$VERSION"
	run cp "${ASSETS[@]}" "$LOCAL_DIR/$VERSION/"
	if [ "$DRY_RUN" = 1 ]; then
		echo "+ echo $VERSION > $LOCAL_DIR/latest"
	else
		echo "$VERSION" >"$LOCAL_DIR/latest"
	fi
	say "published $VERSION to $LOCAL_DIR$([ "$DRY_RUN" = 0 ] || echo ' (dry run: nothing was changed)')"
	exit 0
fi

# ---- tag -----------------------------------------------------------------------------------

head="$(git rev-parse HEAD)"
if tagged="$(git rev-parse -q --verify "refs/tags/$VERSION^{commit}" 2>/dev/null)"; then
	[ "$tagged" = "$head" ] || die "tag $VERSION exists at ${tagged:0:12}, not HEAD (${head:0:12})"
	say "tag $VERSION already on HEAD"
else
	run git tag -a "$VERSION" -m "Code Foundry $VERSION"
fi
run git push origin "refs/tags/$VERSION"

# ---- release -------------------------------------------------------------------------------

if release_exists "$VERSION"; then
	say "release $VERSION exists; replacing its assets"
	run gh release upload "$VERSION" "${ASSETS[@]}" --clobber --repo "$SLUG"
else
	run gh release create "$VERSION" "${ASSETS[@]}" --repo "$SLUG" --verify-tag --generate-notes --title "Code Foundry $VERSION"
fi
if [ "$DRY_RUN" = 1 ]; then
	say "dry run: nothing was changed"
else
	say "released $VERSION: https://github.com/$SLUG/releases/tag/$VERSION"
fi
