import { expect, test } from "@playwright/test";
import { mockPost, openApp, resetMock, row, threadPrompt } from "./fixtures";

// Moving a No project thread into a project (docs/notes/move-no-project-2-gui.md), against
// the mock's thread.move. The steps, the request each choice builds, the menu items, the
// moving crumb, the refusal and Enter: src/components/thread/MovePicker.test.tsx,
// src/lib/move.test.ts and ThreadMenuItems.test.tsx. What is left: the popover under the
// crumb, the keyboard surviving a closing menu or palette, and a whole move over the
// mock's streams, and where the keyboard goes when the crumb's trigger unmounts.

test.beforeEach(async () => {
  await resetMock();
});

async function homeThread(): Promise<string> {
  const { id } = (await mockPost("thread-info?scenario=home")) as { id: string };
  return id;
}

test("the sidebar row's Move to project… opens the thread and the picker under its crumb; a move lands over the streams", async ({ page }) => {
  const id = await homeThread();
  await openApp(page);
  await row(page, `s:${id}`).click({ button: "right" });
  await page.getByTestId("menu-move").click();

  const picker = page.getByTestId("move-picker");
  await expect(picker).toBeVisible();
  // Under the crumb, its left edge with the crumb's.
  const place = await page.getByTestId("thread-crumb-move").boundingBox();
  const box = await picker.boundingBox();
  if (!place || !box) throw new Error("no layout");
  expect(box.y).toBeGreaterThan(place.y + place.height);
  expect(box.y).toBeLessThan(place.y + place.height + 16);
  expect(Math.abs(box.x - place.x)).toBeLessThan(12);
  await expect(page.getByTestId("move-filter")).toBeFocused();

  // Filter, Enter picks; Enter again moves (the setting's default: the project folder).
  await page.keyboard.type("code-f");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("move-placement")).toBeFocused();
  await mockPost("thread/move-delay?ms=1500");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("Moving to code-foundry…");
  // The trigger went with the popover: the thread's prompt has the keyboard, and typing lands there.
  await expect(threadPrompt(page)).toBeFocused();

  // Landed: renamed, the crumb and the row name the project, the timeline has the note.
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("code-foundry");
  await expect(page.getByTestId("thread-title-name")).toHaveText("Fix the login redirect");
  await expect(row(page, `s:${id}`)).toContainText("code-foundry");
  await expect(page.getByText(/Moved this thread to code-foundry/)).toBeVisible();
});

test("the palette's Move Thread and the title menu's Move to project… open the picker after they close; Esc closes it", async ({ page }) => {
  const id = await homeThread();
  await openApp(page);
  await row(page, `s:${id}`).click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Move Thread to a Project");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("palette")).toHaveCount(0);
  await expect(page.getByTestId("move-filter")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("move-picker")).toHaveCount(0);

  await page.getByTestId("thread-title").click();
  await page.getByTestId("menu-move").click();
  await expect(page.getByTestId("move-filter")).toBeFocused();
  await expect(page.getByTestId("thread-crumb-move")).toHaveAttribute("aria-expanded", "true");
});

test("a refused move leaves the keyboard in the thread's prompt", async ({ page }) => {
  const id = await homeThread();
  await openApp(page);
  await row(page, `s:${id}`).click();
  await page.getByTestId("thread-crumb-move").click();
  await page.keyboard.type("code-f");
  await page.keyboard.press("Enter");
  await mockPost("thread/move-delay?ms=300");
  await mockPost("thread/move-fail?message=set_cwd refused");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("thread-crumb-place")).toHaveText("No project");
  await expect(threadPrompt(page)).toBeFocused();
  await page.keyboard.type("still here");
  await expect(threadPrompt(page)).toContainText("still here");
});
