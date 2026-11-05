import { expect, test, type Page } from "@playwright/test";
import { composeProject, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * Sending from the new-thread composer with the setup in the background
 * (docs/notes/instant-threads-4-composer.md): what crosses routes and the daemon's streams.
 * The thread opens from a reply that does not wait, its rows arrive on the stream, and Edit
 * goes back to the composer with the keyboard there. The rules are vitest's
 * (stores/setupActions.test.ts, components/thread/ThreadComposerSetup.test.tsx). Set
 * SHOTS=<dir> to save screenshots (WebKit, dark and light).
 */

const PROMPT = "Fix the stale PR badge";

const setup = (id: string, state: string) => mockPost(`thread/setup?id=${id}&state=${state}`);

async function sendFromComposer(page: Page, state: string): Promise<string> {
  await mockPost(`thread-setup?state=${state}`);
  await composeProject(page);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type(PROMPT);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  const created = (await invocations()).filter((i) => i.name === "thread.new");
  expect(created.at(-1)?.args["background-setup"]).toBe("true");
  return (await page.getByTestId("thread-pane").getAttribute("data-thread-id")) ?? "";
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  await openApp(page);
});

test("send: the thread opens at once with the message and its rows; a failure, Edit, and the prompt is back with the keyboard", async ({ page }) => {
  const id = await sendFromComposer(page, "running");
  await expect(page.locator('[data-row-type="user"]').first()).toContainText(PROMPT);
  await expect(page.getByTestId("thread-setup-live")).toBeVisible();
  await expect(page.getByTestId("thread-setup-cancel")).toBeVisible();
  await expect(row(page, `s:${id}`)).toBeVisible();

  await setup(id, "failed");
  await expect(page.getByTestId("thread-setup-note")).toBeVisible();
  await page.getByTestId("thread-setup-edit").click();

  await expect(page.getByTestId("thread-pane")).toHaveCount(0);
  await expect(page.getByTestId("composer-input")).toContainText(PROMPT);
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await expect(row(page, `s:${id}`)).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("Cancel: the rows give way to one quiet line, the note comes, and Try again runs it again", async ({ page }) => {
  const id = await sendFromComposer(page, "running");
  await page.getByTestId("thread-setup-cancel").click();
  await expect(page.locator('[data-testid="thread-setup"][data-phase="cancelled"]')).toBeVisible();
  await expect(page.getByTestId("thread-setup-reason")).toHaveText("Setup cancelled, so your message was not sent.");
  await page.getByTestId("thread-setup-retry").click();
  await expect(page.getByTestId("thread-setup-note")).toHaveCount(0);
  await expect(page.getByTestId("thread-setup-live")).toBeVisible();
  await expect(row(page, `s:${id}`)).toBeVisible();
});

/** SHOTS=<dir>: the composer through a setup, for the PR. */
for (const scheme of ["dark", "light"] as const) {
  test(`composer screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1000, height: 640 });
    const shot = (name: string) => page.screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    const id = await sendFromComposer(page, "running");
    await expect(page.getByTestId("thread-setup-cancel")).toBeVisible();
    await page.mouse.move(600, 400);
    await shot("composer-during-setup");
    await setup(id, "failed");
    await expect(page.getByTestId("thread-setup-note")).toBeVisible();
    await shot("composer-failed");
    await setup(id, "cancelled");
    await expect(page.getByTestId("thread-setup-reason")).toContainText("Setup cancelled");
    await shot("composer-cancelled");
    await page.getByTestId("thread-setup-edit").click();
    await expect(page.getByTestId("composer-input")).toBeFocused();
    await shot("composer-after-edit");
  });
}
