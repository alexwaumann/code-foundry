# Phase 1a: Terminal store

Status: done. `make check` is green, and the daemon was exercised end to end over the
loopback Connect endpoint with zsh, a short-lived command, and a real interactive
`claude` (see "End-to-end check").

## How to run

> Since 2026-10-09 libghostty-vt is vendored prebuilt and `make ghostty-vt` only writes the
> pkg-config file; see [vendored-libghostty-vt.md](vendored-libghostty-vt.md). The rest of this note describes the original source build.

```sh
make ghostty-vt      # once: zig 0.16.0 + ghostty@34f39002 -> third_party/ (~1 min cold, no-op after)
make check           # depends on ghostty-vt; exports PKG_CONFIG_PATH for cgo
make build           # ./bin/code-foundry, libghostty-vt linked statically (+~8 MB)
```

Outside make (plain `go test`, gopls, an editor), cgo needs the pkg-config path:

```sh
export PKG_CONFIG_PATH=$PWD/third_party/ghostty-vt/share/pkgconfig
export CGO_CFLAGS=-mmacosx-version-min=13.0 CGO_LDFLAGS=-mmacosx-version-min=13.0  # silences ld warnings
```

## Layout added

| Path | What |
|---|---|
| `scripts/ghostty-vt.sh` | All pins (ghostty commit, zig version, zig sha256 per arch). Downloads zig from ziglang.org, cross-checks the pinned sha256 against `index.json` and verifies the tarball, shallow-fetches ghostty at the exact commit, then runs `zig build -Demit-lib-vt -Demit-xcframework=false -Doptimize=ReleaseFast --prefix <abs>`. Idempotent: it exits as soon as `libghostty-vt-static.pc` exists. `--print-key` prints the CI cache key. |
| `Makefile` | `ghostty-vt` target. `build` and `go-check` depend on it. Exports `PKG_CONFIG_PATH`. Deployment target raised to 13.0 (see Gotchas). |
| `.github/workflows/ci.yml` | `actions/cache@v6` on `third_party/ghostty-vt`, keyed `runner.os` + ghostty commit + zig version + arch. Then `make ghostty-vt`. |
| `internal/store/terminal` | `Store` interface, `*Manager` implementation, actor, snapshot serializer, PTY helpers, env/PATH helpers, throttle, input queue. |
| `internal/store/terminal/terminaltest` | `Fake` store. Tests drive output, title, alt screen, and exit explicitly. |
| `internal/api/terminal.go` | Thin `TerminalService` handler. Registered in `internal/daemon/daemon.go` together with the daemon's `bus.Bus` and store shutdown. |

`terminal.proto` is unchanged. Its generated TS lives under `gui/`, which this step does
not touch.

## Design

**One actor per terminal.** The goroutine in `actor.run` creates and owns the libghostty
`Terminal` and makes every libghostty call: `VTWrite`, getters, formatter, `Resize`,
`Compress`, `Close`. Other goroutines send closures over `reqs` (`actor.call`). Around
the actor:

* **Reader goroutine.** Reads the PTY master into a 32 KiB buffer and sends copies over
  a channel with capacity 8. The actor coalesces whatever has queued up into chunks of
  up to 64 KiB before it feeds the emulator and fans out. If the actor is slow, the
  reader blocks, and so the child blocks on its writes. That is real back-pressure from
  the emulator, which is the source of truth. Subscribers never cause it.
* **Input goroutine (`inputQueue`).** Writes to the PTY in order. API `Write` pushes to
  it directly (bounded at 1 MiB pending, `ErrInputBacklog` beyond that), without a hop
  through the actor. Emulator replies (`WithWritePty`: DSR, DA, mode reports, ...) are
  pushed unbounded from inside `VTWrite`. That keeps the actor from blocking on a program
  that is not reading stdin, which would otherwise deadlock reader → actor → child.
* **Wait goroutine.** `cmd.Wait`, then hands the `ProcessState` to the actor.

**PTY master is made pollable.** creack/pty opens `/dev/ptmx` in blocking mode, and its
`Setsize` calls `File.Fd()`, which forces blocking mode. `startPTY` uses `pty.Open` only.
It dups the master with `F_DUPFD_CLOEXEC`, sets `O_NONBLOCK`, and wraps it with
`os.NewFile`, which registers it with the runtime poller. `Close` then interrupts a
blocked `Read`. Resize uses `TIOCSWINSZ` through `SyscallConn().Control`. The child gets
`Setsid` + `Setctty`, so it leads its own process group.

**Exit.** Once the process exits *and* the reader has hit EOF, the terminal is marked
exited: the exit code is recorded (128+signal when signalled), `Exited` is broadcast,
and an update is published. If the reader has not stopped 150 ms after the process
exits (a background child holds the slave open), the master is closed. If the reader
still hasn't stopped 1 s after that, the terminal is finished anyway. The emulator stays
alive, so `Attach` still serves the final screen until `Remove`. `Remove` refuses
running terminals (`ErrRunning` → `FailedPrecondition`).

**Kill.** `SIGHUP` to the process group (falling back to the pid), then `SIGKILL` to
the group after `KillGrace` (3 s) if the process has not exited. Killing an exited
terminal is a no-op. `Manager.Close` (daemon shutdown) does the same for every terminal,
waits up to `KillGrace`, and then releases all emulators.

**Attach.** Runs on the actor, between two output chunks. It builds the snapshot,
creates a channel with 256 slots, queues `Snapshot` (and `Exited` if the process is
already gone), and registers the subscriber. Every later chunk, `Resized`, and `Exited`
goes to it in stream order, so there are no gaps and no duplicates. The integration test
attaches mid-stream to a 400-number counter and checks that the replay is contiguous.
Fan-out never blocks. When a subscriber's channel has one free slot left, it gets
`Dropped`, the channel is closed, and the drop is counted
(`Manager.DroppedSubscribers`). The API turns that into `ResourceExhausted`, and the
client re-attaches for a fresh snapshot. Dropping individual chunks would corrupt the
byte stream, so the whole subscriber is dropped.

**Metadata.** The title (`WithTitleChanged` sets a dirty flag) and alt screen
(`ActiveScreen` after every chunk) are compared after each feed. Changes publish
`TerminalUpdated` through a leading-edge + trailing-edge throttle (`throttle.go`,
50 ms ⇒ ≤ 20/s per terminal). Create, resize, and exit publish immediately. 50 title
changes in a burst produced ≤ 10 updates in the test.

**Watch.** `Store.Watch` merges the bus subscriptions for `TerminalUpdated` and
`TerminalRemoved`, each with a buffer of 256. The API's `Watch` subscribes first, then
sends `List()` as `updated` events, then streams. So a terminal can appear twice, but
none are missed.

**Spec handling.** Env is the daemon env, then `TERM=xterm-256color COLORTERM=truecolor`,
then `Spec.Env`. A bare `KEY` (no `=`) **unsets** KEY; that is how a session spawned
from a daemon started inside Claude Code drops the inherited `CLAUDECODE` etc. `argv[0]`
is resolved against the *merged* env's PATH, not the daemon's (a Finder-launched daemon
has a minimal PATH). Cwd defaults to `$HOME`. Size defaults to 80x24, max 4096.

**Query replies.** libghostty ignores DA queries unless it has a handler. `vt.go`
answers DA1 `CSI ?62;22c`, DA2 `CSI >1;10;0c`, and DA3 like Ghostty does, plus XTWINOPS
size reports. DSR/CPR and mode reports are built in. The integration test runs a program
in raw mode that reads `ESC[1;3R` and `ESC[?62;22c` back from its own tty.

**Scrollback memory.** `MaxScrollbackLines` defaults to 10,000. **libghostty's default
byte cap is 10,000 bytes**, which silently caps scrollback at a few hundred rows (477
rows of 120 columns in a probe). So `MaxScrollbackBytes` is always set; the default is
64 MiB, so the line limit is the one that applies. The line limit is page-granular:
3,000 configured kept about 2,800. After 2 s with no output, attach, or resize, the
actor runs `Compress(Incremental)` in 10 ms steps until it reports `Complete`. Measured
on repetitive log output, 10k rows × 120 cols went from 10.2 MiB to 0.5 MiB resident
(0.65 ms for a full pass). At 250 cols it went from 20.7 MiB to 0.9 MiB. Compressed
pages are decompressed transparently on read. Snapshots of compressed history work, and
the test covers it.

**Not built (deviations from ARCHITECTURE §5):**

* **No 1 MiB raw ring buffer.** The VT formatter serializes scrollback, which was the
  ring buffer's only purpose.
* **No `RenderState`.** Nothing here needs dirty-row tracking: snapshots use the
  formatter, and metadata uses getters. If Phase 2b status detection wants per-frame
  screen reads, add a hook that runs on the actor.

## Snapshot format

`buildSnapshot` (snapshot.go) produces bytes for a **freshly reset** emulator of exactly
`cols × rows`. The client must reset, resize to the snapshot's size, then write. In order:

1. *(alternate screen only)* the primary screen underneath, with scrollback, then CUP to
   the primary cursor. The libghostty formatter only serializes the active screen, so the
   live terminal is encoded with `Terminal.Snapshot()` (Ghostty's binary format), decoded
   into a throwaway `Terminal`, and the alt screen is left there with the mode the program
   used (`?1049l` restores the cursor saved on entry; `?1047l`/`?47l` otherwise). That
   primary screen is formatted the same way as below. The live terminal is never mutated.
2. Prefix extras: palette as OSC 4 (only if it differs from the default; it is 256
   entries, ~8 KiB), then non-default modes as `CSI ? n h/l`. On the alt screen this
   includes `?1049h`, which in the replay saves the primary cursor and switches screens
   the way the program did. Then tabstops (`CSI 3g`, HTS each), ending with `CSI H`.
3. Content: all scrollback plus the active screen, with SGR. It is **unwrapped**, so
   soft-wrapped lines stay soft-wrapped in the replay and xterm.js can reflow them.
   Wrapping happens only at the right margin, so an emulator of the same width wraps
   them onto the same rows.
4. Padding CRLFs, up to `TotalRows`. The formatter trims trailing blank rows. With
   scrollback present, the replay's viewport would otherwise start too high, and the
   final CUP would land on the wrong line (e.g. after `clear`). The row count comes from
   a separate wrapped pass, where every row ends in CRLF.
5. Suffix extras: DECSTBM/DECSLRM (after content so they do not confine it),
   modifyOtherKeys, OSC 7 pwd, then CUP (with pending-wrap reproduction), SGR pen, OSC 8
   hyperlink, DECSCA, kitty keyboard flags, charsets. The formatter cannot emit the
   suffix alone, so it formats with and without the suffix extras and takes the
   difference (it checks the prefix matches).
6. OSC 2 title (C0/C1 stripped), if one is set.
7. Parser continuation (`Terminal.Continuation()`, tracking enabled with 64 KiB). If the
   stream so far ends mid-escape or mid-UTF-8, these bytes put the replay's parser in the
   same state, so the next live `Output` chunk continues correctly.

Not expressed: DECSCUSR cursor shape, OSC 10/11/12 dynamic colors, kitty graphics, and
DECOM-relative cursor position (the CUP is absolute). None of these were seen from zsh or
Claude.

`snapshot_test.go` checks the format: each case writes the snapshot into a second
libghostty terminal and compares VT dumps, plain dumps, unwrapped dumps (soft wraps),
cursor, alt flag, title, scrollback rows, and 10 modes. It then feeds the same
continuation bytes to both terminals and compares again. Cases: empty, colored text
(16/256/truecolor, curly underline, inverse), cursor position, pen carry-over,
scrollback, scrollback + `clear` (padding), soft-wrapped lines, pending wrap at the
right edge, wide chars/emoji, modes + title, scrolling region, tabstops, alt screen via
1049/1047/47 (including leaving it afterwards), mid-CSI, mid-OSC, mid-UTF-8, and a
changed palette. Mutation checks: removing padding or primary-under-alt fails 7 cases,
and emitting wrapped content fails 2.

Cost (M3 Pro): 0.7 ms for a 657-row terminal, 10–14 ms and ~1.5 MiB for 10k rows.

## End-to-end check (daemon + loopback Connect)

Daemon: `CODE_FOUNDRY_HOME=/tmp/cf1a ./bin/code-foundry daemon --dev`. The driver was a
throwaway Go program using `codefoundryv1connect.TerminalServiceClient` against
`http://127.0.0.1:<daemon.port>` with the bearer token. Observed:

* **`/bin/zsh -il`** (100x30, cwd defaulted to `$HOME`): the attach stream began with
  `snapshot`. After `Write("echo hello\n")`, `hello` appeared twice in the live stream
  (echo + output). A second attach's snapshot (294 bytes, `alt=false`) rendered as
  `❯ echo hello / hello / ❯`. `Kill` → `Exited` with code 1 (zsh exits 1 on SIGHUP).
  `Remove` ended the stream cleanly.
* **`claude --version`**: events `[snapshot output exited]`, exit 0, output
  `2.1.293 (Claude Code)`, `Get` → `EXITED`, `exited_at` set. `sh -c 'exit 42'` → 42.
* **`claude`** (interactive, 120x40, `CLAUDE*` env unset via bare keys): an untrusted
  cwd first shows the "trust this folder" dialog *inline* (primary screen, `alt=false`),
  which the snapshot rendered exactly. After selecting "Yes" in a throwaway
  `/tmp/cf1a-claude-scratch` (this adds that path to `~/.claude.json`), `alt_screen`
  became true about 1.4 s later via `Watch`, with title `✳ Claude Code`. A fresh attach
  snapshot (2.3 KB, `alt=true`) rendered the full UI: logo/version banner, the
  `❯ Try "..."` prompt between rules, cwd, model line, and `-- INSERT -- ⏵⏵ auto mode on`.
  `Resize` to 90x30 → Claude redrew, and the next snapshot showed the narrower layout.
  `Kill` → exited in ~160–260 ms with 129. Claude handled SIGHUP by leaving the alt
  screen and clearing its title first; Watch showed `alt=false title=""` before
  `EXITED`.
* **Memory:** 10 idle `zsh -il` at 120x40: daemon RSS +3.0 to +3.9 MiB (**~300–400 KiB
  per terminal**, two runs). Attaching each once added ~1 MiB total. `footprint` for the
  whole daemon afterwards was 28 MB. The zsh processes themselves are not included.

## Gotchas

* **libghostty's default `MaxScrollbackBytes` is 10,000 bytes**; see Scrollback memory.
* **`Continuation()` returns `ErrInvalidValue` unless tracking was enabled** with
  `WithContinuationMaxBytes`. `newVT` always enables it, and `buildSnapshot` treats the
  error as "no continuation".
* **The formatter only covers the active screen and trims trailing blank rows.** These
  are the two reasons for steps 1 and 4 of the snapshot format.
* **Link warnings "built for newer macOS version (13.0) than being linked (12.0)".**
  zig builds libghostty-vt for ghostty's own minimum, macOS 13. The Makefile's Go
  deployment target is now 13.0 (it was 12.0 to match the Wails Taskfile, whose GUI
  binary does not link libghostty). Forcing ghostty down to 12.0 is untested upstream.
* **The `.pc` files hardcode the absolute prefix.** Each worktree/clone builds its own
  `third_party/`. CI's cache works because the runner workspace path is stable.
* **creack/pty `Setsize` (any `Fd()` call) puts the master back into blocking mode**;
  see "PTY master is made pollable".
* **macOS revokes the tty when the session leader exits.** The reader hits EOF at once,
  even when a background child still holds the slave. The 150 ms/1 s fallbacks exist for
  the other cases.
* **Escape-heavy TUIs do not emit literal text.** Ink moves the cursor instead of
  writing spaces, so "trust this folder" never appears in the raw stream. Match on a
  rendered screen (replay into libghostty), never on raw bytes. This matters for 2b
  status detection.
* **Daemon shutdown with an attached client takes up to 5 s.** `http.Server.Shutdown`
  waits for streaming handlers, and the request contexts are not cancelled until the
  5 s timeout closes the connections. Then terminals get SIGHUP. A `BaseContext`
  cancelled on shutdown would fix it; that is daemon.go infrastructure (Phase 0), left
  as is.

## Notes for the GUI (1e)

* Before writing a snapshot: `term.reset()`, resize xterm to `snapshot.cols × rows`,
  then write `data`. Set xterm.js `scrollback` ≥ 10,000 (its default is 1,000), or the
  oldest replayed lines fall off. Prefer `Resize` before `Attach` so the snapshot
  matches the viewport.
* **xterm.js must not answer terminal queries.** The daemon's emulator already replies
  to DA/DSR/mode reports, and xterm.js would reply a second time through `onData` →
  `Write`. Swallow them with parser hooks (e.g. `registerCsiHandler({final:'c'}, () =>
  true)`, `{final:'n'}`, `{prefix:'?', final:'p', intermediates:'$'}`).
* `ResourceExhausted` on Attach means "re-attach"; `Exited` keeps the stream open.

## Open questions for the session store (Phase 2)

1. **Claude's lifecycle on our SIGHUP**: it cleans up and exits 129. Is `Kill` the
   right "close session" path, or should the session store first send `/exit` (or
   Ctrl-D) through `Write` so Claude flushes its transcript, and use `Kill` only as the
   fallback?
2. **Inherited env.** If the daemon is ever started from inside a Claude Code session,
   every child inherits `CLAUDECODE`, `CLAUDE_CODE_*`, `CLAUDE_PID`, etc. The session
   store should unset these with bare keys, or the daemon should scrub them at startup.
   Which owner? The e2e unset `CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SESSION_ID
   CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SESSION_ATTENDED CLAUDE_CODE_MESSAGING_SOCKET
   CLAUDE_CODE_MESSAGING_TOKEN CLAUDE_CODE_EXECPATH CLAUDE_PID CLAUDE_EFFORT
   CLAUDE_AGENT_SDK_VERSION`.
3. **Folder trust.** New worktrees trigger Claude's trust dialog. Detect it on the
   rendered screen and surface it as needs-attention, or pre-trust worktrees of
   registered repos?
4. **Status detection input.** 2b needs to observe output. Options: (a) subscribe via
   `Attach` like a client (gets the snapshot + all chunks and is dropped if slow), (b) an
   in-process hook on the actor that sees every chunk with screen access (`RenderState`
   / formatter) without serialization. (b) is cheaper and never drops, but it puts
   Claude-aware code on the terminal actor goroutine. Recommendation: a generic
   `Observer` interface the actor calls with (chunk, read-only screen accessor), so the
   store stays program-agnostic.
5. **Labels are the join key**, e.g. `session=<id>`. Should `List` support filtering
   by label, or does the session store keep its own id → terminal-id map?
6. **Exited terminals are kept until `Remove`.** Who removes them, and when: the session
   store on close, or a TTL? Each one holds its (compressed) scrollback.
