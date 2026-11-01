import { expect, test } from "@playwright/test";
import { invocations, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

// "sidebar new-thread button opens the project picker, then the composer", shortened. The button enabled with nothing selected: src/components/command/CommandButton.test.tsx; No project
// highlighted first and a search's top hit: src/components/compose/ProjectPicker.test.tsx; thread.new's
// args and context: src/lib/compose.test.ts. This keeps the flow through the real editor to the new thread.
test("sidebar new-thread button: the project picker, then typing in the composer starts the thread", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-2").click();
  await page.getByTestId("sidebar-new-thread").click();
  const palette = page.getByTestId("palette");
  await expect(palette).toHaveAttribute("data-mode", "projects");
  await page.keyboard.type("ghostty");
  await page.keyboard.press("Enter");
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await expect(page.getByTestId("composer-input")).toBeFocused();
  await page.keyboard.type("Port the renderer");
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.new");
  expect((await invocations()).at(-1)?.args).toMatchObject({ project: "repo-gp", prompt: "Port the renderer" });
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toHaveAttribute("data-row-key", /^s:s-new-/);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
});

// "status row buttons toggle settings, open help and the palette": src/components/sidebar/SidebarStatus.test.tsx;
// the click on the gear under the sheet's backdrop is e2e/settings-sheet.spec.ts's.

// "thread pane header: the title's menu renames; the crumb is not a button; no Close; fork is palette-only",
// shortened. The header's height is e2e/layout.spec.ts's; no thread buttons but the three toggles, and the crumb's
// place as text: src/components/thread/ThreadParts.test.tsx.
test("thread pane header: the title's menu renames in the sidebar; fork is palette-only", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-1").click();
  const header = page.getByTestId("thread-header");
  // The title's menu: Rename, presented inline in the sidebar, as from the palette.
  await header.getByTestId("thread-title").click();
  await page.getByTestId("thread-title-menu").getByTestId("menu-rename").click();
  await expect(page.getByTestId("rename-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // Fork stays in the palette: it runs with the thread's context and the daemon selects the fork.
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Fork Thread");
  await page.getByTestId("palette").locator('[data-command="thread.fork"]').click();
  await expect.poll(async () => (await invocations()).at(-1)?.name).toBe("thread.fork");
  expect((await invocations()).at(-1)?.context?.activeThreadId).toBe("s-1");
  await expect(page.locator('[data-row-kind="thread"][aria-selected="true"]')).toHaveAttribute("data-row-key", /^s:s-new-/);
});
