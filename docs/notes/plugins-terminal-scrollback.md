# Plugins: terminal/read with scrollback

`terminal/read` read only the screen (`docs/notes/plugins-10-host-gaps.md`, item 10), so a
plugin that wanted a run's whole output had to record it itself: test-watcher runs its
command under `script(1)` into its data folder, and host-api.md said to `tee` to a file.
Now the read can include the scrollback.

## What changed

* **Terminal store.** `Store.ScrollbackText(ctx, id)` (`Manager`, `terminaltest.Fake` with
  `SetScrollback`): libghostty's plain formatter over the whole active screen, which is the
  scrollback and the active area, run on the actor goroutine like `ScreenText`
  (`formatScrollbackPlain` in `vt.go`). Unwrapped (a soft-wrapped line is one line), trailing
  whitespace trimmed, trailing blank rows dropped, oldest line first.
* **Protocol.** `terminal/read {terminalId, maxBytes?, scrollback?}` →
  `{text, truncated, lines?}`. Without `scrollback` nothing changed (screen, 64 KiB default,
  256 KiB max). With it: `maxBytes` 0 or over 1 MiB means 1 MiB; a longer text loses its
  head, from a line start, with `truncated`; `lines` counts the returned text's lines. New
  capability `terminal.scrollback`, since an older host ignores the unknown field and
  answers the screen.
* **SDK.** `Host.ReadTerminalWith(ctx, id, ReadTerminalOptions{Scrollback, MaxBytes})`;
  `ReadTerminal(ctx, id, maxBytes)` unchanged. plugintest: `SetTerminalScrollback` (a
  scrollback read falls back to `SetTerminalText`'s text) and `TerminalReads()` records
  every read with its `Scrollback` and `MaxBytes`.
* **hello.** `read-shell` reads the clock terminal (the demo's Shell tab) with the
  scrollback and prints it, with the screen read's line count for comparison.
* **Skill.** host-api.md's terminal paragraph now points to `ReadTerminalWith` instead of
  `tee`; protocol.md's table row has the new fields.

## Effective bound

The emulator keeps `threads.scrollback_lines` rows of history (the *Scrollback lines*
setting: default 10,000, 1,000 to 100,000, daemon restart to apply) under a 64 MiB memory
cap, the same for every terminal in the store. libghostty trims page by page, so a bit
under the setting survives (the existing `TestScrollbackRetainedAndCompressedWhenIdle`
keeps ~2,800 of 3,000). The read then returns at most the last 1 MiB of that text. A
program on the alternate screen (vim, less, a TUI) has no scrollback: the read is that
screen. Per-terminal limits for plugin terminals were not added: the store's limit is
global, and 10,000 rows already covers the runs `script(1)` was used for.

## Decisions and gotchas

* Source: the emulator, not a raw byte tail. The architecture's 1 MiB ring buffer was never
  built (the snapshot serializes scrollback), and raw bytes would need their own escape
  stripping and cursor-movement handling. The formatter output is exactly what the user
  scrolls back through.
* The whole text is formatted, then tailed. No windowed formatting: chunk boundaries would
  split soft-wrapped lines, and 10,000 rows format in milliseconds. Worst case (100,000
  rows of 250 wide cells) is a transient string of tens of MB on a permissioned call.
* A 1 MiB text can be 6 MiB as JSON (`<`, `>`, `&` encode as `<`), over the 4 MiB
  protocol line; the read halves the text until its JSON length is under 3 MiB
  (`jsonLen`, checked against `json.Marshal` in a test).
* Unwrapped lines differ from the screen read's rows on purpose: a log line is a line.

## Tests

`internal/store/terminal/scrollback_test.go` (real actor: 60 coloured lines and a 70-column
line on a 30x8 screen; order, escapes gone, wrap joined, screen alone shorter),
`internal/store/plugin/terminal_read_internal_test.go` (table: screen vs scrollback,
maxBytes cut at a line start, 64 KiB/256 KiB/1 MiB caps, the JSON halving, `lines`),
`TestPluginThreadsAndTerminals` (a real plugin process calling `ReadTerminalWith` over the
protocol), plugintest `TestTerminalExitAndRead`, hello `TestReadShell`.

## End to end (isolated `CODE_FOUNDRY_HOME=~/.cf-sb-e2e`)

```
make build plugins
CODE_FOUNDRY_HOME=~/.cf-sb-e2e ./bin/code-foundry daemon --dev &
code-foundry plugin dev plugins/examples/hello --yes
code-foundry thread new --no-project --name sb-e2e --created-by=
code-foundry plugin act hello demo tab --key shell --thread s-ddcdb8c06ff7 --quiet
  acted on shell (view version 1)                   # 20:44:53, the clock starts
# 62 s later
code-foundry plugin hello read-shell
  Clock t-48f9db0a50c7: 33 lines with the scrollback, 23 on the screen
  Sun Oct 18 20:44:53 CDT 2026                      # the clock's first line, off screen
  Sun Oct 18 20:44:55 CDT 2026
  …
  Sun Oct 18 20:45:57 CDT 2026
```

The 24-row screen holds 23 dates and the prompt row; the scrollback read has all 33 from the
first. No errors in the daemon log; the daemon was stopped and `~/.cf-sb-e2e` removed.
