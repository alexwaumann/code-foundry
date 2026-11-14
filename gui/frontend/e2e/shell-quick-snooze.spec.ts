import { expect, test } from "@playwright/test";
import { appPath, mockUrl, resetMock } from "./fixtures";

/**
 * SHOTS=<dir> only: a quick terminal back after a snooze (docs/notes/shell-24d-spec-differences.md,
 * 1), a fresh shell with the old one's last command and Run again; dark and light. The snooze
 * itself is the daemon's (Go tests); the line, its actions and when it shows are vitest's
 * (components/shell/QuickTerminal.test.tsx, shell/terminalActions.test.ts).
 */
for (const scheme of ["dark", "light"] as const) {
  test(`quick terminal after a snooze screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await resetMock();
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    // As the daemon leaves it once the thread opens again: its line kept for the fresh shell.
    const root = { t: "pane", id: "p-1", tabs: [{ id: "t-s-1", kind: "thread", thread: "s-1" }], active: "t-s-1" };
    const state = {
      v: 1,
      spaces: [{ id: "sp-main", name: "Main", root, focus: "p-1", mru: [] }],
      current_space: "sp-main",
      default_space: "sp-main",
      threads: { "s-1": { space: "sp-main", quick: { open: false, ran: "npm run dev" } } },
    };
    expect((await fetch(`${mockUrl}/__mock/layout`, { method: "POST", body: JSON.stringify(state) })).ok).toBe(true);
    await page.goto(`${appPath}&shell=1`);
    await expect(page.getByTestId("shell-grid")).toBeVisible();
    await page.getByTestId("composer-input").first().click();
    await page.keyboard.press("Meta+j");
    await expect(page.getByTestId("quick-terminal-host")).toHaveAttribute("data-attach-phase", "live");
    await expect(page.getByTestId("terminal-ran-line")).toContainText("npm run dev");
    await page.screenshot({ path: `${shots ?? ""}/quick-after-snooze${scheme === "light" ? "-light" : ""}.png` });
  });
}
