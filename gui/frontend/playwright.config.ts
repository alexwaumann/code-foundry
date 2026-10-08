import { defineConfig, devices } from "@playwright/test";

/** e2e against the mock daemon. Ports differ from `pnpm run mock` / `wails3 dev` defaults
 * so a running dev setup does not interfere; E2E_MOCK_PORT / E2E_VITE_PORT move them
 * (e.g. two worktrees running e2e at once). See e2e/fixtures.ts. */
export const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 7799);
export const MOCK_TOKEN = "e2e-token";
export const VITE_PORT = Number(process.env.E2E_VITE_PORT ?? 9255);

export default defineConfig({
  testDir: "e2e",
  // e2e/live.spec.ts drives a real daemon: playwright.live.config.ts (pnpm run e2e:live).
  testIgnore: /live(-[a-z]+)?\.spec\.ts$/,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  // Tests share one mock daemon and reset it in beforeEach.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${String(VITE_PORT)}`,
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  projects: [
    // WebKit is what WKWebView (the Wails window) runs, so it is the primary target.
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } } },
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
  ],
  webServer: [
    {
      command: "./node_modules/.bin/tsx mock/server.ts",
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_TOKEN },
      url: `http://127.0.0.1:${String(MOCK_PORT)}/__mock/invocations`,
      reuseExistingServer: false,
      stdout: "ignore",
    },
    {
      command: `./node_modules/.bin/vite --port ${String(VITE_PORT)} --strictPort`,
      url: `http://127.0.0.1:${String(VITE_PORT)}`,
      reuseExistingServer: false,
      stdout: "ignore",
    },
  ],
});
