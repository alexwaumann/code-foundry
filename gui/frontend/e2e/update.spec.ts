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

async function paletteRun(page: Page, name: string) {
  await page.keyboard.press("Meta+k");
  const item = page.getByTestId("palette").locator(`[data-command="${name}"]`);
  await expect(item).toBeVisible();
  await item.click();
}

/**
 * Makes thread activity deterministic: s-1 alternates busy/idle in the mock, so park it on
 * a finished turn (that sticks; a restart does not cut it off), stop the settling s-5/s-6,
 * then add `busy` threads that stay busy. s-2 keeps waiting on a permission prompt: a
 * restart cuts it off too ("waiting on you").
 */
async function settleThreads(busy: number): Promise<void> {
  await mockPost("thread/status?id=s-1&status=attention&reason=finished");
  for (const id of ["s-5", "s-6"]) await mockPost(`thread/stop?id=${id}&reason=idle&code=0&status=idle`);
  if (busy > 0) await mockPost(`threads?project=repo-cf&count=${String(busy)}&status=busy&prefix=Job`);
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
  await expect(d).toContainText("You’re on v0.1.0. Downloading happens in the background and changes nothing until you restart.");
  await expect(d.getByTestId("update-download")).toHaveText("Download v0.2.0");
  await expect(d.getByTestId("update-notes")).toHaveText("Release notes");
  await expect(d.getByTestId("update-later")).toHaveText("Later");
  await expect(d.getByTestId("update-close")).toHaveCount(0);
  await expectChip(page, "available", "v0.2.0 available", "Download");
  expect((await invocations()).at(-1)?.name).toBe("app.update.check");

  // Later closes; the palette entry carries the version.
  await d.getByTestId("update-later").click();
  await expect(d).toHaveCount(0);
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="app.update"]')).toContainText("Download v0.2.0");
});

// Downloading, the busy-thread list (live), Install and Restart Now: unit-tested in src/components/update/UpdateDialog.test.tsx.

test("available → Download → downloading → downloaded → Install and Restart Now", async ({ page }) => {
  await openApp(page);
  await settleThreads(0);
  await mockPost("thread/stop?id=s-2&reason=idle&code=0");
  await mockPost("update/latest?version=v0.2.0");
  await paletteRun(page, "app.update.check");
  const d = dialog(page);
  await expect(d).toHaveAttribute("data-variant", "available");
  await d.getByTestId("update-download").click();
  expect((await invocations()).at(-1)?.name).toBe("app.update");

  // The download stages the release; the progress line follows the installer's output.
  await expect(d).toHaveAttribute("data-variant", "downloading");
  await expect(d.getByTestId("update-progress")).toHaveText(/^==> (downloading|verifying|unpacking|downloaded)/);
  await expect(d.getByTestId("update-download")).toHaveCount(0);

  await expect(d).toHaveAttribute("data-state-name", "downloaded", { timeout: 8000 });
  await expect(d).toHaveAttribute("data-variant", "readyIdle");
  await expect(d.getByTestId("update-state")).toHaveText("Code Foundry v0.2.0 is ready");
  await expect(d).toContainText(
    "Install and restart to finish updating. The app and the daemon update together, so nothing ends up out of sync. No thread is working or waiting on you, so nothing will be interrupted.",
  );
  await expect(d.getByTestId("update-busy-threads")).toHaveCount(0);
  await expect(d.getByTestId("update-restart")).toHaveText("Install and Restart Now");
  await expect(d.getByTestId("update-later")).toHaveText("Later");
  await expectChip(page, "downloaded", "v0.2.0 downloaded", "Restart to apply");
  // Nothing installed yet: the daemon still runs v0.1.0.
  expect(await (await fetch(`${mockUrl}/__mock/update`)).json()).toMatchObject({ state: "DOWNLOADED", current: "v0.1.0", target: "v0.2.0", restarts: 0 });

  // The palette's app.restart says what it will do.
  await d.getByTestId("update-later").click();
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette").locator('[data-command="app.restart"]')).toContainText("Install v0.2.0 and Restart");
  await page.keyboard.press("Escape");

  await indicator(page).click();
  await d.getByTestId("update-restart").click();
  await expect(d.getByTestId("update-state")).toHaveText("Installing and restarting…");
  await expect(d).toContainText("Code Foundry will reopen in a moment on v0.2.0.");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  const restarts = (await invocations()).filter((i) => i.name === "app.restart" || i.name === "daemon.restart");
  expect(restarts.map((i) => [i.name, i.confirmed])).toEqual([["app.restart", true]]);
  // The mock comes back as the installed version.
  await expect(indicator(page)).toHaveCount(0);
  expect(await (await fetch(`${mockUrl}/__mock/update`)).json()).toMatchObject({ state: "IDLE", current: "v0.2.0", restarts: 1 });
});

// Installed with a thread stopped while waiting (not cut off): unit-tested in src/components/update/UpdateDialog.test.tsx.

test("app.update from the palette opens the dialog and downloads", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=available&version=v0.3.0");
  await expectChip(page, "available", "v0.3.0 available", "Download");
  await paletteRun(page, "app.update");
  await expect(dialog(page)).toHaveAttribute("data-state-name", /downloading|downloaded/);
  expect((await invocations()).at(-1)?.name).toBe("app.update");
});

test("daemon.restart from the palette asks for confirmation instead of running", async ({ page }) => {
  await openApp(page);
  await mockPost("update/state?state=restartRequired&version=v0.2.0");
  await paletteRun(page, "daemon.restart");
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toContainText(/\d+ threads? working or waiting on you( and [^.]+)? will be cut off\. Restart the daemon anyway\?/);
  await confirm.getByTestId("confirm-cancel").click();
  await expect(confirm).toHaveCount(0);
  // Only the unconfirmed attempt reached the daemon; nothing restarted.
  const restarts = (await invocations()).filter((i) => i.name === "daemon.restart");
  expect(restarts.map((i) => i.confirmed)).toEqual([false]);
  await expectChip(page, "installed", "v0.2.0 installed", "Restart to apply");
});

// A failed download and Try Again: unit-tested in src/components/update/UpdateDialog.test.tsx.

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
