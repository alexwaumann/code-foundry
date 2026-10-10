import { expect, test, type Page } from "@playwright/test";
import { invocations, mockPost, openApp, openStreams, resetMock } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

function indicator(page: Page) {
  return page.getByTestId("update-indicator");
}

function dialog(page: Page) {
  return page.getByTestId("update-dialog");
}

async function paletteRun(page: Page, name: string) {
  await page.keyboard.press("Meta+k");
  const item = page.getByTestId("palette").locator(`[data-command="${name}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

/**
 * Makes thread activity deterministic: s-1 alternates busy/idle in the mock, so park it
 * in needs-attention (that sticks), then add `busy` threads that stay busy.
 */
async function settleThreads(busy: number): Promise<void> {
  await mockPost("session/status?id=s-1&status=attention");
  if (busy > 0) await mockPost(`threads?repo=repo-cf&count=${String(busy)}&status=busy&prefix=Job`);
}

async function expectChip(page: Page, kind: string, label: string, cta: string | null) {
  await expect(indicator(page)).toHaveAttribute("data-kind", kind);
  await expect(indicator(page).getByTestId("update-indicator-label")).toHaveText(label);
  if (cta === null) await expect(indicator(page).getByTestId("update-indicator-cta")).toHaveCount(0);
  else await expect(indicator(page).getByTestId("update-indicator-cta")).toHaveText(cta);
}

test("up to date: no chip; the dialog is the only state with a ×", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("daemon-status")).toBeVisible();
  await expect(indicator(page)).toHaveCount(0);
  // The update source rides the one events stream.
  expect((await openStreams())["UpdateService/Watch"]).toBeUndefined();

  await paletteRun(page, "app.update.check");
  const d = dialog(page);
  await expect(d).toHaveAttribute("data-variant", "upToDate");
  await expect(d.getByTestId("update-state")).toHaveText("You’re up to date");
  await expect(d).toContainText("Code Foundry v0.1.0 is the latest version.");
  await expect(d.getByTestId("update-check")).toHaveText("Check Again");
  await expect(d.getByTestId("update-meta")).toContainText("Checked just now");
  await expect(d.getByTestId("update-meta")).toContainText("github.com/alexwaumann/code-foundry");
  await expect(d.getByTestId("update-later")).toHaveCount(0);
  await d.getByTestId("update-close").click();
  await expect(d).toHaveCount(0);
});

test("Check for Updates finds a release; the chip and the palette offer it", async ({ page }) => {
  await openApp(page);
  await mockPost("update/latest?version=v0.2.0");
  await paletteRun(page, "app.update.check");

  const d = dialog(page);
  await expect(d).toHaveAttribute("data-variant", "available");
  await expect(d.getByTestId("update-state")).toHaveText("Code Foundry v0.2.0 is available");
  await expect(d).toContainText("You’re on v0.1.0. Installing happens in the background; you’ll be asked to restart when it’s done.");
  await expect(d.getByTestId("update-install")).toHaveText("Install v0.2.0");
  await expect(d.getByTestId("update-notes")).toHaveText("Release notes");
  await expect(d.getByTestId("update-later")).toHaveText("Later");
  await expect(d.getByTestId("update-close")).toHaveCount(0);
  await expectChip(page, "available", "v0.2.0 available", "Install");
  expect((await invocations()).at(-1)?.name).toBe("app.update.check");

  // Later closes; the palette entry carries the version.
  await d.getByTestId("update-later").click();
  await expect(d).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="app.update"]')).toContainText("Update to v0.2.0");
});

test("install shows progress, then lists busy threads; Restart Now runs app.restart confirmed", async ({ page }) => {
  await openApp(page);
  await settleThreads(2);
  await mockPost("update/state?state=available&version=v0.2.0");
  await indicator(page).click();
  const d = dialog(page);
  await d.getByTestId("update-install").click();

  await expect(d).toHaveAttribute("data-state-name", "downloading");
  await expect(d).toHaveAttribute("data-variant", "installing");
  await expect(d.getByTestId("update-state")).toHaveText("Installing v0.2.0…");
  await expect(d.getByTestId("update-progress")).toContainText("==>");
  await expect(d.getByTestId("update-later")).toHaveText("Hide");
  await expectChip(page, "downloading", "Installing v0.2.0…", null);

  // Installed with two threads mid-turn: they are named, with the right count.
  await expect(d).toHaveAttribute("data-variant", "readyBusy", { timeout: 8000 });
  await expect(d.getByTestId("update-state")).toHaveText("Code Foundry v0.2.0 is ready");
  await expect(d).toContainText("Restarting now cuts these threads off mid-turn.");
  const box = d.getByTestId("update-busy-threads");
  await expect(box.getByTestId("update-busy-heading")).toHaveText("2 threads are still working");
  await expect(box.getByTestId("update-busy-thread")).toHaveText([/^Job 1\s*working$/, /^Job 2\s*working$/]);
  await expect(d.getByTestId("update-later")).toHaveText("Wait, I’ll restart later");
  await expect(d.getByTestId("update-meta")).toContainText("Running v0.1.0");
  await expect(d.getByTestId("update-close")).toHaveCount(0);
  await expectChip(page, "installed", "v0.2.0 installed", "Restart to apply");

  // A third busy thread shows up live.
  await mockPost("session/status?id=s-2&status=busy");
  await expect(box.getByTestId("update-busy-heading")).toHaveText("3 threads are still working");
  await expect(box).toContainText("Port renderer");

  // Restart Now: the dialog is the confirmation, so no confirm dialog and one confirmed call.
  await d.getByTestId("update-restart").click();
  await expect(d).toHaveAttribute("data-variant", "restarting");
  await expect(d.getByTestId("update-state")).toHaveText("Restarting…");
  await expect(d).toContainText("Code Foundry will reopen in a moment.");
  await expect(d.getByTestId("update-meta")).toHaveText("Stopping daemon");
  await expect(d.locator("button")).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  const restarts = (await invocations()).filter((i) => i.name === "app.restart" || i.name === "daemon.restart");
  expect(restarts.map((i) => [i.name, i.confirmed])).toEqual([["app.restart", true]]);
  // The mock comes back as the installed version; nothing is pending any more.
  await expect(indicator(page)).toHaveCount(0);
});

test("installed with threads open but none working says nothing will be interrupted", async ({ page }) => {
  await openApp(page);
  await settleThreads(0);
  await mockPost("update/state?state=installed&version=v0.2.0");
  await expectChip(page, "installed", "v0.2.0 installed", "Restart to apply");
  await indicator(page).click();
  const d = dialog(page);
  await expect(d).toHaveAttribute("data-variant", "readyOpen");
  await expect(d).toContainText(/Restart to finish updating\. \d+ threads are open but none are working, so nothing will be interrupted\. They’ll reconnect with their history\./);
  await expect(d.getByTestId("update-busy-threads")).toHaveCount(0);
  await expect(d.getByTestId("update-restart")).toHaveText("Restart Now");
  await expect(d.getByTestId("update-later")).toHaveText("Later");
  await d.getByTestId("update-later").click();
  await expect(d).toHaveCount(0);
});

test("installed with nothing running", async ({ page }) => {
  await openApp(page);
  await mockPost("empty");
  await mockPost("update/state?state=restartRequired&version=v0.2.0");
  await indicator(page).click();
  const d = dialog(page);
  await expect(d).toHaveAttribute("data-variant", "readyIdle");
  await expect(d).toContainText("Restart to finish updating. Nothing is running right now, so nothing will be interrupted.");
});

test("app.update from the palette opens the dialog and installs", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=available&version=v0.3.0");
  await expectChip(page, "available", "v0.3.0 available", "Install");
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
  await expectChip(page, "installed", "v0.2.0 installed", "Restart to apply");
});

test("a failed install shows the reason and can be retried", async ({ page }) => {
  await openApp(page);
  await settleThreads(0);
  await mockPost("update/state?state=available&version=v0.2.0");
  await mockPost("update/fail?reason=installer: exit status 1: error: checksum mismatch");
  await indicator(page).click();
  const d = dialog(page);
  await d.getByTestId("update-install").click();
  await expect(d.getByTestId("update-failure")).toHaveText("installer: exit status 1: error: checksum mismatch", { timeout: 8000 });
  await expect(d).toHaveAttribute("data-variant", "failed");
  await expect(d.getByTestId("update-state")).toHaveText("Couldn’t install v0.2.0");
  await expect(d).toContainText("Nothing changed. You’re still on v0.1.0.");
  await expect(d).toContainText("Installer exited with status 1");
  await expect(d.getByTestId("update-install")).toHaveText("Try Again");
  await expect(d.getByTestId("update-later")).toHaveText("Not now");
  await expect(d.getByTestId("update-close")).toHaveCount(0);
  await expectChip(page, "failed", "Update failed", "Details");
  await d.getByTestId("update-install").click(); // Try Again
  await expect(d).toHaveAttribute("data-variant", /^ready/, { timeout: 8000 });
  await expect(d.getByTestId("update-restart")).toBeVisible();
});

test("dev builds say updates are off", async ({ page }) => {
  await openApp(page);
  await mockPost("update/disabled?reason=dev%20build");
  await page.keyboard.press("Meta+k");
  await page.getByTestId("palette").locator('[data-command="app.update.check"]').click();
  const d = dialog(page);
  await expect(d.getByTestId("update-state")).toHaveText("Updates are off for this build");
  await expect(d).toContainText("Dev build.");
  await expect(d.getByTestId("update-error")).toContainText("disabled");
  await expect(d.getByTestId("update-close")).toBeVisible();
  await expect(indicator(page)).toHaveCount(0);
});
