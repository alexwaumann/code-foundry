#!/usr/bin/env bash
# Builds whisper.cpp (static libs, Metal shaders embedded) from a pinned release tag into a
# per-user cache shared by every checkout and worktree:
#   $WHISPER_CPP_CACHE/<key>/whisper-cpp   (default ~/Library/Caches/code-foundry/whisper-cpp)
# where <key> is `--print-key` (tag + arch + a short hash of the cmake flags). Idempotent:
# exits early when the pkg-config file exists. The source and the build tree are deleted
# after a successful build. Called by `make whisper-cpp`; the Makefile reads the prefix
# with `--print-prefix`. cmd/code-foundry-dictate links it through the pkg-config file
# this script writes (whisper-cpp-static.pc). See docs/notes/dictation-1-engine.md.
#
# Needs cmake (brew install cmake) and the Xcode command line tools. Apple silicon only.
set -euo pipefail

# ---- pins ------------------------------------------------------------------------------
WHISPER_REPO="https://github.com/ggml-org/whisper.cpp.git"
WHISPER_TAG="v1.9.5"
# The commit the tag points at, checked after the fetch so a moved tag fails the build.
WHISPER_COMMIT="d1be6fde11ac6e0407606b4e42fe72d34add8037"
# GGML_NATIVE=OFF: a release is built on a CI runner and must run on every M-series chip,
# so no -mcpu=native (clang's arm64 default is the M1 baseline). Metal does the work.
CMAKE_FLAGS=(
	-DCMAKE_BUILD_TYPE=Release
	-DCMAKE_OSX_ARCHITECTURES=arm64
	-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0
	-DBUILD_SHARED_LIBS=OFF
	-DGGML_NATIVE=OFF
	-DGGML_METAL=ON
	-DGGML_METAL_EMBED_LIBRARY=ON
	-DWHISPER_BUILD_EXAMPLES=OFF
	-DWHISPER_BUILD_TESTS=OFF
	-DWHISPER_BUILD_SERVER=OFF
)
# ----------------------------------------------------------------------------------------

FLAGS_HASH="$(printf '%s\n' "${CMAKE_FLAGS[@]}" | shasum -a 256 | cut -c1-8)"
KEY="whisper-cpp-${WHISPER_TAG}-$(uname -m)-${FLAGS_HASH}"
CACHE="${WHISPER_CPP_CACHE:-${HOME}/Library/Caches/code-foundry/whisper-cpp}"
PREFIX="${CACHE}/${KEY}/whisper-cpp"
BUILD="${CACHE}/${KEY}/build"
SRC="${BUILD}/whisper-src"
PC="${PREFIX}/share/pkgconfig/whisper-cpp-static.pc"

# `--print-key` prints the cache key (CI uses it); `--print-prefix` the install prefix.
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

log() { printf 'whisper-cpp: %s\n' "$*" >&2; }

if [[ -f "${PC}" ]]; then
	exit 0
fi

if [[ "$(uname -s)/$(uname -m)" != "Darwin/arm64" ]]; then
	log "only Apple silicon Macs are supported (this is $(uname -s)/$(uname -m))"
	exit 1
fi
if ! command -v cmake >/dev/null 2>&1; then
	log "cmake is required to build whisper.cpp: brew install cmake"
	exit 1
fi

mkdir -p "${BUILD}"

# ---- source ----------------------------------------------------------------------------
if [[ "$(git -C "${SRC}" rev-parse HEAD 2>/dev/null || true)" != "${WHISPER_COMMIT}" ]]; then
	log "fetching whisper.cpp ${WHISPER_TAG} (shallow)"
	rm -rf "${SRC}"
	git init -q "${SRC}"
	git -C "${SRC}" remote add origin "${WHISPER_REPO}"
	git -C "${SRC}" fetch -q --depth 1 origin "refs/tags/${WHISPER_TAG}"
	git -C "${SRC}" checkout -q --detach FETCH_HEAD
	got="$(git -C "${SRC}" rev-parse HEAD)"
	if [[ "${got}" != "${WHISPER_COMMIT}" ]]; then
		log "tag ${WHISPER_TAG} is at ${got}, want ${WHISPER_COMMIT}"
		exit 1
	fi
fi

# ---- build -----------------------------------------------------------------------------
log "building whisper.cpp ${WHISPER_TAG} into ${PREFIX}"
rm -rf "${PREFIX}" "${BUILD}/out"
cmake -S "${SRC}" -B "${BUILD}/out" -DCMAKE_INSTALL_PREFIX="${PREFIX}" "${CMAKE_FLAGS[@]}" >&2
cmake --build "${BUILD}/out" --config Release -j "$(sysctl -n hw.ncpu)" >&2
cmake --install "${BUILD}/out" >&2

# One pkg-config file with every static library the build produced, in link order
# (whisper first, ggml's base last), plus the system frameworks they need. Written last:
# its presence marks a finished build.
libs=""
for lib in whisper ggml ggml-metal ggml-blas ggml-cpu ggml-base; do
	if [[ -f "${PREFIX}/lib/lib${lib}.a" ]]; then
		libs="${libs} -l${lib}"
	fi
done
for lib in whisper ggml ggml-base ggml-cpu ggml-metal; do
	if [[ ! -f "${PREFIX}/lib/lib${lib}.a" ]]; then
		log "build finished but ${PREFIX}/lib/lib${lib}.a is missing"
		exit 1
	fi
done
mkdir -p "$(dirname "${PC}")"
cat >"${PC}" <<EOF
prefix=${PREFIX}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: whisper-cpp-static
Description: whisper.cpp ${WHISPER_TAG} static libraries with Metal (code-foundry)
Version: ${WHISPER_TAG#v}
Cflags: -I\${includedir}
Libs: -L\${libdir}${libs} -lc++ -framework Accelerate -framework Foundation -framework Metal -framework MetalKit
EOF
# The source and the build tree are only needed to produce the prefix.
rm -rf "${BUILD}"
log "done: ${PREFIX}"
