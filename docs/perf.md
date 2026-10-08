# Performance notes

## Phase 2 gate — ten idle sessions (2026-10-08)

Setup: `make build` at commit c655ba2, temp `CODE_FOUNDRY_HOME`, this repo registered, ten
`claude --model haiku` sessions created via the CLI, left idle at the prompt for 15 s, no GUI
attached. Measured with `ps -o rss` and `footprint` on macOS 27 / M-series.

| State | daemon RSS | daemon phys_footprint |
|---|---|---|
| baseline, 0 sessions | 31.4 MiB | 18 MB |
| 10 idle sessions | 58.0 MiB | 29 MB |
| after closing all 10 | 57.4 MiB | 34 MB (Go heap not yet returned) |

Per idle session: ~2.7 MiB RSS, ~1.1 MB footprint in the daemon (PTY, libghostty-vt grid
with 10k-line scrollback cap, observer, tailer).

For scale, the ten Claude Code processes themselves: 2784 MiB total, 278 MiB average. The
daemon is about 2% of the memory a fleet of sessions costs. The GUI (WKWebView) is not in
this measurement; it attaches one terminal at a time.

Script: the measurement was a throwaway bash script; re-run by hand following the setup above.
