# Security bumps, 2026-10-21 (part 2): Wails beta.34, Node 24.22.1

Follow-up to `security-bumps-2026-10-21.md`.

## Wails v3 beta.28 → beta.34

beta.31 (PR wailsapp/wails#6288) stops accepting reserved `wails:` control messages (drag,
resize, double-click, runtime-ready) from anything but the window's main frame. The HTML
preview iframe runs untrusted scripts, and WebKit exposes the script message handler to
every frame, so on beta.28 a preview page could drag or resize the app window. Nuisance
level, but it is the same surface as the Claude Code Desktop preview-pane chain disclosed
this month. beta.30 also stops the ~120/s empty `evaluateJavaScript:` calls on macOS that
ate click activation on macOS 27 (`navigator.clipboard.writeText` rejecting from real
clicks). Nothing in beta.29–34 touches an API the GUI uses; `make check` and a live run of
the rebuilt binary (window renders, drag band still drags) were unchanged.

Three places pin the version and must move together: `go.mod`, `@wailsio/runtime` in
`gui/frontend/package.json`, and the `go install .../cmd/wails3@…` line in
`.github/workflows/release.yml` (the local CLI too: `go install` the same tag). The pnpm
patch on `@wailsio/runtime` (drag.js: global timers, CSS `zoom`-aware hit test) is keyed by
exact version in `pnpm-workspace.yaml`; beta.34's `dist/drag.js` is byte-identical in the
patched regions, so the patch file was renamed and re-keyed, not rewritten.

## Node 24.21.0 → 24.22.1

Node's October 21 release (Brotli OOB write, two TLS hostname bypasses, dns.resolve
truncation, and more). Node is build tooling only: vite, vitest, tsx (mock daemon), the
Playwright runner. The shipped app has no Node in it. CI's `setup-node` asks for `24` and
resolves the newest 24.x, so no workflow change; the repo pins no Node version. Locally
the fnm default moved to 24.22.1.

Gotcha: `npm install -g pnpm@12` under the new Node left pnpm's shebang-less `sh`
placeholder in place of the native binary (the pre/postinstall that swaps it in did not
run). Shells cope, but Wails' task runner execs the path directly and macOS returns
ENOEXEC, so `wails3 build` failed its `pnpm --version` precondition with "pnpm not found"
while `pnpm` worked in every terminal. Fix: `cd <prefix>/lib/node_modules/pnpm &&
npm_config_global=true node install.js` (or `npm rebuild -g pnpm --foreground-scripts`),
then `file` on the `pnpm` binary should say Mach-O.
