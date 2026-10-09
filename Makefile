# code-foundry build entry points. See docs/notes/phase0.md.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# buf and wails3 are installed with `go install` into GOPATH/bin. macOS's make 3.81
# ignores an exported PATH when it looks up recipe commands itself, so reference the
# tools through variables; the export still covers child processes (wails3 -> task).
GOBIN_DIR := $(shell go env GOPATH)/bin
export PATH := $(GOBIN_DIR):$(PATH)
BUF    ?= $(shell command -v buf 2>/dev/null || echo $(GOBIN_DIR)/buf)
WAILS3 ?= $(shell command -v wails3 2>/dev/null || echo $(GOBIN_DIR)/wails3)

# One macOS deployment target for every cgo object we link, so the linker does not warn
# "built for newer macOS version". The vendored libghostty-vt was built by zig for
# ghostty's minimum, macOS 13.0, so Go builds target 13.0. (The Wails Taskfile still
# builds the GUI binary for 12.0; it does not link libghostty-vt.)
export MACOSX_DEPLOYMENT_TARGET := 13.0
export CGO_CFLAGS  := -mmacosx-version-min=13.0
export CGO_LDFLAGS := -mmacosx-version-min=13.0

# libghostty-vt (static, darwin-arm64) is vendored prebuilt in third_party/libghostty-vt
# (lib/, include/, MANIFEST); no zig or ghostty checkout is needed to build. The Go
# bindings link it via `#cgo pkg-config: --static libghostty-vt-static`, so `make
# ghostty-vt` writes that .pc with this checkout's absolute prefix into the gitignored
# share/pkgconfig. `make ghostty-vt-rebuild` rebuilds the vendored files from source
# (scripts/ghostty-vt.sh holds the pins). See docs/notes/vendored-libghostty-vt.md.
GHOSTTY_VT_DIR      := $(CURDIR)/third_party/libghostty-vt
GHOSTTY_VT_MANIFEST := $(GHOSTTY_VT_DIR)/MANIFEST
GHOSTTY_VT_PC_DIR   := $(GHOSTTY_VT_DIR)/share/pkgconfig
GHOSTTY_VT_PC       := $(GHOSTTY_VT_PC_DIR)/libghostty-vt-static.pc
export PKG_CONFIG_PATH := $(GHOSTTY_VT_PC_DIR)$(if $(PKG_CONFIG_PATH),:$(PKG_CONFIG_PATH))

VERSION  ?= dev
# GitHub repository the in-app updater and install.sh download releases from.
RELEASE_REPO ?= alexwaumann/code-foundry
# One set of version ldflags for both binaries (the CLI here, the GUI via scripts/package.sh).
LDFLAGS  := -X github.com/alexwaumann/code-foundry/internal/version.Version=$(VERSION) \
            -X github.com/alexwaumann/code-foundry/internal/version.ReleaseRepo=$(RELEASE_REPO)
FRONTEND := gui/frontend
PNPM     := pnpm --dir $(FRONTEND)

.PHONY: all gen build check go-check frontend-check frontend-deps gui-dist-stub \
        dev gui-build gui-bin gui-dev gui-e2e gui-mock ghostty-vt ghostty-vt-rebuild package \
        release clean

all: build

## gen: regenerate protobuf/Connect code (Go + TS) and Wails bindings. Commit the result.
gen:
	$(BUF) lint
	$(BUF) generate
	cd gui && $(WAILS3) generate bindings -clean=true -ts -i

## build: build the CLI/daemon binary to ./bin/code-foundry.
build: ghostty-vt
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/code-foundry ./cmd/code-foundry

## check: everything CI runs.
check: go-check frontend-check

# gui/main.go embeds gui/frontend/dist, which only exists after a frontend build. Go
# vet/staticcheck/test compile the gui package, so give them a placeholder if needed.
gui-dist-stub:
	@if [ -z "$$(ls -A $(FRONTEND)/dist 2>/dev/null)" ]; then \
		mkdir -p $(FRONTEND)/dist; \
		echo '<!doctype html><p>Frontend not built. Run <code>wails3 build</code> in gui/.</p>' > $(FRONTEND)/dist/index.html; \
	fi

go-check: gui-dist-stub ghostty-vt
	@unformatted=$$(gofmt -l cmd internal gui/*.go 2>/dev/null); if [ -n "$$unformatted" ]; then echo "gofmt needed:" $$unformatted; exit 1; fi
	go vet ./...
	go tool staticcheck ./...
	go test -race ./...

frontend-deps:
	$(PNPM) install --frozen-lockfile

frontend-check: frontend-deps
	$(PNPM) run typecheck
	$(PNPM) run lint
	$(PNPM) run test

## dev: run the daemon in the foreground with text logs on stderr.
# Builds then execs the binary (not `go run`, which exits 1 on Ctrl-C).
dev: build
	exec ./bin/code-foundry daemon --dev

## gui-build: build the Wails GUI and bundle it as gui/bin/CodeFoundry.app (ad-hoc signed),
## which is what `code-foundry gui` launches from a dev CLI. Also leaves gui/bin/CodeFoundry.
gui-build: build
	cd gui && $(WAILS3) package

## gui-bin: build only the bare GUI executable, gui/bin/CodeFoundry, with no .app bundle,
## for machines whose MDM blocks unsigned bundles. Removes a stale gui/bin/CodeFoundry.app
## so `code-foundry gui` launches the executable (it prefers the bundle when one exists).
gui-bin: build
	cd gui && $(WAILS3) build
	rm -rf gui/bin/CodeFoundry.app

## gui-e2e: Playwright (WebKit + Chromium) against the mock daemon. Not part of `check`:
## it needs browser binaries (`pnpm --dir gui/frontend exec playwright install webkit chromium`).
gui-e2e: frontend-deps
	$(PNPM) run e2e

## gui-mock: run the mock daemon on :7788 (token dev-mock-token); pair with `pnpm run dev:mock`.
gui-mock: frontend-deps
	$(PNPM) run mock

## gui-dev: run the GUI with hot reload (auto-starts ./bin/code-foundry daemon if needed).
gui-dev: build
	cd gui && $(WAILS3) dev

## package: release assets in dist/ (VERSION=vX.Y.Z required): the app zip with the CLI
## inside, the standalone CLI, install.sh, checksums.txt. See scripts/package.sh.
package: ghostty-vt frontend-deps
	VERSION=$(VERSION) RELEASE_REPO=$(RELEASE_REPO) WAILS3=$(WAILS3) MAKE=$(MAKE) ./scripts/package.sh

## release: manual fallback for .github/workflows/release.yml. Next version from
## conventional commits unless VERSION=vX.Y.Z is given; DRY_RUN=1 prints the commands.
release:
	./scripts/release.sh $(if $(DRY_RUN),--dry-run) $(filter-out dev,$(VERSION))

## ghostty-vt: check the vendored libghostty-vt against its MANIFEST (sha256, go.mod
## bindings version) and write its pkg-config file for this checkout. Cheap; runs every build.
ghostty-vt:
	@manifest() { awk -v k="$$1:" '$$1 == k { print $$2 }' "$(GHOSTTY_VT_MANIFEST)"; }; \
	want="$$(manifest sha256)"; \
	got="$$(shasum -a 256 "$(GHOSTTY_VT_DIR)/lib/libghostty-vt.a" | cut -d' ' -f1)"; \
	if [ -z "$$want" ] || [ "$$got" != "$$want" ]; then \
		echo "ghostty-vt: third_party/libghostty-vt/lib/libghostty-vt.a has sha256 $$got," >&2; \
		echo "ghostty-vt: MANIFEST says '$$want'. Restore it with git or run 'make ghostty-vt-rebuild'." >&2; \
		exit 1; \
	fi; \
	bindings="$$(awk '$$1 == "go.mitchellh.com/libghostty" { print $$2 }' go.mod)"; \
	if [ "$$bindings" != "$$(manifest go_bindings_version)" ]; then \
		echo "ghostty-vt: go.mod pins go.mitchellh.com/libghostty $$bindings, but the vendored library" >&2; \
		echo "ghostty-vt: was built for $$(manifest go_bindings_version). Bump GHOSTTY_COMMIT in" >&2; \
		echo "ghostty-vt: scripts/ghostty-vt.sh to match and run 'make ghostty-vt-rebuild'." >&2; \
		exit 1; \
	fi; \
	mkdir -p "$(GHOSTTY_VT_PC_DIR)"; \
	{ \
		echo 'prefix=$(GHOSTTY_VT_DIR)'; \
		echo 'includedir=$${prefix}/include'; \
		echo 'libdir=$${prefix}/lib'; \
		echo; \
		echo 'Name: libghostty-vt-static'; \
		echo 'URL: https://github.com/ghostty-org/ghostty'; \
		echo 'Description: Ghostty VT library (static, vendored)'; \
		echo "Version: $$(manifest lib_version)"; \
		echo 'Cflags: -I$${includedir}'; \
		echo 'Libs: $${libdir}/libghostty-vt.a'; \
	} > "$(GHOSTTY_VT_PC).tmp"; \
	mv "$(GHOSTTY_VT_PC).tmp" "$(GHOSTTY_VT_PC)"

## ghostty-vt-rebuild: rebuild the vendored libghostty-vt from source (downloads zig and
## the pinned ghostty commit into third_party/build/). Only for bumping; commit the result.
ghostty-vt-rebuild:
	./scripts/ghostty-vt.sh
	@$(MAKE) --no-print-directory ghostty-vt

## clean: remove build output. Never touches the vendored libghostty-vt files.
clean:
	rm -rf bin gui/bin dist $(FRONTEND)/dist $(GHOSTTY_VT_DIR)/share third_party/build
