# GUI daemon spawn guard

## What happened

A GUI launched from a worktree (`gui/bin/Code Foundry`) could not find the CLI: no
`code-foundry` sibling, cwd not `gui/`, not on PATH. `daemonBinary()` failed, the GUI
passed an empty `DaemonBinary` to `client.Connect`, and the client's CLI-oriented
default (`os.Executable()`) spawned the GUI with `daemon` as its argument. The GUI
ignores arguments, opened another window, and repeated. About 1400 nested
`Code Foundry daemon` processes in four minutes.

## Guards (all three, belt and braces)

- `client.ConnectOptions.NoAutoStart`: the GUI sets it when it has no CLI path, so
  Connect returns `ErrDaemonNotRunning` instead of defaulting to its own executable.
- `gui.daemonBinary()` rejects a result that is this executable (`os.SameFile`),
  which covers a wrong `CODE_FOUNDRY_BIN`.
- `gui/main.go` exits 2 on any argument other than `--version`, so even a spawn that
  slips through terminates instead of opening a window.

## Verified

`make check` green. Built GUI run with `CODE_FOUNDRY_BIN` pointed at itself and an
empty `CODE_FOUNDRY_HOME`: one process after ten seconds. `"Code Foundry" daemon`
prints an error and exits 2.

## Gotcha

`go build ./...` from a plain shell fails to link `cmd/code-foundry` with a stale
`/tmp/cf-bare-binary` libghostty path baked into the pkg-config cache; use `make`
targets, which set `PKG_CONFIG_PATH`.
