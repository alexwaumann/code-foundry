import { defineConfig, devices } from "@playwright/test";

/**
 * Opt-in e2e against a REAL daemon and real Claude Code (e2e/live.spec.ts). Nothing is
 * started for you: run an isolated daemon and the Vite dev server pointed at it first.
 * See docs/notes/phase2-integration.md for the recipe:
 *
 *   LIVE_DAEMON=1 CODE_FOUNDRY_HOME=/tmp/cf-live pnpm run e2e:live
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "live.spec.ts",
  timeout: 300_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: process.env.LIVE_APP_URL ?? "http://127.0.0.1:9246",
    viewport: { width: 1200, height: 720 },
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  // WebKit is what the Wails window (WKWebView) runs.
  // deviceScaleFactor 1 keeps the screenshots small.
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1200, height: 720 }, deviceScaleFactor: 1 } }],
});
