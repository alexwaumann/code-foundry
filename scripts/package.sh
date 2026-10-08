#!/usr/bin/env bash
# Builds the release assets into dist/. Run through `make package VERSION=vX.Y.Z`,
# which exports the cgo/pkg-config environment and LDFLAGS.
#
#   dist/CodeFoundry-darwin-arm64.zip   CodeFoundry.app (GUI + bundled daemon/CLI), ditto --keepParent
#   dist/code-foundry-darwin-arm64      the same CLI, standalone, for scripting
#   dist/install.sh                     the installer, defaulting to RELEASE_REPO
#   dist/checksums.txt                  sha256 of the above
#
# Bundle layout:
#   CodeFoundry.app/Contents/MacOS/CodeFoundry     Wails GUI
#   CodeFoundry.app/Contents/MacOS/code-foundry    daemon + CLI (auto-started by the GUI)
#   CodeFoundry.app/Contents/Info.plist            CFBundleShortVersionString X.Y.Z, CodeFoundryVersion vX.Y.Z
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
APP="gui/bin/CodeFoundry.app"
ZIP="CodeFoundry-darwin-arm64.zip"
CLI="code-foundry-darwin-arm64"

echo "==> package $VERSION (release repo: ${RELEASE_REPO:-none})"

# 1. Daemon/CLI, with the same version ldflags as the GUI.
"$MAKE" build VERSION="$VERSION" RELEASE_REPO="$RELEASE_REPO"

# 2. GUI bundle with the CLI inside (gui/build/darwin/Taskfile.yml create:app:bundle).
(cd gui && "$WAILS3" package VERSION="$VERSION" EXTRA_LDFLAGS="$VERSION_LDFLAGS" CLI_BIN="$ROOT/bin/code-foundry")

# 3. Check what we built.
[ -x "$APP/Contents/MacOS/CodeFoundry" ] || { echo "package: $APP has no GUI binary" >&2; exit 1; }
[ -x "$APP/Contents/MacOS/code-foundry" ] || { echo "package: $APP has no code-foundry CLI" >&2; exit 1; }
got="$(plutil -extract CodeFoundryVersion raw -o - "$APP/Contents/Info.plist")"
[ "$got" = "$VERSION" ] || { echo "package: Info.plist says $got, want $VERSION" >&2; exit 1; }
cli_version="$("$APP/Contents/MacOS/code-foundry" version)"
case "$cli_version" in
"code-foundry $VERSION "*) ;;
*)
	echo "package: bundled CLI reports '$cli_version', want $VERSION" >&2
	exit 1
	;;
esac
# The GUI binary carries the same string (it is linked with the same -X flag).
grep -q "$VERSION" "$APP/Contents/MacOS/CodeFoundry" || { echo "package: GUI binary lacks $VERSION" >&2; exit 1; }
codesign --verify --deep --strict "$APP"

# 4. Assets.
mkdir -p dist
rm -f "dist/$ZIP" "dist/$CLI" dist/install.sh dist/checksums.txt
ditto -c -k --keepParent "$APP" "dist/$ZIP"
cp bin/code-foundry "dist/$CLI"
if [ -n "$RELEASE_REPO" ]; then
	sed "s|^DEFAULT_REPO=.*|DEFAULT_REPO=\"$RELEASE_REPO\"|" scripts/install.sh >dist/install.sh
else
	cp scripts/install.sh dist/install.sh
fi
chmod +x dist/install.sh "dist/$CLI"
(cd dist && shasum -a 256 "$ZIP" "$CLI" install.sh >checksums.txt)

echo "==> dist/"
ls -l dist
cat dist/checksums.txt
