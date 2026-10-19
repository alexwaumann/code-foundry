import { expect, test } from "@playwright/test";
import { expectTooltip, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

// A plugin's session environment changed since a running thread's Claude started
// (Thread.plugin_env_stale; docs/notes/plugins-env-restart.md): the thread header shows a
// muted "Plugin environment changed · Restart to apply"; Restart is thread.restart, which
// asks only when it would interrupt a turn. The mock's POST /__mock/thread/envstale is the
// daemon's staleness check.

test.beforeEach(async () => {
  await resetMock();
});

const stale = (id: string, change: string) => mockPost(`thread/envstale?id=${id}&change=${encodeURIComponent(change)}`);

test("an idle stale thread shows the header line; Restart restarts Claude at once and the line goes", async ({ page }) => {
  await openApp(page);
  await mockPost("thread/status?id=s-1&status=idle");
  await row(page, "s:s-1").click();
  const header = page.getByTestId("thread-header");
  await expect(header.getByTestId("thread-env-stale")).toHaveCount(0);

  await stale("s-1", "Hello removed CF_HELLO");
  const note = header.getByTestId("thread-env-stale");
  await expect(note).toHaveText("Plugin environment changed·Restartto apply");
  await expectTooltip(
    page,
    note.getByTestId("thread-env-stale-text"),
    /^Hello removed CF_HELLO\.\s*Claude is still running with the old environment\. Restart restarts the Claude process with the new one; the conversation continues\.$/,
  );

  await note.getByTestId("thread-env-stale-restart").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  await expect(note).toHaveCount(0);
  await expect(page.getByTestId("thread-pane").getByText("Restarted Claude")).toBeVisible();
  const calls = (await invocations()).filter((i) => i.name === "thread.restart");
  expect(calls.map((i) => [i.context?.activeThreadId, i.confirmed ?? false])).toEqual([["s-1", false]]);
});

test("restarting a working thread asks first: the conversation continues, the turn is interrupted", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  await stale("s-1", "GitHub Actions added 2 variables");
  const note = page.getByTestId("thread-header").getByTestId("thread-env-stale");
  await expect(note).toBeVisible();

  await note.getByTestId("thread-env-stale-restart").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Restart Claude for Refactor sidebar tree? The conversation continues; the current turn is interrupted.");
  await expect(page.getByTestId("confirm-ok")).toHaveText("Restart Claude");
  await page.getByTestId("confirm-cancel").click();
  await expect(note).toBeVisible();

  await note.getByTestId("thread-env-stale-restart").click();
  await page.getByTestId("confirm-ok").click();
  await expect(note).toHaveCount(0);
  const confirmed = (await invocations()).filter((i) => i.name === "thread.restart");
  expect(confirmed.map((i) => i.confirmed ?? false)).toEqual([false, false, true]);
});
