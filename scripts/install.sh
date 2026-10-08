#!/usr/bin/env bash
# Code Foundry installer (macOS, Apple silicon).
#
#   gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash
#
# Downloads CodeFoundry-darwin-arm64.zip and checksums.txt from the latest GitHub release
# (or --version) with the authenticated gh CLI, verifies the checksum, installs
# CodeFoundry.app into ~/Applications (replacing an existing bundle by unpacking next to
# it and swapping with mv), links ~/.local/bin/code-foundry to the CLI inside the bundle,
# and adds ~/.local/bin to PATH in ~/.zshrc once (marker line).
#
# Interactive when a terminal is attached (prompts read /dev/tty); with --yes or without
# a terminal it never prompts: it upgrades and sets up PATH silently. The in-app updater
# and `code-foundry update` run the copy of this script embedded in the binary.
#
# Options:
#   --version vX.Y.Z   install that release instead of the latest
#   --yes              never prompt
#   --force            reinstall even if that version is already installed
#   --skip-path        do not touch ~/.zshrc
#   --app-dir DIR      where CodeFoundry.app goes (default ~/Applications)
#   --bin-dir DIR      where the code-foundry link goes (default ~/.local/bin)
#
# Environment:
#   CODE_FOUNDRY_RELEASE_REPO  owner/name to download from (default below)
#   CODE_FOUNDRY_RELEASE_DIR   local release source instead of GitHub: DIR/latest holds
#                              the latest tag, DIR/<tag>/ holds that release's assets
#   CODE_FOUNDRY_GH            gh executable (default: gh on PATH, then Homebrew)
#   CODE_FOUNDRY_APP_DIR, CODE_FOUNDRY_BIN_DIR   defaults for --app-dir / --bin-dir
set -euo pipefail

# Default release repository. scripts/package.sh rewrites this line for the release asset.
DEFAULT_REPO="alexwaumann/code-foundry"

APP_NAME="CodeFoundry.app"
ZIP="CodeFoundry-darwin-arm64.zip"
SUMS="checksums.txt"
MARKER="# Added by the Code Foundry installer"

REPO="${CODE_FOUNDRY_RELEASE_REPO:-$DEFAULT_REPO}"
RELEASE_DIR="${CODE_FOUNDRY_RELEASE_DIR:-}"
APP_DIR="${CODE_FOUNDRY_APP_DIR:-$HOME/Applications}"
BIN_DIR="${CODE_FOUNDRY_BIN_DIR:-$HOME/.local/bin}"
TAG=""
YES=0
FORCE=0
SKIP_PATH=0

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
	printf 'error: %s\n' "$*" >&2
	exit 1
}

usage() {
	if [ -f "$0" ]; then
		sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
	else
		echo "usage: install.sh [--version vX.Y.Z] [--yes] [--force] [--skip-path] [--app-dir DIR] [--bin-dir DIR]"
	fi
}

while [ $# -gt 0 ]; do
	case "$1" in
	--version)
		[ $# -ge 2 ] || die "--version needs a value"
		TAG="$2"
		shift 2
		;;
	--version=*)
		TAG="${1#--version=}"
		shift
		;;
	--yes | -y)
		YES=1
		shift
		;;
	--force)
		FORCE=1
		shift
		;;
	--skip-path)
		SKIP_PATH=1
		shift
		;;
	--app-dir)
		[ $# -ge 2 ] || die "--app-dir needs a value"
		APP_DIR="$2"
		shift 2
		;;
	--bin-dir)
		[ $# -ge 2 ] || die "--bin-dir needs a value"
		BIN_DIR="$2"
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
done

# Interactive: a terminal to talk to, and not --yes. Prompts read /dev/tty so this works
# when the script itself arrives on stdin (`... -O - | bash`).
INTERACTIVE=0
if [ "$YES" = 0 ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
	INTERACTIVE=1
fi

# confirm "question" -> 0 for yes. Default yes. Non-interactive: yes.
confirm() {
	[ "$INTERACTIVE" = 1 ] || return 0
	local answer
	printf '%s [Y/n] ' "$1" >/dev/tty
	IFS= read -r answer </dev/tty || answer=""
	case "$answer" in
	"" | y | Y | yes | YES | Yes) return 0 ;;
	*) return 1 ;;
	esac
}

is_tag() {
	printf '%s' "$1" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
}

# bundle_version APP -> the version a bundle was built as ("" if unknown).
bundle_version() {
	local plist="$1/Contents/Info.plist" v
	[ -f "$plist" ] || return 0
	v="$(/usr/bin/plutil -extract CodeFoundryVersion raw -o - "$plist" 2>/dev/null || true)"
	if [ -z "$v" ]; then
		v="$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$plist" 2>/dev/null || true)"
		[ -z "$v" ] || v="v$v"
	fi
	printf '%s' "$v"
}

# ---- platform -----------------------------------------------------------------------

[ "$(uname -s)" = "Darwin" ] || die "Code Foundry runs on macOS only"
[ "$(uname -m)" = "arm64" ] || die "Code Foundry is built for Apple silicon (arm64) only; this Mac is $(uname -m)"

# ---- release source -----------------------------------------------------------------

GH=""
if [ -z "$RELEASE_DIR" ]; then
	GH="${CODE_FOUNDRY_GH:-}"
	if [ -z "$GH" ]; then
		GH="$(command -v gh 2>/dev/null || true)"
	fi
	if [ -z "$GH" ]; then
		for c in /opt/homebrew/bin/gh /usr/local/bin/gh; do
			if [ -x "$c" ]; then
				GH="$c"
				break
			fi
		done
	fi
	[ -n "$GH" ] || die "the GitHub CLI (gh) is required: brew install gh && gh auth login"
	"$GH" auth status --hostname github.com >/dev/null 2>&1 ||
		die "gh is not authenticated with github.com: run 'gh auth login'"
	export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1
fi

if [ -z "$TAG" ]; then
	if [ -n "$RELEASE_DIR" ]; then
		[ -f "$RELEASE_DIR/latest" ] || die "no release published in $RELEASE_DIR (missing $RELEASE_DIR/latest)"
		TAG="$(tr -d '[:space:]' <"$RELEASE_DIR/latest")"
	else
		TAG="$("$GH" api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null)" ||
			die "no published release found in $REPO (or gh cannot see the repository)"
	fi
fi
is_tag "$TAG" || die "not a release version: '$TAG' (want vMAJOR.MINOR.PATCH)"

# ---- already installed? ---------------------------------------------------------------

TARGET="$APP_DIR/$APP_NAME"
CURRENT=""
if [ -d "$TARGET" ]; then
	CURRENT="$(bundle_version "$TARGET")"
fi

link_cli() {
	mkdir -p "$BIN_DIR"
	ln -sfn "$TARGET/Contents/MacOS/code-foundry" "$BIN_DIR/code-foundry"
}

setup_path() {
	[ "$SKIP_PATH" = 0 ] || return 0
	local rc="$HOME/.zshrc" display_bin="$BIN_DIR"
	case "$BIN_DIR" in
	"$HOME"/*) display_bin="\$HOME/${BIN_DIR#"$HOME"/}" ;;
	esac
	if [ -f "$rc" ] && grep -qF "$MARKER" "$rc"; then
		return 0 # set up before
	fi
	case ":${PATH:-}:" in
	*":$BIN_DIR:"*)
		return 0 # already on PATH some other way
		;;
	esac
	if ! confirm "Add $display_bin to PATH in ~/.zshrc?"; then
		say "skipped PATH setup; add $display_bin to PATH to use code-foundry from a shell"
		return 0
	fi
	{
		printf '\n%s\n' "$MARKER"
		printf 'export PATH="%s:$PATH"\n' "$display_bin"
	} >>"$rc"
	say "added $display_bin to PATH in ~/.zshrc (open a new terminal to pick it up)"
}

if [ -n "$CURRENT" ] && [ "$CURRENT" = "$TAG" ] && [ "$FORCE" = 0 ]; then
	say "Code Foundry $TAG is already installed at $TARGET"
	link_cli
	setup_path
	exit 0
fi

if [ -n "$CURRENT" ]; then
	confirm "Replace Code Foundry $CURRENT with $TAG?" || die "cancelled"
	say "upgrading Code Foundry $CURRENT -> $TAG"
elif [ -d "$TARGET" ]; then
	confirm "Replace the existing $TARGET with Code Foundry $TAG?" || die "cancelled"
	say "installing Code Foundry $TAG over $TARGET"
else
	say "installing Code Foundry $TAG"
fi

# ---- download and verify ---------------------------------------------------------------

TMP="$(mktemp -d "${TMPDIR:-/tmp}/code-foundry-install.XXXXXX")"
STAGE=""
OLD=""
cleanup() {
	rm -rf "$TMP"
	[ -z "$STAGE" ] || rm -rf "$STAGE"
	[ -z "$OLD" ] || [ ! -d "$OLD" ] || rm -rf "$OLD"
}
trap cleanup EXIT

if [ -n "$RELEASE_DIR" ]; then
	say "copying $ZIP from $RELEASE_DIR/$TAG"
	[ -f "$RELEASE_DIR/$TAG/$ZIP" ] || die "$RELEASE_DIR/$TAG/$ZIP not found"
	[ -f "$RELEASE_DIR/$TAG/$SUMS" ] || die "$RELEASE_DIR/$TAG/$SUMS not found"
	cp "$RELEASE_DIR/$TAG/$ZIP" "$RELEASE_DIR/$TAG/$SUMS" "$TMP/"
else
	say "downloading $ZIP from $REPO $TAG"
	"$GH" release download "$TAG" --repo "$REPO" --pattern "$ZIP" --pattern "$SUMS" --dir "$TMP" ||
		die "download failed"
fi

say "verifying checksum"
EXPECTED="$(awk -v f="$ZIP" '$2 == f || $2 == "*"f { print $1 }' "$TMP/$SUMS")"
[ -n "$EXPECTED" ] || die "$SUMS has no entry for $ZIP"
ACTUAL="$(/usr/bin/shasum -a 256 "$TMP/$ZIP" | awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ZIP: expected $EXPECTED, got $ACTUAL"

# ---- install -----------------------------------------------------------------------------

# Unpack inside APP_DIR so the swap is two renames on one filesystem.
mkdir -p "$APP_DIR"
STAGE="$(mktemp -d "$APP_DIR/.code-foundry-stage.XXXXXX")"
say "unpacking"
/usr/bin/ditto -x -k "$TMP/$ZIP" "$STAGE"
[ -x "$STAGE/$APP_NAME/Contents/MacOS/CodeFoundry" ] || die "the archive does not contain $APP_NAME"
[ -x "$STAGE/$APP_NAME/Contents/MacOS/code-foundry" ] || die "the archive's $APP_NAME has no code-foundry CLI"
GOT="$(bundle_version "$STAGE/$APP_NAME")"
[ "$GOT" = "$TAG" ] || die "the archive contains version '$GOT', expected $TAG"
# Belt and braces: gh does not quarantine downloads, but a copied archive might be.
/usr/bin/xattr -dr com.apple.quarantine "$STAGE/$APP_NAME" 2>/dev/null || true

if [ -e "$TARGET" ]; then
	OLD="$APP_DIR/.code-foundry-old.$$"
	rm -rf "$OLD"
	mv "$TARGET" "$OLD"
fi
if ! mv "$STAGE/$APP_NAME" "$TARGET"; then
	[ -z "$OLD" ] || mv "$OLD" "$TARGET"
	OLD=""
	die "could not move the new bundle into place"
fi
say "installed $TARGET"

link_cli
say "linked $BIN_DIR/code-foundry -> $TARGET/Contents/MacOS/code-foundry"
setup_path

say "Code Foundry $TAG is installed."
echo "    Launch it:  open \"$TARGET\"   (or: code-foundry gui)"
if [ -n "$CURRENT" ]; then
	echo "    A running app keeps its old version until relaunched. A running daemon keeps"
	echo "    its sessions and its old version until: code-foundry daemon restart"
fi
