import { expect, test, type Page } from "@playwright/test";
import { appPath, mockPost, resetMock } from "./fixtures";

/**
 * A daemon from before the shell, whatever version it reports (docs/notes/shell-24d-spec-differences.md,
 * 5): it has no LayoutService, so its mux answers the window's Get with a plain 404 through the
 * tunnel, and its event stream never sends a layout. What only the real transport shows: that 404
 * reaches the window as "no such service", and after the wait the notice with Restart Now takes
 * the waiting text's place. What the notice and Restart Now do is vitest's (shell/layoutService,
 * components/shell/ShellNotice and Shell tests). SHOTS=<dir> for the PR's screenshots.
 */

async function open(page: Page): Promise<void> {
  await resetMock();
  await mockPost("layout/service?off=1");
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto(`${appPath}&shell=1`);
}

test.afterEach(async () => {
  await mockPost("layout/service?off=0");
});

test("a daemon without the layout service: after the wait, the notice says so and offers Restart Now", async ({ page }) => {
  await open(page);
  // The wait (Shell LAYOUT_WAIT_MS, 5 s), then one Get answered with the mux's 404.
  const notice = page.getByTestId("shell-old-daemon");
  await expect(notice).toBeVisible({ timeout: 15_000 });
  await expect(notice.getByRole("heading")).toHaveText("The running daemon is older than this window");
  await expect(notice.getByRole("button", { name: "Restart Now" })).toBeEnabled();
  await expect(page.getByText("Waiting for the daemon to send this window's layout…")).toHaveCount(0);
  await expect(page.getByTestId("shell-grid")).toHaveCount(0);
});

/** SHOTS=<dir>: the notice, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test(`old daemon notice screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await open(page);
    await expect(page.getByTestId("shell-old-daemon")).toBeVisible({ timeout: 15_000 });
    await page.mouse.move(1390, 890);
    await page.screenshot({ path: `${shots ?? ""}/old-daemon${scheme === "light" ? "-light" : ""}.png` });
  });
}
