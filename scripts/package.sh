#!/usr/bin/env bash
# Builds the release assets into dist/. Run through `make package VERSION=vX.Y.Z`,
# which exports the cgo/pkg-config environment and LDFLAGS.
#
#   dist/code-foundry-darwin-arm64.tar.gz   the app directory's contents (no prefix):
#       code-foundry   daemon + CLI (the GUI auto-starts it; ~/.local/bin links to it)
#       CodeFoundry    the Wails GUI, a bare executable
#       VERSION        the tag, e.g. v0.2.0 (what the installer and updater read)
#   dist/install.sh                         the installer, defaulting to RELEASE_REPO
#   dist/checksums.txt                      sha256 of the above
#
# No .app bundle: managed Macs often block unsigned bundles but allow bare executables.
# Both binaries are ad-hoc signed.
set -euo pipefail

VERSION="${VERSION:-}"
RELEASE_REPO="${RELEASE_REPO:-}"
WAILS3="${WAILS3:-wails3}"
MAKE="${MAKE:-make}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! printf '%s' "$VERSION" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$'; then
	echo "package: VERSION must be a release tag like v0.1.0 (got '$VERSION')" >&2
	exit 2
fi
[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || {
	echo "package: builds darwin-arm64 assets and must run on an Apple silicon Mac" >&2
	exit 2
}

PKG="github.com/alexwaumann/code-foundry/internal/version"
VERSION_LDFLAGS="-X $PKG.Version=$VERSION -X $PKG.ReleaseRepo=$RELEASE_REPO"
TARBALL="code-foundry-darwin-arm64.tar.gz"
FILES="code-foundry CodeFoundry VERSION"

die() {
	echo "package: $*" >&2
	exit 1
}

echo "==> package $VERSION (release repo: ${RELEASE_REPO:-none})"

# 1. Daemon/CLI, with the same version ldflags as the GUI.
"$MAKE" build VERSION="$VERSION" RELEASE_REPO="$RELEASE_REPO"

# 2. GUI executable (gui/build/darwin/Taskfile.yml appends EXTRA_LDFLAGS to -ldflags).
# The Taskfile runs `wails3 tool ...` by name, so wails3's directory must be on PATH; a
# failed build must not leave the previous gui/bin/CodeFoundry to be packaged.
case "$WAILS3" in
*/*) PATH="$(cd "$(dirname "$WAILS3")" && pwd):$PATH" ;;
esac
export PATH
rm -f gui/bin/CodeFoundry
(cd gui && "$WAILS3" build EXTRA_LDFLAGS="$VERSION_LDFLAGS")
[ -x gui/bin/CodeFoundry ] || die "wails3 build did not produce gui/bin/CodeFoundry"

# 3. Stage the app directory, sign, and check what we built.
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/code-foundry-package.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp bin/code-foundry "$STAGE/code-foundry"
cp gui/bin/CodeFoundry "$STAGE/CodeFoundry"
printf '%s\n' "$VERSION" >"$STAGE/VERSION"
chmod 755 "$STAGE/code-foundry" "$STAGE/CodeFoundry"
chmod 644 "$STAGE/VERSION"
xattr -c "$STAGE/code-foundry" "$STAGE/CodeFoundry" 2>/dev/null || true
for bin in code-foundry CodeFoundry; do
	codesign --force --sign - "$STAGE/$bin"
	codesign --verify --strict "$STAGE/$bin" || die "$bin: signature does not verify"
done

cli_version="$("$STAGE/code-foundry" version)"
case "$cli_version" in
"code-foundry $VERSION "*) ;;
*) die "the CLI reports '$cli_version', want $VERSION" ;;
esac
# The GUI is linked with the same -X flag and prints it without opening a window.
gui_version="$("$STAGE/CodeFoundry" --version)"
[ "$gui_version" = "CodeFoundry $VERSION" ] || die "the GUI reports '$gui_version', want $VERSION"
file_version="$(cat "$STAGE/VERSION")"
[ "$file_version" = "$VERSION" ] || die "VERSION says '$file_version', want $VERSION"

# 4. Assets. COPYFILE_DISABLE keeps macOS tar from adding ._ AppleDouble entries.
mkdir -p dist
rm -f "dist/$TARBALL" dist/install.sh dist/checksums.txt dist/CodeFoundry-darwin-arm64.zip dist/code-foundry-darwin-arm64
# shellcheck disable=SC2086 # FILES is a fixed list of plain names
COPYFILE_DISABLE=1 tar -czf "dist/$TARBALL" -C "$STAGE" $FILES
listing="$(tar -tzf "dist/$TARBALL" | LC_ALL=C sort | tr '\n' ' ')"
[ "$listing" = "CodeFoundry VERSION code-foundry " ] || die "unexpected tarball contents: $listing"
if [ -n "$RELEASE_REPO" ]; then
	sed "s|^DEFAULT_REPO=.*|DEFAULT_REPO=\"$RELEASE_REPO\"|" scripts/install.sh >dist/install.sh
else
	cp scripts/install.sh dist/install.sh
fi
chmod +x dist/install.sh
(cd dist && shasum -a 256 "$TARBALL" install.sh >checksums.txt)

echo "==> dist/"
ls -l dist
cat dist/checksums.txt
