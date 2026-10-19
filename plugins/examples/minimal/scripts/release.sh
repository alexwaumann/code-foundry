#!/bin/sh
# release.sh publishes the GitHub release v<version>: it checks the tag against
# plugin.json's version, tests, builds the tarballs and SHA256SUMS (make dist), creates
# the release with them, then writes the registry entry (make registry-entry).
# `make release` runs it, by hand or from .github/workflows/release.yml:
#
#	git tag v0.2.0 && git push origin v0.2.0 && make release
#	make release DRY_RUN=1    # everything but the release and the entry
#
# TAG is the tag to release: $GITHUB_REF_NAME in the workflow, else the tag on HEAD.
# REPO (owner/name) is the repository to release in: $GITHUB_REPOSITORY in the
# workflow, else the checkout's (gh repo view).
set -eu

field() { sed -n "s/^  \"$1\": \"\(.*\)\",\$/\1/p" plugin.json; }
name=$(field name)
version=$(field version)
display=$(field displayName)
[ -n "$name" ] && [ -n "$version" ] || { echo "release: plugin.json has no top-level name or version line" >&2; exit 1; }

tag=${TAG:-${GITHUB_REF_NAME:-$(git describe --exact-match --tags HEAD 2>/dev/null || true)}}
if [ "$tag" != "v$version" ]; then
	echo "release: tag '${tag:-none on HEAD}', but plugin.json's version makes it v$version" >&2
	exit 1
fi
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
	[ -n "${DRY_RUN:-}" ] || { echo "release: the tree has uncommitted changes; commit them and tag again" >&2; exit 1; }
	echo "release: the tree has uncommitted changes (dry run: going on)" >&2
fi

go test ./...
make dist

notes="${display:-$name} $tag for Code Foundry: one tarball per Mac architecture (plugin.json and the executable at its root) and their SHA-256 sums."
if [ -n "${DRY_RUN:-}" ]; then
	echo "release: dry run; would run: gh release create $tag --verify-tag dist/*.tar.gz dist/SHA256SUMS, then make registry-entry"
	exit 0
fi
repo=${REPO:-${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}}
# --verify-tag: the tag must be on GitHub already (pushed), never made here from main.
gh release create "$tag" dist/*.tar.gz dist/SHA256SUMS -R "$repo" --verify-tag --title "$tag" --notes "$notes"
make registry-entry REPO="$repo"
