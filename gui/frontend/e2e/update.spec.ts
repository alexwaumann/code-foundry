import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, mockUrl, openApp, openStreams, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

function indicator(page: Page) {
  return page.getByTestId("update-indicator");
}

function dialog(page: Page) {
  return page.getByTestId("update-dialog");
}

async function liveSessions(): Promise<number> {
  const res = await fetch(`${mockUrl}/__mock/sessions`);
  const list = (await res.json()) as { state: string }[];
  return list.filter((s) => s.state !== "DISCONNECTED").length;
}

async function paletteRun(page: Page, name: string) {
  await page.keyboard.press("Meta+k");
  const item = page.getByTestId("palette").locator(`[data-command="${name}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

test("no indicator while up to date", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("daemon-status")).toBeVisible();
  await expect(indicator(page)).toHaveCount(0);
  // The update source rides the one events stream.
  expect((await openStreams())["UpdateService/Watch"]).toBeUndefined();
});

test("Check for Updates finds a release; the footer and palette offer it", async ({ page }) => {
  await openApp(page);
  await mockPost("update/latest?version=v0.2.0");
  await paletteRun(page, "app.update.check");

  const d = dialog(page);
  await expect(d).toBeVisible();
  await expect(d.getByTestId("update-state")).toHaveText("Code Foundry v0.2.0 is available. You have v0.1.0.");
  await expect(d.getByTestId("update-notes")).toContainText("Release notes for v0.2.0");
  await expect(d.getByTestId("update-install")).toHaveText("Update to v0.2.0");
  await expect(indicator(page)).toHaveText("· update ready v0.2.0");
  expect((await invocations()).at(-1)?.name).toBe("app.update.check");

  // The palette entry carries the version.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="app.update"]')).toContainText("Update to v0.2.0");
});

test("install shows progress, then relaunch and daemon restart", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=available&version=v0.2.0");
  await indicator(page).click();
  const d = dialog(page);
  await d.getByTestId("update-install").click();

  await expect(d).toHaveAttribute("data-state-name", "downloading");
  await expect(d.getByTestId("update-progress")).toContainText("==>");
  await expect(indicator(page)).toHaveText("· updating to v0.2.0…");

  // Installed: the GUI needs a relaunch, the daemon a restart (with a session count).
  await expect(d.getByTestId("update-relaunch-section")).toContainText("Ready: relaunch to apply.", { timeout: 8000 });
  await expect(indicator(page)).toHaveText("· relaunch to apply");
  const restart = d.getByTestId("update-restart-section");
  await expect(restart).toContainText("Daemon restart pending;");
  await expect(restart.getByTestId("restart-sessions")).toHaveText(new RegExp(`^${String(await liveSessions())} sessions?$`));

  // Relaunch goes through the registry; the daemon asks GUIs to relaunch (outside
  // Wails that is a toast), and only the daemon restart is left.
  await d.getByTestId("update-relaunch").click();
  await expect(page.getByText("Relaunch requested")).toBeVisible();
  await expect(indicator(page)).toHaveText("· daemon restart pending");
  await expect(d.getByTestId("update-relaunch-section")).toHaveCount(0);

  // Restart asks for confirmation first, through the registry's confirm flow.
  const n = await liveSessions();
  await d.getByTestId("update-restart").click();
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText(`Close ${String(n)} session${n === 1 ? "" : "s"} and restart the daemon?`);
  await confirm.getByTestId("confirm-ok").click();
  await expect(d).toHaveCount(0);
  await expect(page.getByText("Restarting the daemon", { exact: true })).toBeVisible();
  await expect(indicator(page)).toHaveCount(0);
  const names = (await invocations()).map((i) => i.name);
  expect(names).toEqual(expect.arrayContaining(["app.update", "app.relaunch", "daemon.restart"]));
});

test("app.update from the palette opens the dialog and installs", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=available&version=v0.3.0");
  await expect(indicator(page)).toHaveText("· update ready v0.3.0");
  await paletteRun(page, "app.update");
  await expect(dialog(page)).toHaveAttribute("data-state-name", /downloading|installed/);
  expect((await invocations()).at(-1)?.name).toBe("app.update");
});

test("daemon.restart from the palette asks for confirmation instead of running", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=restartRequired&version=v0.2.0");
  await paletteRun(page, "daemon.restart");
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText(/Close \d+ sessions? and restart the daemon\?/);
  await confirm.getByTestId("confirm-cancel").click();
  await expect(confirm).toHaveCount(0);
  // Only the unconfirmed attempt reached the daemon; nothing restarted.
  const restarts = (await invocations()).filter((i) => i.name === "daemon.restart");
  expect(restarts.map((i) => i.confirmed)).toEqual([false]);
  await expect(indicator(page)).toHaveText("· daemon restart pending");
});

test("a failed install shows the reason and can be retried", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=available&version=v0.2.0");
  await mockPost("update/fail?reason=installer: exit status 1: error: checksum mismatch");
  await indicator(page).click();
  const d = dialog(page);
  await d.getByTestId("update-install").click();
  await expect(d.getByTestId("update-failure")).toHaveText("installer: exit status 1: error: checksum mismatch", { timeout: 8000 });
  await expect(indicator(page)).toHaveText("· update failed");
  await d.getByTestId("update-install").click(); // Retry
  await expect(d.getByTestId("update-relaunch-section")).toBeVisible({ timeout: 8000 });
});

test("dev builds say updates are disabled", async ({ page }) => {
  await openApp(page);
  await mockPost("update/disabled?reason=dev%20build");
  await paletteRun(page, "app.version");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette").locator('[data-command="app.update.check"]').click();
  await expect(dialog(page).getByTestId("update-state")).toHaveText("Updates are disabled for this build (dev build).");
  await expect(dialog(page).getByTestId("update-error")).toContainText("disabled");
  await expect(indicator(page)).toHaveCount(0);
});
