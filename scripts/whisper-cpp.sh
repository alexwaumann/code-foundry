#!/usr/bin/env bash
# Builds whisper.cpp (static libs, Metal shaders embedded) from a pinned release tag into a
# per-user cache shared by every checkout and worktree:
#   $WHISPER_CPP_CACHE/<key>/whisper-cpp   (default ~/Library/Caches/code-foundry/whisper-cpp)
# where <key> is `--print-key` (tag + arch + a short hash of the cmake flags). Idempotent:
# exits early when the pkg-config file exists. The source and the build tree are deleted
# after a successful build. Called by `make whisper-cpp`; the Makefile reads the prefix
# with `--print-prefix` and the key with `--print-key`. cmd/code-foundry-dictate links it
# through the pkg-config file this script writes (whisper-cpp-static.pc). See
# docs/notes/dictation-1-engine.md.
#
# Many worktrees build at once, so the build is shared and atomic: one build per machine
# under a per-key lock, done in a temporary directory inside the cache and renamed into
# place, so nobody ever sees a half-installed prefix. Only this key's prefix, lock and
# temporary directories are ever written or removed. See docs/notes/whisper-cpp-shared-cache.md.
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
PC_REL="share/pkgconfig/whisper-cpp-static.pc"
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

# Left behind only by a killed build of this key; nothing else can be using them while the
# lock is held. A prefix without a .pc is the same: a build that never finished.
mkdir -p "${CACHE}/${KEY}"
rm -rf "${CACHE}/${KEY}"/.tmp.*
if [[ -e "${PREFIX}" ]]; then
	log "removing incomplete ${PREFIX}"
	rm -rf "${PREFIX}"
fi

# The source, the build tree and the staged prefix all live here and go with it.
WORK="$(mktemp -d "${CACHE}/${KEY}/.tmp.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
SRC="${WORK}/whisper-src"
STAGE="${WORK}/prefix"

# ---- source ----------------------------------------------------------------------------
log "fetching whisper.cpp ${WHISPER_TAG} (shallow)"
git init -q "${SRC}"
git -C "${SRC}" remote add origin "${WHISPER_REPO}"
git -C "${SRC}" fetch -q --depth 1 origin "refs/tags/${WHISPER_TAG}"
git -C "${SRC}" checkout -q --detach FETCH_HEAD
got="$(git -C "${SRC}" rev-parse HEAD)"
if [[ "${got}" != "${WHISPER_COMMIT}" ]]; then
	log "tag ${WHISPER_TAG} is at ${got}, want ${WHISPER_COMMIT}"
	exit 1
fi

# ---- build -----------------------------------------------------------------------------
# Configured for the final prefix, so anything cmake bakes in names where the directory
# is about to be renamed to, and installed into the staging directory.
log "building whisper.cpp ${WHISPER_TAG} into ${PREFIX}"
cmake -S "${SRC}" -B "${WORK}/out" -DCMAKE_INSTALL_PREFIX="${PREFIX}" "${CMAKE_FLAGS[@]}" >&2
cmake --build "${WORK}/out" --config Release -j "$(sysctl -n hw.ncpu)" >&2
cmake --install "${WORK}/out" --prefix "${STAGE}" >&2

# One pkg-config file with every static library the build produced, in link order
# (whisper first, ggml's base last), plus the system frameworks they need. It names the
# final prefix, so the directory cannot be moved afterwards.
libs=""
for lib in whisper ggml ggml-metal ggml-blas ggml-cpu ggml-base; do
	if [[ -f "${STAGE}/lib/lib${lib}.a" ]]; then
		libs="${libs} -l${lib}"
	fi
done
for lib in whisper ggml ggml-base ggml-cpu ggml-metal; do
	if [[ ! -f "${STAGE}/lib/lib${lib}.a" ]]; then
		log "build finished but lib/lib${lib}.a is missing"
		exit 1
	fi
done
mkdir -p "$(dirname "${STAGE}/${PC_REL}")"
cat >"${STAGE}/${PC_REL}" <<EOF
prefix=${PREFIX}
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: whisper-cpp-static
Description: whisper.cpp ${WHISPER_TAG} static libraries with Metal (code-foundry)
Version: ${WHISPER_TAG#v}
Cflags: -I\${includedir}
Libs: -L\${libdir}${libs} -lc++ -framework Accelerate -framework Foundation -framework Metal -framework MetalKit
EOF

# One rename on the cache's filesystem: the prefix appears complete or not at all. The
# source and the build tree go with ${WORK} on exit.
mv "${STAGE}" "${PREFIX}"
log "done: ${PREFIX}"
