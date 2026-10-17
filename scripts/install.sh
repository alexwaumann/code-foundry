#!/usr/bin/env bash
# Code Foundry installer (macOS, Apple silicon).
#
#   gh release download --repo alexwaumann/code-foundry --pattern install.sh -O - | bash
#
# Downloads code-foundry-darwin-arm64.tar.gz and checksums.txt from the latest GitHub
# release of a channel (or --version) with the authenticated gh CLI, verifies the checksum, and
# installs the app directory ~/.code-foundry/app: code-foundry (daemon + CLI),
# "Code Foundry" (the GUI) and VERSION. Plain executables, not an .app bundle: managed Macs
# often block unsigned bundles. An existing install is replaced by unpacking next to it
# (app.new) and swapping with mv (the old one moves to app.old and is restored if the
# swap fails). Then it links ~/.local/bin/code-foundry to the CLI and adds ~/.local/bin
# to PATH in ~/.zshrc once (marker line).
#
# Interactive when a terminal is attached (prompts read /dev/tty); with --yes or without
# a terminal it never prompts: it upgrades and sets up PATH silently. The in-app updater
# and `code-foundry update` run the copy of this script embedded in the binary.
#
# The in-app updater splits an upgrade in two so nothing on disk changes while the old
# daemon and window still run: --stage-only downloads, verifies and unpacks into app.new
# and stops there; --apply-staged (run by `app.restart` right before the restart) only
# does the two renames.
#
# Uninstall: rm -rf ~/.code-foundry/app ~/.local/bin/code-foundry
#
# Options:
#   --channel stable|tip
#                      which release is the latest (default stable): stable is GitHub's
#                      latest full release; tip is the highest version among all
#                      published releases, prereleases (vX.Y.Z-tip.N) included, so a
#                      stable promoted after the last tip wins
#   --version vX.Y.Z   install that release (any tag, e.g. v0.15.0-tip.3) instead of the
#                      channel's latest
#   --yes              never prompt
#   --force            reinstall even if that version is already installed
#   --skip-path        do not touch ~/.zshrc
#   --skip-link        do not create or replace the code-foundry link (updates of an
#                      existing install: the in-app updater and `code-foundry update`)
#   --app-dir DIR      the app directory (default $CODE_FOUNDRY_HOME/app, i.e.
#                      ~/.code-foundry/app); replaced as a whole, so it must be a
#                      previous install or absent
#   --bin-dir DIR      where the code-foundry link goes (default ~/.local/bin)
#   --stage-only       download, verify and unpack into <app-dir>.new, then stop: the
#                      install is left untouched and app.new stays for --apply-staged
#                      (no link or PATH setup)
#   --apply-staged     no download: swap a previous --stage-only of --version (default:
#                      the version staged) into the app directory; fails when app.new
#                      does not hold that version. Exclusive with --stage-only
#
# Environment:
#   CODE_FOUNDRY_RELEASE_REPO  owner/name to download from (default below)
#   CODE_FOUNDRY_RELEASE_DIR   local release source instead of GitHub: DIR/latest holds
#                              the latest stable tag, DIR/latest-tip the latest tip tag
#                              (the tip channel takes the higher of the two),
#                              DIR/<tag>/ holds that release's assets
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
CHANNEL=stable
YES=0
FORCE=0
SKIP_PATH=0
SKIP_LINK=0
STAGE_ONLY=0
APPLY_STAGED=0

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
		echo "usage: install.sh [--channel stable|tip] [--version vX.Y.Z] [--yes] [--force] [--skip-path] [--skip-link] [--app-dir DIR] [--bin-dir DIR] [--stage-only | --apply-staged]"
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
	--channel)
		[ $# -ge 2 ] || die "--channel needs stable or tip"
		CHANNEL="$2"
		shift 2
		;;
	--channel=*)
		CHANNEL="${1#--channel=}"
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
	--stage-only)
		STAGE_ONLY=1
		shift
		;;
	--apply-staged)
		APPLY_STAGED=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "unknown option: $1 (see --help)" ;;
	esac
done
case "$CHANNEL" in
stable | tip) ;;
*) die "unknown channel: '$CHANNEL' (want stable or tip)" ;;
esac
[ "$STAGE_ONLY" = 0 ] || [ "$APPLY_STAGED" = 0 ] || die "--stage-only and --apply-staged exclude each other"

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

TAG_RE='^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'

# is_tag TAG: a semver release tag, prereleases (v0.15.0-tip.3) included.
is_tag() {
	printf '%s' "$1" | grep -Eq "$TAG_RE"
}

# highest_tag: the highest semver tag among the lines on stdin (others are skipped), or
# nothing. Semver precedence: a prerelease sorts below its release (v0.15.0-tip.3 <
# v0.15.0), numeric identifiers compare as numbers (tip.10 > tip.9), build metadata is
# ignored.
highest_tag() {
	{ grep -E "$TAG_RE" || true; } | awk '
	function cmpid(x, y,   xn, yn) {
		xn = (x ~ /^[0-9]+$/); yn = (y ~ /^[0-9]+$/)
		if (xn && yn) return (x + 0 < y + 0) ? -1 : (x + 0 > y + 0)
		if (xn) return -1
		if (yn) return 1
		return (x < y) ? -1 : (x > y)
	}
	function cmp(a, b,   i, n, m, ap, bp, A, B, r) {
		sub(/^v/, "", a); sub(/\+.*/, "", a)
		sub(/^v/, "", b); sub(/\+.*/, "", b)
		ap = ""; i = index(a, "-"); if (i) { ap = substr(a, i + 1); a = substr(a, 1, i - 1) }
		bp = ""; i = index(b, "-"); if (i) { bp = substr(b, i + 1); b = substr(b, 1, i - 1) }
		split(a, A, "."); split(b, B, ".")
		for (i = 1; i <= 3; i++) if (A[i] + 0 != B[i] + 0) return (A[i] + 0 < B[i] + 0) ? -1 : 1
		if (ap == bp) return 0
		if (ap == "") return 1
		if (bp == "") return -1
		n = split(ap, A, "."); m = split(bp, B, ".")
		for (i = 1; i <= n && i <= m; i++) if ((r = cmpid(A[i], B[i])) != 0) return r
		return (n < m) ? -1 : (n > m)
	}
	best == "" || cmp($0, best) > 0 { best = $0 }
	END { if (best != "") print best }'
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

# --apply-staged needs no release source: the version comes from --version or app.new.
GH=""
if [ "$APPLY_STAGED" = 1 ]; then
	: # nothing to look up
elif [ -z "$RELEASE_DIR" ]; then
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

if [ "$APPLY_STAGED" = 1 ]; then
	: # resolved from app.new below when --version is absent
elif [ -z "$TAG" ] && [ "$CHANNEL" = stable ]; then
	if [ -n "$RELEASE_DIR" ]; then
		[ -f "$RELEASE_DIR/latest" ] || die "no release published in $RELEASE_DIR (missing $RELEASE_DIR/latest)"
		TAG="$(tr -d '[:space:]' <"$RELEASE_DIR/latest")"
	else
		TAG="$("$GH" api "repos/$REPO/releases/latest" --jq .tag_name 2>/dev/null)" ||
			die "no published release found in $REPO (or gh cannot see the repository)"
	fi
elif [ -z "$TAG" ]; then
	# Tip: the highest version of all, which is a stable when one was promoted after the
	# last tip. A malformed pointer is an error, not something to skip.
	if [ -n "$RELEASE_DIR" ]; then
		[ -f "$RELEASE_DIR/latest-tip" ] || [ -f "$RELEASE_DIR/latest" ] ||
			die "no release published in $RELEASE_DIR (missing $RELEASE_DIR/latest-tip and $RELEASE_DIR/latest)"
		tags=""
		for f in latest-tip latest; do
			[ -f "$RELEASE_DIR/$f" ] || continue
			t="$(tr -d '[:space:]' <"$RELEASE_DIR/$f")"
			is_tag "$t" || die "not a release version: '$t' in $RELEASE_DIR/$f"
			tags="$tags$t
"
		done
		TAG="$(printf '%s' "$tags" | highest_tag)"
	else
		tags="$("$GH" api --paginate "repos/$REPO/releases?per_page=100" --jq '.[] | select(.draft | not) | .tag_name' 2>/dev/null)" ||
			die "cannot list the releases of $REPO (or gh cannot see the repository)"
		TAG="$(printf '%s\n' "$tags" | highest_tag)"
		[ -n "$TAG" ] || die "no published release found in $REPO"
	fi
	say "tip channel: $TAG"
fi
if [ "$APPLY_STAGED" = 0 ] || [ -n "$TAG" ]; then
	is_tag "$TAG" || die "not a release version: '$TAG' (want vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-tip.N)"
fi

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

if [ "$APPLY_STAGED" = 1 ]; then
	if [ -z "$TAG" ]; then
		TAG="$(installed_version "$STAGE")"
		[ -n "$TAG" ] || die "no staged download in $STAGE; run again without --apply-staged"
		is_tag "$TAG" || die "$STAGE holds '$TAG', which is not a release version; run again without --apply-staged"
	fi
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
	[ "$STAGE_ONLY" = 1 ] && exit 0
	link_cli
	setup_path
	exit 0
fi

if [ "$STAGE_ONLY" = 1 ]; then
	# Nothing to confirm: the install is not touched.
	if [ -n "$CURRENT" ]; then
		say "downloading Code Foundry $TAG (installed: $CURRENT)"
	else
		say "downloading Code Foundry $TAG"
	fi
elif [ -n "$CURRENT" ]; then
	confirm "Replace Code Foundry $CURRENT with $TAG?" || die "cancelled"
	say "upgrading Code Foundry $CURRENT -> $TAG"
elif [ -f "$APP_DIR/VERSION" ]; then
	confirm "Replace the existing install in $APP_DIR with Code Foundry $TAG?" || die "cancelled"
	say "installing Code Foundry $TAG over $APP_DIR"
else
	say "installing Code Foundry $TAG"
fi

# ---- download and verify (or check the staged download) --------------------------------

TMP=""
SWAPPED=0
# KEEP_STAGE: app.new survives the exit (a finished --stage-only, or --apply-staged,
# whose stage is not ours to delete when the swap fails).
KEEP_STAGE="$APPLY_STAGED"
cleanup() {
	[ -z "$TMP" ] || rm -rf "$TMP"
	[ "$KEEP_STAGE" = 1 ] || rm -rf "$STAGE"
	if [ "$SWAPPED" = 1 ]; then
		rm -rf "$OLD"
	elif [ ! -e "$APP_DIR" ] && [ -d "$OLD" ]; then
		mv "$OLD" "$APP_DIR" # interrupted between the renames
	fi
}
trap cleanup EXIT

# check_staged: --apply-staged's precondition, app.new holding TAG and both executables.
check_staged() {
	local got
	got="$(installed_version "$STAGE")"
	if [ "$got" != "$TAG" ] || [ ! -x "$STAGE/code-foundry" ] || [ ! -x "$STAGE/Code Foundry" ]; then
		local detail=""
		[ -z "$got" ] || [ "$got" = "$TAG" ] || detail=" (it holds $got)"
		die "no staged download of $TAG in $STAGE$detail; run again without --apply-staged"
	fi
	say "applying the download staged in $STAGE"
}

# stage_download: download TAG, verify its checksum and unpack it into app.new.
stage_download() {
	TMP="$(mktemp -d "${TMPDIR:-/tmp}/code-foundry-install.XXXXXX")"
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
	local expected actual got
	expected="$(awk -v f="$ARCHIVE" '$2 == f || $2 == "*"f { print $1 }' "$TMP/$SUMS")"
	[ -n "$expected" ] || die "$SUMS has no entry for $ARCHIVE"
	actual="$(/usr/bin/shasum -a 256 "$TMP/$ARCHIVE" | awk '{ print $1 }')"
	[ "$expected" = "$actual" ] || die "checksum mismatch for $ARCHIVE: expected $expected, got $actual"

	# Unpack beside APP_DIR so the swap is two renames on one filesystem.
	mkdir -p "$(dirname "$APP_DIR")"
	rm -rf "$STAGE"
	mkdir "$STAGE"
	say "unpacking"
	/usr/bin/tar -xzf "$TMP/$ARCHIVE" -C "$STAGE" || die "could not unpack $ARCHIVE"
	[ -f "$STAGE/code-foundry" ] && [ -x "$STAGE/code-foundry" ] || die "the archive has no code-foundry executable"
	[ -f "$STAGE/Code Foundry" ] && [ -x "$STAGE/Code Foundry" ] || die "the archive has no Code Foundry executable"
	got="$(installed_version "$STAGE")"
	[ "$got" = "$TAG" ] || die "the archive contains version '$got', expected $TAG"
	# Belt and braces: gh does not quarantine downloads, but a copied archive might be, and
	# tar propagates the attribute to what it extracts.
	/usr/bin/xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true
}

if [ "$APPLY_STAGED" = 1 ]; then
	check_staged
else
	stage_download
fi
if [ "$STAGE_ONLY" = 1 ]; then
	KEEP_STAGE=1
	say "downloaded $TAG to $STAGE"
	exit 0
fi

# ---- install -----------------------------------------------------------------------------


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
	echo "    its threads and its old version until: code-foundry daemon restart"
fi
for old_app in "$HOME/Applications/CodeFoundry.app" "/Applications/CodeFoundry.app"; do
	if [ -d "$old_app" ]; then
		echo "    The old app bundle $old_app is no longer used; quit it and remove it:"
		echo "      rm -rf \"$old_app\""
	fi
done
