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
# "built for newer macOS version". libghostty-vt is built by zig for ghostty's minimum,
# macOS 13.0, so Go builds target 13.0. (The Wails Taskfile still builds the GUI binary
# for 12.0; it does not link libghostty-vt.)
export MACOSX_DEPLOYMENT_TARGET := 13.0
export CGO_CFLAGS  := -mmacosx-version-min=13.0
export CGO_LDFLAGS := -mmacosx-version-min=13.0

# libghostty-vt (static) is built from a pinned ghostty commit into third_party/ghostty-vt
# by `make ghostty-vt` (scripts/ghostty-vt.sh holds the pins). The Go bindings find it via
# pkg-config. The generated .pc hardcodes this absolute prefix, so the directory cannot
# be moved after building.
GHOSTTY_VT_PREFIX := $(CURDIR)/third_party/ghostty-vt
GHOSTTY_VT_PC     := $(GHOSTTY_VT_PREFIX)/share/pkgconfig/libghostty-vt-static.pc
export PKG_CONFIG_PATH := $(GHOSTTY_VT_PREFIX)/share/pkgconfig$(if $(PKG_CONFIG_PATH),:$(PKG_CONFIG_PATH))

VERSION  ?= dev
# GitHub repository the in-app updater and install.sh download releases from.
RELEASE_REPO ?= alexwaumann/code-foundry
# One set of version ldflags for both binaries (the CLI here, the GUI via scripts/package.sh).
LDFLAGS  := -X github.com/alexwaumann/code-foundry/internal/version.Version=$(VERSION) \
            -X github.com/alexwaumann/code-foundry/internal/version.ReleaseRepo=$(RELEASE_REPO)
FRONTEND := gui/frontend
PNPM     := pnpm --dir $(FRONTEND)

.PHONY: all gen build check go-check frontend-check frontend-deps gui-dist-stub \
        dev gui-build gui-dev gui-e2e gui-mock ghostty-vt package release clean

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

## ghostty-vt: build libghostty-vt from the pinned ghostty commit with zig 0.16.0 (both
## downloaded into third_party/, gitignored). No-op once the pkg-config file exists.
ghostty-vt:
	@./scripts/ghostty-vt.sh

clean:
	rm -rf bin gui/bin dist $(FRONTEND)/dist
