# code-foundry build entry points. See docs/notes/phase0.md.

SHELL := /bin/bash
.SHELLFLAGS := -eu -o pipefail -c

# buf and wails3 are installed with `go install` into GOPATH/bin.
export PATH := $(shell go env GOPATH)/bin:$(PATH)

# Match the Wails Taskfile's macOS target so cgo objects in the gui package link
# without "built for newer macOS version" warnings.
export MACOSX_DEPLOYMENT_TARGET := 12.0
export CGO_CFLAGS  := -mmacosx-version-min=12.0
export CGO_LDFLAGS := -mmacosx-version-min=12.0

VERSION  ?= dev
LDFLAGS  := -X github.com/awaumann/code-foundry/internal/version.Version=$(VERSION)
FRONTEND := gui/frontend
PNPM     := pnpm --dir $(FRONTEND)

.PHONY: all gen build check go-check frontend-check frontend-deps gui-dist-stub \
        dev gui-build gui-dev ghostty-vt clean

all: build

## gen: regenerate protobuf/Connect code (Go + TS) and Wails bindings. Commit the result.
gen:
	buf lint
	buf generate
	cd gui && wails3 generate bindings -clean=true -ts -i

## build: build the CLI/daemon binary to ./bin/code-foundry.
build:
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

go-check: gui-dist-stub
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
dev:
	go run -ldflags "$(LDFLAGS)" ./cmd/code-foundry daemon --dev

## gui-build: build the Wails GUI binary to gui/bin/CodeFoundry.
gui-build: build
	cd gui && wails3 build

## gui-dev: run the GUI with hot reload (auto-starts ./bin/code-foundry daemon if needed).
gui-dev: build
	cd gui && wails3 dev

## ghostty-vt: RESERVED for Phase 1a. It will build libghostty-vt from a pinned ghostty
## commit with zig 0.16.0 (NOT the Homebrew zig 0.17) into third_party/ghostty-vt
## (gitignored). Not implemented yet.
ghostty-vt:
	@echo "ghostty-vt: not implemented yet (Phase 1a)" >&2
	@exit 1

clean:
	rm -rf bin gui/bin $(FRONTEND)/dist
