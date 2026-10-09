#!/usr/bin/env bash
# Rebuilds the vendored libghostty-vt (third_party/libghostty-vt) from source: downloads
# a pinned zig and shallow-fetches a pinned ghostty commit into third_party/build/
# (gitignored), builds the static library, and replaces the vendored lib/, include/, and
# MANIFEST. Always rebuilds. Called by `make ghostty-vt-rebuild`; only needed when bumping.
# See docs/notes/vendored-libghostty-vt.md.
#
# The Go bindings (go.mitchellh.com/libghostty, pinned in go.mod) track a specific
# ghostty commit; bump GHOSTTY_COMMIT only together with that module version.
set -euo pipefail

# ---- pins ------------------------------------------------------------------------------
GHOSTTY_REPO="https://github.com/ghostty-org/ghostty.git"
GHOSTTY_COMMIT="34f39002c6e3974b54e6a6d400bd83777c5ea558"
ZIG_VERSION="0.16.0"
# sha256 from https://ziglang.org/download/index.json (cross-checked at download).
ZIG_SHA256_aarch64="b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489"
OPTIMIZE="ReleaseFast"
# strip -S drops debug info only (11.1 MB -> 2.6 MB); the Go binary is the same size
# either way. With ZERO_AR_DATE=1 the stripped archive is byte-for-byte reproducible
# (same pins -> same sha256); the unstripped one embeds build paths. STRIP=0 vendors
# the unstripped library.
STRIP="${STRIP:-1}"
# ----------------------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD="${ROOT}/third_party/build"
SRC="${BUILD}/ghostty-src"
ZIG_DIR="${BUILD}/zig"
PREFIX="${BUILD}/ghostty-vt"
VENDOR="${ROOT}/third_party/libghostty-vt"

log() { printf 'ghostty-vt: %s\n' "$*" >&2; }

# The vendored library ships darwin-arm64 only.
if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
	log "rebuild on an Apple silicon Mac (the vendored library is darwin-arm64)"
	exit 1
fi
ARCH=aarch64
ZIG_SHA256="${ZIG_SHA256_aarch64}"

bindings="$(awk '$1 == "go.mitchellh.com/libghostty" { print $2 }' "${ROOT}/go.mod")"
if [[ -z "${bindings}" ]]; then
	log "go.mitchellh.com/libghostty not found in go.mod"
	exit 1
fi

mkdir -p "${BUILD}"

# ---- zig -------------------------------------------------------------------------------
ZIG_NAME="zig-${ARCH}-macos-${ZIG_VERSION}"
ZIG="${ZIG_DIR}/${ZIG_NAME}/zig"
if [[ ! -x "${ZIG}" ]]; then
	log "downloading ${ZIG_NAME}"
	tmp="$(mktemp -d)"
	trap 'rm -rf "${tmp}"' EXIT
	curl -fsSL --retry 3 -o "${tmp}/index.json" https://ziglang.org/download/index.json
	# Cross-check the pin against the published index (no jq dependency).
	if ! grep -A4 "\"${ARCH}-macos\"" "${tmp}/index.json" | grep -q "${ZIG_SHA256}"; then
		log "pinned sha256 for ${ZIG_NAME} not found in ziglang.org index.json"
		exit 1
	fi
	curl -fsSL --retry 3 -o "${tmp}/zig.tar.xz" \
		"https://ziglang.org/download/${ZIG_VERSION}/${ZIG_NAME}.tar.xz"
	got="$(shasum -a 256 "${tmp}/zig.tar.xz" | cut -d' ' -f1)"
	if [[ "${got}" != "${ZIG_SHA256}" ]]; then
		log "sha256 mismatch for ${ZIG_NAME}: got ${got}, want ${ZIG_SHA256}"
		exit 1
	fi
	rm -rf "${ZIG_DIR}"
	mkdir -p "${ZIG_DIR}"
	tar -xJf "${tmp}/zig.tar.xz" -C "${ZIG_DIR}"
	rm -rf "${tmp}"
	trap - EXIT
fi
got_version="$("${ZIG}" version)"
if [[ "${got_version}" != "${ZIG_VERSION}" ]]; then
	log "zig version ${got_version}, want ${ZIG_VERSION}"
	exit 1
fi

# ---- ghostty source --------------------------------------------------------------------
if [[ "$(git -C "${SRC}" rev-parse HEAD 2>/dev/null || true)" != "${GHOSTTY_COMMIT}" ]]; then
	log "fetching ghostty ${GHOSTTY_COMMIT} (shallow)"
	rm -rf "${SRC}"
	git init -q "${SRC}"
	git -C "${SRC}" remote add origin "${GHOSTTY_REPO}"
	git -C "${SRC}" fetch -q --depth 1 origin "${GHOSTTY_COMMIT}"
	git -C "${SRC}" checkout -q --detach FETCH_HEAD
fi

# ---- build -----------------------------------------------------------------------------
# -Demit-xcframework=false: the xcframework step needs full Xcode, not just the CLT.
# zig fetches ghostty's build dependencies (some from codeberg.org) on a cold cache.
log "building libghostty-vt (${OPTIMIZE}) into ${PREFIX}"
rm -rf "${PREFIX}"
(
	cd "${SRC}"
	"${ZIG}" build \
		-Demit-lib-vt \
		-Demit-xcframework=false \
		-Doptimize="${OPTIMIZE}" \
		--prefix "${PREFIX}"
)
LIB="${PREFIX}/lib/libghostty-vt.a"
PC="${PREFIX}/share/pkgconfig/libghostty-vt-static.pc"
for f in "${LIB}" "${PC}" "${PREFIX}/include/ghostty/vt.h"; do
	if [[ ! -f "${f}" ]]; then
		log "build finished but ${f} is missing"
		exit 1
	fi
done
lib_arch="$(lipo -archs "${LIB}")"
if [[ "${lib_arch}" != "arm64" ]]; then
	log "built ${LIB} for '${lib_arch}', want arm64"
	exit 1
fi
lib_version="$(awk -F': ' '$1 == "Version" { print $2 }' "${PC}")"

# ---- vendor ----------------------------------------------------------------------------
staged="$(mktemp -d)"
trap 'rm -rf "${staged}"' EXIT
cp "${LIB}" "${staged}/libghostty-vt.a"
stripped=false
if [[ "${STRIP}" == "1" ]]; then
	ZERO_AR_DATE=1 strip -S "${staged}/libghostty-vt.a"
	stripped=true
fi
size_before="$(stat -f %z "${LIB}")"
size_after="$(stat -f %z "${staged}/libghostty-vt.a")"

log "vendoring into ${VENDOR} (${size_before} -> ${size_after} bytes)"
mkdir -p "${VENDOR}/lib"
rm -rf "${VENDOR}/include" "${VENDOR}/share"
cp -R "${PREFIX}/include" "${VENDOR}/include"
mv "${staged}/libghostty-vt.a" "${VENDOR}/lib/libghostty-vt.a"
cat >"${VENDOR}/MANIFEST" <<MANIFEST
ghostty_repo: ${GHOSTTY_REPO}
ghostty_commit: ${GHOSTTY_COMMIT}
go_bindings_version: ${bindings}
zig_version: ${ZIG_VERSION}
optimize: ${OPTIMIZE}
arch: ${lib_arch}
lib_version: ${lib_version}
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
stripped: ${stripped}
sha256: $(shasum -a 256 "${VENDOR}/lib/libghostty-vt.a" | cut -d' ' -f1)
MANIFEST
log "done; run make check and commit third_party/libghostty-vt"
