import { readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in e2e against a REAL daemon and real Claude Code (e2e/live*.spec.ts, helpers in
 * e2e/live.ts). Not part of `make check` or `make gui-e2e`, and it starts nothing: bring up
 * a scratch daemon and the Vite dev server with `make drive DAEMON=dev` first. How to run
 * it, what each spec needs and what it costs: docs/notes/live-e2e.md.
 *
 *   . .playwright/drive.env && LIVE_DAEMON=1 bun run e2e:live e2e/live.spec.ts
 */

/** The Vite port `make drive` wrote to .playwright/drive.env, when LIVE_APP_URL is unset. */
function driveUrl(): string {
  try {
    const port = /^DRIVE_VITE_PORT=(\d+)$/m.exec(readFileSync(".playwright/drive.env", "utf8"))?.[1];
    if (port) return `http://127.0.0.1:${port}`;
  } catch {
    // no drive running
  }
  return "http://127.0.0.1:9246";
}

export default defineConfig({
  testDir: "e2e",
  testMatch: /live(-[a-z]+)?\.spec\.ts$/,
  timeout: 300_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LIVE_APP_URL ?? driveUrl(),
    viewport: { width: 1200, height: 720 },
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  // WebKit is what the Wails window (WKWebView) runs.
  // deviceScaleFactor 1 keeps the screenshots small.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 } }],
});
