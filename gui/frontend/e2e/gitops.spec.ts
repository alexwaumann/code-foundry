import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

const toast = (page: Page, title: string) => page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-title]", { hasText: title }) });

/** The thread on code-foundry's main worktree: git commands take their worktree from the selection. */
async function selectMainWorktree(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-1").click();
}

test("a git op shows a progress toast, then its result (no duplicate command toast)", async ({ page }) => {
  await mockPost("gitops?delay=1200");
  await selectMainWorktree(page);
  await page.keyboard.press("Meta+Shift+k"); // git.push

  const push = toast(page, "Push main");
  await expect(push.getByTestId("gitop-toast")).toHaveAttribute("data-state", "running");
  await expect(push).toContainText("code-foundry");

  await expect(push.getByTestId("gitop-toast")).toHaveAttribute("data-state", "succeeded");
  await expect(push.getByTestId("gitop-summary")).toHaveText("pushed main to origin");
  // runCommand's generic success toast is suppressed for gitops results.
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "pushed main to origin" })).toHaveCount(1);

  const inv = (await invocations()).filter((i) => i.name === "git.push");
  expect(inv).toHaveLength(1);
  expect(inv[0]?.context?.activeWorktreePath).toBe(CF);
});

// A failure's output toggle and close button, CLI-started ops and a created PR's Open: unit-tested
// in src/components/gitops/GitOpToast.test.tsx (the duplicate command toast in src/stores/commands.test.ts).

test("a second op on the same worktree shows as waiting", async ({ page }) => {
  await mockPost("gitops?delay=1500");
  await selectMainWorktree(page);
  await page.keyboard.press("Meta+Shift+f"); // git.fetch
  await expect(toast(page, "Fetch main").first().getByTestId("gitop-toast")).toHaveAttribute("data-state", "running");
  await page.keyboard.press("Meta+Shift+u"); // git.pull, queued behind the fetch
  const pull = toast(page, "Pull main");
  await expect(pull.getByTestId("gitop-toast")).toHaveAttribute("data-state", "queued");
  await expect(pull).toContainText("waiting for the previous operation");
  await expect(pull.getByTestId("gitop-toast")).toHaveAttribute("data-state", "running");
  await expect(pull.getByTestId("gitop-summary")).toHaveText(/fast-forwarded/);
});
