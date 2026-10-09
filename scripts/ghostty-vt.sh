#!/usr/bin/env bash
# Builds libghostty-vt (static) from a pinned ghostty commit with a pinned zig into
# third_party/ghostty-vt. Idempotent: exits early when the pkg-config file exists.
# Called by `make ghostty-vt`. See docs/notes/phase1a-terminal.md.
#
# The Go bindings (go.mitchellh.com/libghostty, pinned in go.mod) track a specific
# ghostty commit; bump GHOSTTY_COMMIT only together with that module version.
set -euo pipefail

# ---- pins ------------------------------------------------------------------------------
GHOSTTY_REPO="https://github.com/ghostty-org/ghostty.git"
GHOSTTY_COMMIT="34f39002c6e3974b54e6a6d400bd83777c5ea558"
ZIG_VERSION="0.16.0"
# sha256 values from https://ziglang.org/download/index.json (cross-checked at download).
ZIG_SHA256_aarch64="b23d70deaa879b5c2d486ed3316f7eaa53e84acf6fc9cc747de152450d401489"
ZIG_SHA256_x86_64="0387557ed1877bc6a2e1802c8391953baddba76081876301c522f52977b52ba7"
# ----------------------------------------------------------------------------------------

# `ghostty-vt.sh --print-key` prints a cache key for CI.
if [[ "${1:-}" == "--print-key" ]]; then
	printf 'ghostty-vt-%s-zig-%s-%s\n' "${GHOSTTY_COMMIT}" "${ZIG_VERSION}" "$(uname -m)"
	exit 0
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
THIRD_PARTY="${ROOT}/third_party"
PREFIX="${THIRD_PARTY}/ghostty-vt"
SRC="${THIRD_PARTY}/ghostty-src"
ZIG_DIR="${THIRD_PARTY}/zig"
PC="${PREFIX}/share/pkgconfig/libghostty-vt-static.pc"

log() { printf 'ghostty-vt: %s\n' "$*" >&2; }

if [[ -f "${PC}" ]]; then
	exit 0
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
	log "only macOS is supported"
	exit 1
fi
case "$(uname -m)" in
arm64 | aarch64) ARCH=aarch64 ZIG_SHA256="${ZIG_SHA256_aarch64}" ;;
x86_64) ARCH=x86_64 ZIG_SHA256="${ZIG_SHA256_x86_64}" ;;
*)
	log "unsupported arch $(uname -m)"
	exit 1
	;;
esac

mkdir -p "${THIRD_PARTY}"

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
# The generated .pc files hardcode PREFIX, so the output cannot be moved afterwards.
log "building libghostty-vt into ${PREFIX}"
rm -rf "${PREFIX}"
(
	cd "${SRC}"
	"${ZIG}" build \
		-Demit-lib-vt \
		-Demit-xcframework=false \
		-Doptimize=ReleaseFast \
		--prefix "${PREFIX}"
)
if [[ ! -f "${PC}" ]]; then
	log "build finished but ${PC} is missing"
	exit 1
fi
log "done"
