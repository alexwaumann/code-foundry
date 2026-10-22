# Security bumps, 2026-10-21

Two dependency bumps prompted by the October 2026 advisories; a second PR follows with
Wails beta.34 and Node 24.22.1.

## Go 1.26.8 → 1.26.10

govulncheck flagged 11 reachable standard-library issues: ten net/http, net/textproto and
crypto/tls fixes from 1.26.9 (October 8) and the crypto/x509 eMudhra intermediate-CA
distrust from 1.26.10 (October 19, CVE-2026-111943). The reachable paths are the daemon's
loopback Connect server, the in-process GitHub GraphQL client, the plugin registry fetcher
and the update downloader. Only the `toolchain` line in go.mod changes; CI reads it via
`go-version-file`. The x509 change takes effect only in binaries rebuilt with the new
toolchain, so a release is the actual fix for users.

govulncheck needs the same `PKG_CONFIG_PATH` the Makefile exports (libghostty-vt), or it
fails to type-check the terminal actor.

## pdfjs-dist 5.7.284 → 6.4.299

CVE-2026-16633 (GHSA-hq66-cqwq-w95j): arbitrary JavaScript from a malicious PDF when
`enableScripting` is on and no CSP restricts script-src. The app's exposure was narrow:
`lib/pdf.ts` only calls `getDocument` and renders pages to canvas, never the annotation
layer (the only place the core build reads `enableScripting`, default off) or the scripting
sandbox. The webview has no CSP and its origin drives the daemon, so the bump is cheap
insurance rather than a confirmed hole. The API used (`getDocument`, `getPage`, `render`
with a canvas, `pdf.worker.min.mjs?url`) is unchanged across the major; the WebKit e2e
PDF specs (file tab, composer, thread) pass unchanged.

## Not changed here

- Wails beta.28 accepts `wails:` control messages (drag, resize, runtime-ready) from
  subframes; the HTML preview iframe is such a subframe. Fixed upstream in PR #6288
  (beta.31+). Separate PR.
- Node 24.21.0 is build tooling only; the shipped app has no Node. Separate PR.
- `pnpm audit` dev-only findings (vite dev server, shadcn CLI's MCP SDK and braces).
