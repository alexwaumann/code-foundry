#!/usr/bin/env bash
# Fetches the pinned official ripgrep release binary (darwin arm64) into a per-user cache
# shared by every checkout and worktree:
#   $RIPGREP_CACHE/<key>/rg   (default ~/Library/Caches/code-foundry/ripgrep)
# where <key> is `--print-key` (version + target + the first 8 hex of the archive's
# sha256). Idempotent: exits early when the binary is there. The archive's sha256 is
# checked against the pin before anything is unpacked, and only `rg` is taken from it.
# `make build` copies it to bin/code-foundry-rg, which `make package` ships beside the
# daemon (docs/notes/file-search-3-ripgrep.md). Its licences are in
# scripts/THIRD-PARTY-NOTICES.txt, which ships with it.
#
# Official binaries rather than a source build: they are what ripgrep's own release
# publishes, statically link PCRE2, need only libSystem and libiconv, target macOS 11, and
# building from source would need a Rust toolchain on every machine and runner.
set -euo pipefail

# ---- pins ------------------------------------------------------------------------------
RG_VERSION="15.2.0"
RG_TARGET="aarch64-apple-darwin"
# sha256 of ripgrep-<version>-<target>.tar.gz: the release's own .sha256 asset and the
# asset digest GitHub reports agree on it.
RG_SHA256="3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"
# ----------------------------------------------------------------------------------------

NAME="ripgrep-${RG_VERSION}-${RG_TARGET}"
URL="https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${NAME}.tar.gz"
KEY="${NAME}-${RG_SHA256:0:8}"
CACHE="${RIPGREP_CACHE:-${HOME}/Library/Caches/code-foundry/ripgrep}"
DIR="${CACHE}/${KEY}"
BIN="${DIR}/rg"

# `--print-key` prints the cache key (CI uses it), `--print-prefix` the cache directory,
# `--print-bin` the binary, `--print-version` the pinned version (package.sh checks the
# shipped binary against it).
case "${1:-}" in
--print-key)
	printf '%s\n' "${KEY}"
	exit 0
	;;
--print-prefix)
	printf '%s\n' "${DIR}"
	exit 0
	;;
--print-bin)
	printf '%s\n' "${BIN}"
	exit 0
	;;
--print-version)
	printf '%s\n' "${RG_VERSION}"
	exit 0
	;;
esac

log() { printf 'ripgrep: %s\n' "$*" >&2; }

if [[ -x "${BIN}" ]]; then
	exit 0
fi

if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
	log "only Apple silicon Macs are supported (this is $(uname -s)/$(uname -m))"
	exit 1
fi

mkdir -p "${CACHE}"
WORK="$(mktemp -d "${CACHE}/.fetch.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

log "downloading ${NAME}"
curl --fail --silent --show-error --location --retry 3 --proto '=https' --tlsv1.2 \
	-o "${WORK}/rg.tar.gz" "${URL}"
got="$(shasum -a 256 "${WORK}/rg.tar.gz" | cut -d' ' -f1)"
if [[ "${got}" != "${RG_SHA256}" ]]; then
	log "checksum mismatch for ${NAME}.tar.gz: got ${got}, want ${RG_SHA256}"
	exit 1
fi

mkdir "${WORK}/x"
tar -xzf "${WORK}/rg.tar.gz" -C "${WORK}/x" "${NAME}/rg"
rg="${WORK}/x/${NAME}/rg"
if [[ ! -f "${rg}" || -L "${rg}" ]]; then
	log "the archive has no rg executable"
	exit 1
fi
chmod 755 "${rg}"
first="$("${rg}" --version | head -n 1)"
case "${first}" in
"ripgrep ${RG_VERSION}"*) ;;
*)
	log "the downloaded rg reports '${first}', want ripgrep ${RG_VERSION}"
	exit 1
	;;
esac

# Moved into place last (one rename on the cache's filesystem): its presence marks a
# finished fetch.
mkdir -p "${DIR}"
mv "${rg}" "${BIN}"
log "done: ${BIN}"
