#!/usr/bin/env bash
# Code Foundry installer (macOS, Apple silicon).
#
#   gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash
#
# Downloads code-foundry-darwin-arm64.tar.gz and checksums.txt from the latest GitHub
# release (or --version) with the authenticated gh CLI, verifies the checksum, and
# installs the app directory ~/.code-foundry/app: code-foundry (daemon + CLI),
# CodeFoundry (the GUI) and VERSION. Plain executables, not an .app bundle: managed Macs
# often block unsigned bundles. An existing install is replaced by unpacking next to it
# (app.new) and swapping with mv (the old one moves to app.old and is restored if the
# swap fails). Then it links ~/.local/bin/code-foundry to the CLI and adds ~/.local/bin
# to PATH in ~/.zshrc once (marker line).
#
# Interactive when a terminal is attached (prompts read /dev/tty); with --yes or without
# a terminal it never prompts: it upgrades and sets up PATH silently. The in-app updater
# and `code-foundry update` run the copy of this script embedded in the binary.
#
# Uninstall: rm -rf ~/.code-foundry/app ~/.local/bin/code-foundry
#
# Options:
#   --version vX.Y.Z   install that release instead of the latest
#   --yes              never prompt
#   --force            reinstall even if that version is already installed
#   --skip-path        do not touch ~/.zshrc
#   --skip-link        do not create or replace the code-foundry link (updates of an
#                      existing install: the in-app updater and `code-foundry update`)
#   --app-dir DIR      the app directory (default $CODE_FOUNDRY_HOME/app, i.e.
#                      ~/.code-foundry/app); replaced as a whole, so it must be a
#                      previous install or absent
#   --bin-dir DIR      where the code-foundry link goes (default ~/.local/bin)
#
# Environment:
#   CODE_FOUNDRY_RELEASE_REPO  owner/name to download from (default below)
#   CODE_FOUNDRY_RELEASE_DIR   local release source instead of GitHub: DIR/latest holds
#                              the latest tag, DIR/<tag>/ holds that release's assets
#   CODE_FOUNDRY_GH            gh executable (default: gh on PATH, then Homebrew)
#   CODE_FOUNDRY_HOME          the daemon's config home (default ~/.code-foundry)
#   CODE_FOUNDRY_APP_DIR, CODE_FOUNDRY_BIN_DIR   defaults for --app-dir / --bin-dir
set -euo pipefail

# Default release repository. scripts/package.sh rewrites this line for the release asset.
DEFAULT_REPO="alexwaumann/code-foundry"

ARCHIVE="code-foundry-darwin-arm64.tar.gz"
SUMS="checksums.txt"
MARKER="# Added by the Code Foundry installer"

REPO="${CODE_FOUNDRY_RELEASE_REPO:-$DEFAULT_REPO}"
RELEASE_DIR="${CODE_FOUNDRY_RELEASE_DIR:-}"
APP_DIR="${CODE_FOUNDRY_APP_DIR:-${CODE_FOUNDRY_HOME:-$HOME/.code-foundry}/app}"
BIN_DIR="${CODE_FOUNDRY_BIN_DIR:-$HOME/.local/bin}"
TAG=""
YES=0
FORCE=0
SKIP_PATH=0
SKIP_LINK=0

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
		echo "usage: install.sh [--version vX.Y.Z] [--yes] [--force] [--skip-path] [--skip-link] [--app-dir DIR] [--bin-dir DIR]"
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
	--skip-link)
		SKIP_LINK=1
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

# installed_version DIR -> the version an app directory was installed as: its VERSION
# file ("" if there is none).
installed_version() {
	[ -f "$1/VERSION" ] || return 0
	head -n 1 "$1/VERSION" | tr -d '[:space:]'
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

# Absolute, without trailing slashes: the CLI link must not be relative, and the staging
# and backup directories are siblings named after it.
case "$APP_DIR" in
/*) ;;
*) APP_DIR="$PWD/$APP_DIR" ;;
esac
while [ "${APP_DIR%/}" != "$APP_DIR" ] && [ "$APP_DIR" != "/" ]; do APP_DIR="${APP_DIR%/}"; done
STAGE="$APP_DIR.new"
OLD="$APP_DIR.old"

# A previous run killed between its two renames left only the backup: put it back.
if [ ! -e "$APP_DIR" ] && [ -d "$OLD" ] && [ -f "$OLD/VERSION" ]; then
	warn "restoring $APP_DIR from an interrupted install"
	mv "$OLD" "$APP_DIR"
fi

CURRENT=""
if [ -f "$APP_DIR/VERSION" ]; then
	CURRENT="$(installed_version "$APP_DIR")"
elif [ -e "$APP_DIR" ] && { [ ! -d "$APP_DIR" ] || [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; }; then
	# The whole directory is replaced: never do that to something we did not install.
	die "$APP_DIR exists and is not a Code Foundry install (no VERSION file); remove it or pass another --app-dir"
fi

link_cli() {
	[ "$SKIP_LINK" = 0 ] || return 0
	mkdir -p "$BIN_DIR"
	ln -sfn "$APP_DIR/code-foundry" "$BIN_DIR/code-foundry"
	say "linked $BIN_DIR/code-foundry -> $APP_DIR/code-foundry"
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
	say "Code Foundry $TAG is already installed in $APP_DIR"
	link_cli
	setup_path
	exit 0
fi

if [ -n "$CURRENT" ]; then
	confirm "Replace Code Foundry $CURRENT with $TAG?" || die "cancelled"
	say "upgrading Code Foundry $CURRENT -> $TAG"
elif [ -f "$APP_DIR/VERSION" ]; then
	confirm "Replace the existing install in $APP_DIR with Code Foundry $TAG?" || die "cancelled"
	say "installing Code Foundry $TAG over $APP_DIR"
else
	say "installing Code Foundry $TAG"
fi

# ---- download and verify ---------------------------------------------------------------

TMP="$(mktemp -d "${TMPDIR:-/tmp}/code-foundry-install.XXXXXX")"
SWAPPED=0
cleanup() {
	rm -rf "$TMP" "$STAGE"
	if [ "$SWAPPED" = 1 ]; then
		rm -rf "$OLD"
	elif [ ! -e "$APP_DIR" ] && [ -d "$OLD" ]; then
		mv "$OLD" "$APP_DIR" # interrupted between the renames
	fi
}
trap cleanup EXIT

if [ -n "$RELEASE_DIR" ]; then
	say "copying $ARCHIVE from $RELEASE_DIR/$TAG"
	[ -f "$RELEASE_DIR/$TAG/$ARCHIVE" ] || die "$RELEASE_DIR/$TAG/$ARCHIVE not found"
	[ -f "$RELEASE_DIR/$TAG/$SUMS" ] || die "$RELEASE_DIR/$TAG/$SUMS not found"
	cp "$RELEASE_DIR/$TAG/$ARCHIVE" "$RELEASE_DIR/$TAG/$SUMS" "$TMP/"
else
	say "downloading $ARCHIVE from $REPO $TAG"
	"$GH" release download "$TAG" --repo "$REPO" --pattern "$ARCHIVE" --pattern "$SUMS" --dir "$TMP" ||
		die "download failed"
fi

say "verifying checksum"
EXPECTED="$(awk -v f="$ARCHIVE" '$2 == f || $2 == "*"f { print $1 }' "$TMP/$SUMS")"
[ -n "$EXPECTED" ] || die "$SUMS has no entry for $ARCHIVE"
ACTUAL="$(/usr/bin/shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')"
[ "$EXPECTED" = "$ACTUAL" ] || die "checksum mismatch for $ARCHIVE: expected $EXPECTED, got $ACTUAL"

# ---- install -----------------------------------------------------------------------------

# Unpack beside APP_DIR so the swap is two renames on one filesystem.
mkdir -p "$(dirname "$APP_DIR")"
rm -rf "$STAGE"
mkdir "$STAGE"
say "unpacking"
/usr/bin/tar -xzf "$TMP/$ARCHIVE" -C "$STAGE" || die "could not unpack $ARCHIVE"
[ -f "$STAGE/code-foundry" ] && [ -x "$STAGE/code-foundry" ] || die "the archive has no code-foundry executable"
[ -f "$STAGE/CodeFoundry" ] && [ -x "$STAGE/CodeFoundry" ] || die "the archive has no CodeFoundry executable"
GOT="$(installed_version "$STAGE")"
[ "$GOT" = "$TAG" ] || die "the archive contains version '$GOT', expected $TAG"
# Belt and braces: gh does not quarantine downloads, but a copied archive might be, and
# tar propagates the attribute to what it extracts.
/usr/bin/xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true

# Running processes keep their open executables across the renames; they pick up the new
# version when they are restarted.
rm -rf "$OLD"
if [ -e "$APP_DIR" ]; then
	mv "$APP_DIR" "$OLD"
fi
if ! mv "$STAGE" "$APP_DIR"; then
	[ ! -d "$OLD" ] || mv "$OLD" "$APP_DIR"
	die "could not move the new version into $APP_DIR"
fi
SWAPPED=1
say "installed $APP_DIR"

link_cli
setup_path

say "Code Foundry $TAG is installed."
echo "    Launch it:  code-foundry gui   (or: \"$APP_DIR/code-foundry\" gui)"
if [ -n "$CURRENT" ]; then
	echo "    A running app keeps its old version until relaunched. A running daemon keeps"
	echo "    its sessions and its old version until: code-foundry daemon restart"
fi
for old_app in "$HOME/Applications/CodeFoundry.app" "/Applications/CodeFoundry.app"; do
	if [ -d "$old_app" ]; then
		echo "    The old app bundle $old_app is no longer used; quit it and remove it:"
		echo "      rm -rf \"$old_app\""
	fi
done
