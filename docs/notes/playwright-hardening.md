# Playwright hardening

A user asked whether Playwright is unsafe because its bundled Chromium ships with known CVEs
(as of 2026-11, Playwright 1.64.1 bundles an early Chromium 156 build that predates four
critical fixes, and launches Chromium without its sandbox by default).

## Decisions

- Keep Playwright for e2e. The suite runs WebKit only (the app is a WKWebView), and every page
  it loads is ours on localhost, so a browser CVE has no hostile content to reach. Real Safari
  through `safaridriver` is patched by the OS but allows one automation session at a time,
  which would cost the four parallel workers.
- `@playwright/test` 1.63.0 → 1.64.1 (WebKit build 2359 → 2370).
- CLAUDE.md now says Playwright browsers load localhost only and that WebKit is the only
  engine installed. Public pages go through web fetch or a real browser.
- agent-browser (Vercel Labs) was considered for agent-driven checks and rejected: it drives
  Chrome over CDP and cannot run desktop WebKit, so it would show a different engine from the
  one users have. Browserbase hosts cloud browsers for the public web and would need a tunnel
  to the loopback daemon.

## Gotchas

- `playwright install webkit` garbage-collects every browser in `~/Library/Caches/ms-playwright`
  that no live Playwright installation links to. Installing 1.64.1's WebKit removed the 1.63
  WebKit and the old Chromium builds. Another checkout still on 1.63 then fails with
  "Executable doesn't exist" until it runs `bunx --cwd gui/frontend playwright install webkit`
  or rebases onto this change.
- WebKit 2370 no longer rounds a fitting value one pixel over its box under 110% zoom, so
  `projects.spec.ts` "at 110% zoom … opens no tooltip" asserted a trap that no longer appears.
  Its setup now accepts "at most one pixel over" and the no-tooltip assertions stay.
  `whenTruncated`'s slack stays: the system WKWebView may still round that way.
- Playwright 1.64.1 ships `playwright cli` (the agent CLI, same as `@playwright/cli`) inside the
  package we already depend on, so it reuses the same WebKit build with no new dependency.
  The standalone `@playwright/cli` package pins a 1.65 alpha and would download its own
  browsers.
