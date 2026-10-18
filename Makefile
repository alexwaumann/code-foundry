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
# The commit, for builds Go cannot stamp (a git worktree's .git is a file): the plugin
# skill pins the SDK at it. "-dirty" when the tree has changes.
COMMIT   ?= $(shell git rev-parse HEAD 2>/dev/null)$(shell [ -n "$$(git status --porcelain 2>/dev/null)" ] && echo -dirty)
# One set of version ldflags for both binaries (the CLI here, the GUI via scripts/package.sh;
# Commit is the CLI's only).
LDFLAGS  := -X github.com/alexwaumann/code-foundry/internal/version.Version=$(VERSION) \
            -X github.com/alexwaumann/code-foundry/internal/version.ReleaseRepo=$(RELEASE_REPO) \
            -X github.com/alexwaumann/code-foundry/internal/version.Commit=$(COMMIT)
FRONTEND := gui/frontend
PNPM     := pnpm --dir $(FRONTEND)

.PHONY: plugins

## plugins: build the example plugins (plugins/examples/*): each executable next to its
## plugin.json (bin/, gitignored; for `code-foundry plugin dev plugins/examples/<name>`)
## and a complete package in bin/plugins/<name> (plugin.json + bin/<name>). Not released.
plugins:
	@for dir in plugins/examples/*/; do \
		name=$$(basename "$$dir"); \
		echo "plugin $$name"; \
		go build -trimpath -o "$$dir/bin/$$name" "./$$dir" && \
		mkdir -p "bin/plugins/$$name/bin" && cp "$$dir/plugin.json" "bin/plugins/$$name/" && \
		cp "$$dir/bin/$$name" "bin/plugins/$$name/bin/$$name"; \
	done

.PHONY: all gen build check attest go-check go-lint go-test frontend-check frontend-deps gui-dist-stub \
        dev gui-build gui-dev gui-e2e gui-mock ghostty-vt package release promote clean fuzz

all: build

## gen: regenerate protobuf/Connect code (Go + TS) and Wails bindings. Commit the result.
gen:
	$(BUF) lint
	$(BUF) generate
	cd gui && $(WAILS3) generate bindings -clean=true -ts -i

## build: build the CLI/daemon binary to ./bin/code-foundry.
build: ghostty-vt
	go build -trimpath -ldflags "$(LDFLAGS)" -o bin/code-foundry ./cmd/code-foundry

## check: everything CI runs. On success it records the working tree's hash so that
## `make attest` can vouch for it once committed and pushed (scripts/attest.sh).
check: go-check frontend-check
	@scripts/attest.sh record

## attest: post a "local-check" commit status on the pushed HEAD, provided its tree is the
## one `make check` last passed on. CI then skips its jobs for that pull request.
attest:
	@scripts/attest.sh post

# gui/main.go embeds gui/frontend/dist, which only exists after a frontend build. Go
# vet/staticcheck/test compile the gui package, so give them a placeholder if needed.
gui-dist-stub:
	@if [ -z "$$(ls -A $(FRONTEND)/dist 2>/dev/null)" ]; then \
		mkdir -p $(FRONTEND)/dist; \
		echo '<!doctype html><p>Frontend not built. Run <code>wails3 build</code> in gui/.</p>' > $(FRONTEND)/dist/index.html; \
	fi

go-check: go-lint go-test

# pluginsdk/ is its own module (stdlib only, replaced into this one), so ./... does not
# reach it: vet, staticcheck and test it from its own directory.
go-lint: gui-dist-stub ghostty-vt
	@unformatted=$$(gofmt -l cmd internal gui/*.go pluginsdk plugins 2>/dev/null); if [ -n "$$unformatted" ]; then echo "gofmt needed:" $$unformatted; exit 1; fi
	go vet ./...
	go tool staticcheck ./...
	cd pluginsdk && go vet ./... && "$$(cd .. && go tool -n staticcheck)" ./...

## fuzz: run every plugin fuzz target for FUZZTIME each (default 30s), one after another
## (docs/notes/plugins-9-fuzz.md). Not part of check. A failing input lands in the
## package's testdata/fuzz/<target>/: name it and commit it as a regression seed.
FUZZTIME ?= 30s
FUZZ_TARGETS := \
	pluginsdk:.:FuzzSplitter pluginsdk:.:FuzzConn pluginsdk:.:FuzzParseManifest pluginsdk:.:FuzzMatchCommand \
	pluginsdk:./ui:FuzzView \
	.:./internal/store/plugin:FuzzValidateView .:./internal/store/plugin:FuzzViewMutate \
	.:./internal/store/plugin:FuzzPredicate .:./internal/store/plugin:FuzzActValues \
	.:./internal/store/plugin:FuzzValidateEnvironment .:./internal/store/plugin:FuzzManifestCommands \
	.:./internal/store/plugin/registry:FuzzParseIndex .:./internal/store/plugin/registry:FuzzVersion \
	.:./internal/store/plugin/registry:FuzzParseLocation .:./internal/store/plugin/registry:FuzzFindChecksum \
	.:./internal/store/plugin/registry:FuzzExtract .:./internal/store/plugin/registry:FuzzExtractBytes
# Go's fuzz engine sometimes fails a clean run with "context deadline exceeded" as
# FUZZTIME ends; that (without a failing input) is reported and skipped.
fuzz:
	@for t in $(FUZZ_TARGETS); do \
		mod=$${t%%:*}; rest=$${t#*:}; pkg=$${rest%%:*}; name=$${rest#*:}; \
		echo "fuzz $$name ($$pkg, $(FUZZTIME))"; \
		if out=$$(cd $$mod && go test -run '^$$' -fuzz "^$$name\$$" -fuzztime $(FUZZTIME) $$pkg 2>&1); then \
			echo "$$out" | tail -1; \
		elif ! echo "$$out" | grep -q "Failing input" && echo "$$out" | grep -q "context deadline exceeded"; then \
			echo "  the fuzz engine timed out as FUZZTIME ended (no failing input)"; \
		else \
			echo "$$out"; exit 1; \
		fi; \
	done

go-test: gui-dist-stub ghostty-vt
	go test -race ./...
	cd pluginsdk && go test -race ./...

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

## gui-build: build the Wails GUI as the bare executable "gui/bin/Code Foundry", which is
## what `code-foundry gui` launches from a dev CLI. No .app bundle (managed Macs often block
## unsigned bundles); stale gui/bin/CodeFoundry(.app) from older builds are removed.
gui-build: build
	cd gui && $(WAILS3) build
	rm -rf gui/bin/CodeFoundry.app gui/bin/CodeFoundry

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

## package: release assets in dist/ (VERSION=vX.Y.Z required): the app tarball
## (code-foundry, "Code Foundry", VERSION), install.sh, checksums.txt. See scripts/package.sh.
package: ghostty-vt frontend-deps
	VERSION=$(VERSION) RELEASE_REPO=$(RELEASE_REPO) WAILS3=$(WAILS3) MAKE=$(MAKE) ./scripts/package.sh

## release: manual fallback for .github/workflows/release.yml, stable channel. Next version
## from conventional commits unless VERSION=vX.Y.Z is given; DRY_RUN=1 prints the commands.
release:
	./scripts/release.sh $(if $(DRY_RUN),--dry-run) $(filter-out dev,$(VERSION))

## promote: publish the head of main as a stable release through the release workflow
## (channel=stable); VERSION=vX.Y.Z overrides the computed version. Prints the run URL.
promote:
	gh workflow run release.yml --ref main -f channel=stable $(if $(filter-out dev,$(VERSION)),-f version=$(VERSION))
	@sleep 5
	@gh run list --workflow release.yml --event workflow_dispatch --limit 1 --json url --jq '.[0].url'

## ghostty-vt: build libghostty-vt from the pinned ghostty commit with zig 0.16.0 (both
## downloaded into third_party/, gitignored). No-op once the pkg-config file exists.
ghostty-vt:
	@./scripts/ghostty-vt.sh

clean:
	rm -rf bin gui/bin dist $(FRONTEND)/dist
