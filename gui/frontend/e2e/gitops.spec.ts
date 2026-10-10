import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { CF, invocations, mockPost, mockUrl, openApp, resetMock, selectWorktree } from "./fixtures";

test.beforeEach(async () => {
  await resetMock();
});

const toast = (page: Page, title: string) => page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-title]", { hasText: title }) });

async function selectMainWorktree(page: Page): Promise<void> {
  await openApp(page);
  await selectWorktree(page, "repo-cf", CF);
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

test("a failed op stays up and expands to show the output", async ({ page }) => {
  await mockPost("gitops?delay=300&fail=git.push");
  await selectMainWorktree(page);
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="git.push"]').click();

  const failed = toast(page, "Push main failed");
  await expect(failed.getByTestId("gitop-summary")).toHaveText("[rejected] main -> main (fetch first)");
  await expect(failed.getByTestId("gitop-output")).toHaveCount(0);
  await failed.getByTestId("gitop-output-toggle").click();
  await expect(failed.getByTestId("gitop-output")).toContainText("! [rejected]        main -> main (fetch first)");
  await expect(failed.getByTestId("gitop-output")).toContainText("hint: Updates were rejected");
  // No generic "Git: Push failed" toast on top of it.
  await expect(page.locator("[data-sonner-toast]").filter({ hasText: "Git: Push failed" })).toHaveCount(0);
  // Failures do not auto-dismiss.
  await page.waitForTimeout(5500);
  await expect(failed).toBeVisible();
});

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

test("ops started outside the GUI (CLI) get toasts too", async ({ page }) => {
  await mockPost("gitops?delay=200");
  await openApp(page);
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name: "git.fetch", args: { worktree: `${CF}.worktrees/fix-resize` } }),
  });
  expect(res.ok).toBe(true);
  const fetched = toast(page, "Fetch fix/resize");
  await expect(fetched.getByTestId("gitop-summary")).toHaveText("fetched 2 updated refs");
  await expect(fetched).toContainText("fix-resize");
});

test("pr.create needs a GitHub repo; its result offers to open the PR", async ({ page }) => {
  await mockPost("gitops?delay=200");
  await openApp(page);
  await selectWorktree(page, "repo-dot", "/Users/dev/dotfiles");
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-command="git.fetch"]')).toBeVisible();
  await expect(palette.locator('[data-command="pr.create"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  await selectWorktree(page, "repo-cf", `${CF}.worktrees/feat-sidebar`);
  await page.keyboard.press("Meta+k");
  await palette.locator('[data-command="pr.create"]').click();
  const created = toast(page, "Create PR for feat/sidebar");
  await expect(created.getByTestId("gitop-summary")).toHaveText("created pull request #128");
  await created.getByRole("button", { name: "Open" }).click();
  await expect
    .poll(async () => (await invocations()).find((i) => i.name === "view.open.url")?.args.url)
    .toBe("https://github.com/alexwaumann/code-foundry/pull/128");
  await expect(toast(page, "Open https://github.com/alexwaumann/code-foundry/pull/128").getByTestId("gitop-toast")).toHaveAttribute("data-state", "succeeded");
});
