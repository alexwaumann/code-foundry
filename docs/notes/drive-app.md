# drive-app skill

Agents check GUI changes by driving the app with `playwright cli` (built into
`@playwright/test` 1.64.1) instead of one-off Playwright scripts. Follows
`docs/notes/playwright-hardening.md`.

## What ships

- `.claude/skills/drive-app/SKILL.md`: a repo skill, so worktrees, delegated threads and other
  people working on the repo pick it up, and it names this repo's pinned binary, ports and rules.
  The upstream command reference is read from `node_modules` (same version as the binary) and
  is not copied.
- `gui/frontend/.playwright/cli.config.json`: WebKit, headless, `isolated` (in-memory profile),
  dark, 1280×800, `network.allowedOrigins` `http://127.0.0.1:*` and `http://localhost:*`. The CLI
  reads it from the cwd's `.playwright/`, so commands run from `gui/frontend`. Everything else in
  that directory is gitignored.
- `make drive` / `scripts/drive.sh`: the mock daemon (default) or `DAEMON=dev` (a real
  `daemon --dev`), plus the Vite dev server, on free ports. It runs in the foreground and writes
  `.playwright/drive.env`. Stopping it with TERM kills both servers, runs `close-all` and removes
  the state file.

## Decisions

- Mock first: scripted data and no real state. Dev mode is for daemon-backed flows.
- The dev daemon's home is `DRIVE_HOME` or a fresh `/tmp/cf-drive.*`. An inherited
  `CODE_FOUNDRY_HOME` is ignored, because a thread's environment may carry its own daemon's home.
  The real `~/.code-foundry` (compared with `pwd -P`) and any home whose daemon answers are refused.
- One drive per checkout: `drive.env` and the CLI's sessions are per checkout. The CLI keys its
  sessions by the nearest directory holding `.playwright/`, so worktrees never share a browser.
- The origin allowlist is a backstop, not a boundary. Playwright's docs say redirects are not
  covered. It did block both `fetch` and `goto` to a public site ("Blocked by Web Inspector").
- PR screenshots still come from the SHOTS-gated e2e specs; the CLI is for checks while working.

## Gotchas

- macOS `/bin/bash` is 3.2: no `wait -n`, and `"${a[@]}"` on an empty array fails under `set -u`.
  The script polls `kill -0` and uses `${a[@]+"${a[@]}"}`.
- SIGINT is ignored by a background job of a non-interactive shell, so `kill -INT` on a
  `... &` drive does nothing. The harness's task stop and SIGTERM both clean up.
- A cleanup trap must not undo another run's state: a refused second run once deleted the
  first run's `drive.env`. Cleanup now acts only after this run has started its servers.
- The scratch dev daemon still uses the machine's `gh` login, and its read-only GitHub queries
  show up in `daemon.log`.
