# Phase 0: Foundation

Status: done. `make check` is green, `make build` produces `./bin/code-foundry`, and
these were exercised end to end: daemon + CLI (`status`, auto-start) and daemon + GUI
(`wails3 build`, `wails3 package`, `wails3 dev`).

## How to run

```sh
make build                   # ./bin/code-foundry
./bin/code-foundry status    # starts the daemon if needed, prints pid/version/uptime/socket
make dev                     # daemon in the foreground, JSON log + text on stderr (Ctrl-C stops it)
make check                   # go vet, staticcheck, go test -race, frontend typecheck/lint/test
make gen                     # buf lint + generate (Go + TS) + Wails bindings; commit the result

make gui-build               # = make build && cd gui && wails3 package -> gui/bin/CodeFoundry.app (+ bare CodeFoundry)
cd gui && wails3 build       # bare gui/bin/CodeFoundry only; `code-foundry gui` prefers the .app if one exists
make gui-dev                 # = make build && cd gui && wails3 dev     (Vite HMR on :9245)
```

`CODE_FOUNDRY_HOME=/tmp/cf ./bin/code-foundry …` isolates everything (socket, token,
port, lock, logs) from your real config home. The GUI honours it too
(`open --env CODE_FOUNDRY_HOME=/tmp/cf gui/bin/CodeFoundry.app`).

## Layout added

| Path | What |
|---|---|
| `proto/codefoundry/v1/health.proto` | `HealthService.Ping` (pid, version, uptime as `google.protobuf.Duration`) and `Version` (version, commit, go_version) |
| `buf.yaml`, `buf.gen.yaml` | buf v2, STANDARD lint, remote plugins (no local protoc plugins), managed `go_package_prefix` |
| `gen/go/…`, `gui/frontend/src/gen/…` | generated code, committed |
| `internal/paths` | config home + file layout; `Ensure()` creates dirs 0700 and rejects socket paths over 103 bytes |
| `internal/bus` | `bus.Subscribe[T](b, n)`, `bus.Publish(b, ev)`; routed by Go type; bounded per-subscriber channel; non-blocking publish; per-subscription and bus-wide drop counters |
| `internal/daemon` | lock, logging, listeners, auth, CORS, lifecycle |
| `internal/api` | `api.Route` + one file per service (`health.go`) |
| `internal/client` | `New` (UDS), `NewLoopback` (HTTP + bearer), `Connect` (auto-start), `ReadEndpoint` |
| `internal/version` | `Version` (ldflags) + VCS commit from build info (*addition, not in ARCHITECTURE.md*) |
| `cmd/code-foundry` | `daemon [--dev]`, `status`, `version`, `help`; no args prints the GUI hint and exits 0 |
| `gui/` | Wails v3 host (`main.go`, `daemon.go`), `Taskfile.yml`, `build/` (darwin only), `frontend/` |
| `.github/workflows/ci.yml` | `make check` on `macos-latest` |

## Decisions

* **Config home is `~/Library/Application Support/code-foundry`.** It's the macOS-native
  location, and the product is macOS-only. `XDG_CONFIG_HOME` is deliberately ignored.
  `CODE_FOUNDRY_HOME` overrides it for tests and side-by-side installs.
  *Superseded: the home is now `~/.code-foundry` (`config-home.md`).*
* **Go 1.26.** `go 1.26.0` + `toolchain go1.26.8` in go.mod, because Phase 1a's libghostty-vt
  bindings require it. With a local go1.25.5 and the default `GOTOOLCHAIN=auto`, the first
  `go` command in the module downloaded go1.26.8 (verified: `go version` inside the repo
  prints `go1.26.8`). CI's `actions/setup-go@v7` with `go-version-file: go.mod` honours the
  `toolchain` line.
* **No golang.org/x/net.** The daemon and client use Go's native unencrypted HTTP/2
  (`http.Protocols.SetUnencryptedHTTP2`, Go 1.24+) instead of `x/net/http2/h2c`. Both
  listeners accept HTTP/1.1 (browsers) and h2c with prior knowledge (Go clients). The
  integration test checks that loopback responses come back over HTTP/2.
* **CLI uses stdlib `flag` with a small dispatcher** (`cmd/code-foundry/main.go`), not
  cobra. User-facing verbs will come from `internal/command` in Phase 1d. Only the
  infrastructure verbs live in the dispatcher table.
* **Token** is 32 random bytes as hex, regenerated on every daemon start and written
  atomically (temp file + rename, 0600). Port and token files are written only after both
  listeners are up, and removed on shutdown. Socket is 0600 inside a 0700 dir.
* **Lock** is `flock(LOCK_EX|LOCK_NB)` on `daemon.lock`. The kernel drops it if the
  daemon dies, so stale state never blocks a restart. The file holds the pid for humans and
  is never unlinked (unlinking races a new daemon). Holding the lock means any leftover
  socket is stale and is removed before listening.
* **Auto-start**: `client.Connect` pings with a 1s timeout. If that fails, it runs
  `<bin> daemon` with `Setsid`, stdin `/dev/null`, stdout/stderr appended to
  `logs/daemon.log`, cwd `/`, and `CODE_FOUNDRY_HOME` forwarded. Then it polls Ping every
  50ms for up to 10s. If two clients race, the loser's daemon exits on the lock and both
  talk to the winner. A dead socket file (from a crash) is treated the same as a missing one.
* **Loopback auth/CORS**: `Authorization: Bearer <token>`, compared in constant time,
  401 + `WWW-Authenticate` otherwise (Connect clients see `Unauthenticated`). CORS
  reflects any `Origin` and answers preflights before auth, since browsers never send
  `Authorization` on preflight. The token is the boundary: only the Wails host can read it
  from disk, and no cookies or other ambient credentials are accepted. Observed origins:
  `wails://localhost` (production) and `wails://localhost:9245` (`wails3 dev`).
* **Logging**: JSON to `logs/daemon.log` at info level. With `--dev` the level is debug,
  and `slog.NewMultiHandler` (Go 1.26) also writes text to stderr. Debug level logs each
  request (listener, method, path, status, proto, origin, duration).
* **Graceful shutdown**: `signal.NotifyContext(SIGINT, SIGTERM)` inside `daemon.Run`,
  then `Shutdown` on both servers with a 5s bound, then the runtime files are removed. Exit
  code is 0.
* **gui/ is part of the root module** (no `gui/go.mod`). Wails beta.28 builds fine from a
  subdirectory of a module: the Taskfile runs `go build` / `go mod tidy` in `gui/`, which
  resolve the root go.mod. This keeps one go.mod and lets a later step import the GUI into
  the single `code-foundry` binary. The cost: wails and its deps sit in the root go.mod,
  and `go vet/test ./...` compiles the gui package (cgo/WebKit). That's fine on macOS CI,
  and the CLI binary doesn't link wails because nothing imports it. `gui/main.go` embeds
  `frontend/dist`, so `make check` creates a placeholder `dist/index.html` when it's
  missing (`gui-dist-stub`).
* **GUI ↔ daemon handshake**: a Wails service `DaemonService.GetDaemonEndpoint()`
  returns `{baseUrl, token}`. It calls `client.Connect` (auto-start) and then reads
  `daemon.port`/`daemon.token`. The frontend's `DaemonConnection` (`src/api/endpoint.ts`)
  caches the endpoint and invalidates it after any failed call, so the next poll picks up a
  restarted daemon's new port and token. The daemon binary is resolved from
  `$CODE_FOUNDRY_BIN`, then `<exe dir>/code-foundry`, then `../bin/code-foundry`
  (relative to cwd, for `wails3 dev` in `gui/`), then `$PATH`.
* **Daemon outlives the GUI**: verified. Quitting the GUI leaves the auto-started daemon
  running.
* **Generated TS boundary**: only `src/api/` may import `@/gen/*`. This is enforced by an
  eslint `no-restricted-imports` rule. `src/api/health.ts` maps `PingResponse` to the
  `HealthView` view model. The Zustand store (`src/stores/health.ts`) polls every 2s, and
  `HealthPanel` uses one narrow selector per field.
* **Wails bindings are committed** (`gui/frontend/bindings/`), like other generated code,
  so CI can typecheck without installing wails3. `make gen` regenerates them, and
  `wails3 build` regenerates them identically (no drift observed).
* **Taskfile trimmed to macOS**: only `common` + `darwin` includes, `PACKAGE_MANAGER: pnpm`,
  `APP_NAME: CodeFoundry`. The template's android/ios/linux/windows/docker assets are
  dropped. `generate:icons` passes `-windowsfilename ""` (see gotchas).
* **Production `Info.plist`** gains `NSAppTransportSecurity/NSAllowsLocalNetworking`
  (the dev plist already had it) so the bundled app can call `http://127.0.0.1`. Verified
  with the packaged `.app`.
* **No connect-es plugin.** With `@connectrpc/connect` v2, `protoc-gen-es` v2 emits the
  service descriptors (`HealthService`) that `createClient` consumes. The separate
  `protoc-gen-connect-es` only exists for connect v1. So `buf.gen.yaml` runs
  `buf.build/protocolbuffers/go:v1.36.12`, `buf.build/connectrpc/go:v1.21.0`, and
  `buf.build/bufbuild/es:v2.16.0` (target=ts).
* **staticcheck is a `go tool`** (`tool honnef.co/go/tools/cmd/staticcheck` in go.mod,
  v0.8.1). It is pinned, needs no install step in CI, and runs on the module's toolchain.
  The `~/go/bin/staticcheck` 2025.1.1 build is go1.25-built and is not used.

## Exact versions

Toolchain: macOS 27.0.1 arm64, Apple clang 21.0.0, Go go1.26.8 (auto-downloaded; local go1.25.5),
node v24.21.0, pnpm 12.8.1, buf 1.73.0, wails3 v3.0.0-beta.28, GNU Make 3.81.

Go: connectrpc.com/connect v1.21.0, google.golang.org/protobuf v1.36.12,
github.com/wailsapp/wails/v3 v3.0.0-beta.28, honnef.co/go/tools v0.8.1 (tool).

Frontend (pnpm pins exact versions): react/react-dom 19.3.0, typescript 6.0.3, vite 8.3.1,
@vitejs/plugin-react 6.1.1, tailwindcss + @tailwindcss/vite 4.3.3, shadcn 4.21.0 (radix
base, new-york style, neutral), radix-ui 1.6.7, class-variance-authority 0.7.1, cn 0.4.0,
lucide-react 1.49.0, tw-animate-css 1.4.0, zustand 5.0.15, @connectrpc/connect +
connect-web 2.2.0, @bufbuild/protobuf 2.16.0, @wailsio/runtime 3.0.0-beta.28, eslint 10.11.0,
typescript-eslint 8.71.0 (strictTypeChecked), eslint-plugin-react-hooks 7.1.1,
eslint-plugin-react-refresh 0.5.7, vitest 5.0.3, jsdom 30.1.1, @testing-library/react 16.3.3.

CI actions: actions/checkout@v7, actions/setup-go@v7, pnpm/action-setup@v6 (pnpm 12.8.1),
actions/setup-node@v7 (node 24).

## Gotchas

* **TypeScript 7 is not usable yet.** typescript-eslint 8.71 supports `typescript <6.1.0`,
  so TS is pinned to `~6.0.3`. TS 6 also deprecates `baseUrl` (error TS5101), so the
  tsconfigs use `paths` without `baseUrl`.
* **pnpm `minimumReleaseAge: 10080`** (7 days, in `gui/frontend/pnpm-workspace.yaml`,
  carried over from the Wails template's `.npmrc`). `@wailsio/runtime` is excluded
  because it must match the Go-side wails version, which was published 3 days ago.
  `shadcn@4.21.4` was too new, so 4.21.0 was used.
* **shadcn 4.21 uses the `cn` package** (shadcn's compiled replacement for
  clsx + tailwind-merge) in `src/lib/utils.ts` and components. It's maintained by shadcn and
  kept as generated.
* **pnpm ENOEXEC on this machine.** The global pnpm 12 under fnm was installed with its
  native-binary install script skipped, so `pnpm` is a shebang-less sh script. Shells run it
  fine (so `make` works), but anything that execs it directly fails with
  `spawn ENOEXEC` or `pnpm not found`. That includes the shadcn CLI and Task (the runner
  inside `wails3 build/dev`). Workaround used here: a wrapper on `PATH`
  (`#!/bin/sh` + `exec node <pnpm>/bin/pnpm.mjs "$@"`). Permanent fix: reinstall pnpm with
  its build scripts allowed so the native binary replaces the shim. CI is unaffected
  (`pnpm/action-setup`).
* **wails3 CLI built with go1.25** prints
  `package requires newer Go version go1.26 (application built with go1.25)` during
  binding generation. It's harmless: bindings are correct. To silence it, rebuild the CLI
  with 1.26: `GOTOOLCHAIN=go1.26.8 go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28`.
* **`wails3 generate icons`** defaults `-windowsfilename` to `build/windows/icon.ico` and
  fails if that dir is missing. The Taskfile passes `-windowsfilename ""`.
* **Unix socket path limit**: macOS `sun_path` is 104 bytes. `t.TempDir()` lives under
  `/var/folders/...`, which can exceed it, so the client tests create homes under `/tmp`.
  `paths.Ensure()` returns a clear error for over-long homes.
* **macOS make 3.81 ignores an exported `PATH`** when looking up recipe commands, so
  the Makefile references `$(BUF)` / `$(WAILS3)` explicitly.
* **cgo link warnings**: linking the gui test binary warned "object file was built for
  newer 'macOS' version (27.0) than being linked (11.0)". The Makefile exports
  `MACOSX_DEPLOYMENT_TARGET=12.0` and matching `CGO_CFLAGS/LDFLAGS`, the same values the
  Wails darwin Taskfile uses.
* **`go run` exits 1 on Ctrl-C**, so `make dev` builds and then `exec`s the binary instead.
* **Auto-start from a Finder-launched `.app`**: the bundle doesn't contain the
  `code-foundry` binary yet, and launchd's PATH rarely has it. Until packaging (Phase 3)
  copies the CLI into `Contents/MacOS/`, the bundled app only auto-starts the daemon when
  `CODE_FOUNDRY_BIN` is set or the daemon is already running.
* **Visual check**: screen capture was not permitted in the build session. GUI
  rendering was verified through the daemon's debug request log (the webview's preflight
  204, then a Ping 200 every 2s, from both the plain binary, the packaged `.app`, and
  `wails3 dev`) and a component test that renders `HealthPanel` from store state.
