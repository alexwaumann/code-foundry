#!/usr/bin/env bash
# Fetches the official prebuilt libghostty-vt (static, universal arm64 + x86_64, macOS
# 13.0) into a per-user cache shared by every checkout and worktree:
#   $GHOSTTY_VT_CACHE/<key>/   (default ~/Library/Caches/code-foundry/ghostty-vt)
# where <key> is `--print-key` (version + the first 8 hex of the archive's sha256). The
# prefix holds include/ghostty/, lib/libghostty-vt.a and lib/pkgconfig/
# libghostty-vt-static.pc, which this script writes: the release ships no pkg-config
# file, and the Go bindings link through one. Idempotent: exits early when the .pc is
# there. Called by `make ghostty-vt`; the Makefile reads the prefix with `--print-prefix`
# and the key with `--print-key`. See docs/notes/libghostty-vt-prebuilt.md.
#
# Many worktrees build at once, so the install is shared and atomic: one download per
# machine under a per-key lock, unpacked into a temporary directory inside the cache and
# renamed into place, so nobody ever sees a half-written prefix. Only this key's prefix,
# lock and temporary directories are ever written or removed; entries for other pins
# (older worktrees still on them, including the zig-built ones) are left alone.
#
# The Go bindings (go.mitchellh.com/libghostty, pinned in go.mod) target a libghostty-vt
# 1.x; a later 1.x library works with earlier 1.x headers (lib.ghostty.org/vt/stability).
set -euo pipefail

# ---- pins ------------------------------------------------------------------------------
# A new version changes what is linked into code-foundry: redo its section of
# scripts/THIRD-PARTY-NOTICES.txt from the release's deps/libghostty-vt-third-party.json
# (docs/notes/libghostty-vt-notices.md).
VT_VERSION="1.0.1"
# sha256 of ghostty-vt-<version>.xcframework.zip, as in the release's SHA256SUMS.
VT_SHA256="c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b"
# ----------------------------------------------------------------------------------------

NAME="ghostty-vt-${VT_VERSION}.xcframework.zip"
URL="https://release.files.ghostty.org/libghostty-vt/${VT_VERSION}/${NAME}"
# The slice of the xcframework that is macOS; the others are iOS.
SLICE="ghostty-vt.xcframework/macos-arm64_x86_64"
KEY="libghostty-vt-${VT_VERSION}-${VT_SHA256:0:8}"
CACHE="${GHOSTTY_VT_CACHE:-${HOME}/Library/Caches/code-foundry/ghostty-vt}"
PREFIX="${CACHE}/${KEY}"
PC_REL="lib/pkgconfig/libghostty-vt-static.pc"
PC="${PREFIX}/${PC_REL}"
LOCK="${CACHE}/${KEY}.lock"

# `--print-key` prints the cache key (CI and the Makefile use it); `--print-prefix` the
# install prefix.
case "${1:-}" in
--print-key)
	printf '%s\n' "${KEY}"
	exit 0
	;;
--print-prefix)
	printf '%s\n' "${PREFIX}"
	exit 0
	;;
esac

log() { printf 'ghostty-vt: %s\n' "$*" >&2; }

if [[ -f "${PC}" ]]; then
	exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
	log "only macOS is supported"
	exit 1
fi

# Everything below runs once per machine at a time: re-run this script under the kernel
# lock on this key (lockf frees it if the holder dies). A waiter finds the .pc on its
# second look and exits.
if [[ "${1:-}" != "--locked" ]]; then
	mkdir -p "${CACHE}"
	exec lockf -k "${LOCK}" "$0" --locked
fi
if [[ -f "${PC}" ]]; then
	exit 0
fi

# Left behind only by a killed install of this key; nothing else can be using them while
# the lock is held. A prefix without a .pc is the same: an install that never finished.
rm -rf "${CACHE}/.${KEY}".tmp.*
if [[ -e "${PREFIX}" ]]; then
	log "removing incomplete ${PREFIX}"
	rm -rf "${PREFIX}"
fi

WORK="$(mktemp -d "${CACHE}/.${KEY}.tmp.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

log "downloading ${NAME}"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
	-o "${WORK}/vt.zip" "${URL}"
got="$(shasum -a 256 "${WORK}/vt.zip" | cut -d' ' -f1)"
if [[ "${got}" != "${VT_SHA256}" ]]; then
	log "checksum mismatch for ${NAME}: got ${got}, want ${VT_SHA256}"
	exit 1
fi

mkdir "${WORK}/x" "${WORK}/prefix"
unzip -q "${WORK}/vt.zip" "${SLICE}/*" -d "${WORK}/x"
lib="${WORK}/x/${SLICE}/libghostty-vt.a"
hdr="${WORK}/x/${SLICE}/Headers/ghostty"
if [[ ! -f "${lib}" || -L "${lib}" || ! -f "${hdr}/vt.h" ]]; then
	log "the archive has no ${SLICE}/libghostty-vt.a or Headers/ghostty/vt.h"
	exit 1
fi
if ! grep -q "#define GHOSTTY_VT_VERSION \"${VT_VERSION}\"" "${hdr}/vt/version.h"; then
	log "the headers are not libghostty-vt ${VT_VERSION}"
	exit 1
fi
mkdir -p "${WORK}/prefix/include" "${WORK}/prefix/lib/pkgconfig"
mv "${hdr}" "${WORK}/prefix/include/ghostty"
mv "${lib}" "${WORK}/prefix/lib/libghostty-vt.a"

# The prefix is absolute and final: the .pc is written for where the directory is about
# to be renamed to, so the directory cannot be moved afterwards.
cat >"${WORK}/prefix/${PC_REL}" <<EOF
prefix=${PREFIX}
includedir=\${prefix}/include
libdir=\${prefix}/lib

Name: libghostty-vt-static
URL: https://lib.ghostty.org/vt/
Description: Ghostty VT library (static, official prebuilt ${VT_VERSION})
Version: ${VT_VERSION}
Cflags: -I\${includedir}
Libs: \${libdir}/libghostty-vt.a
EOF

# One rename on the cache's filesystem: the prefix appears complete or not at all.
mv "${WORK}/prefix" "${PREFIX}"
log "done: ${PREFIX}"
