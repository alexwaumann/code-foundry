import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, resetMock } from "./fixtures";

/**
 * A description's task boxes (docs/notes/pr-checkbox-gui.md): what only a browser shows, the
 * box hanging in the list's gutter with its hover ring, and a tick reaching the mock and
 * coming back through the detail. Who gets a box, what is sent, the optimistic state and the
 * refusal: src/components/pr/PrDescriptionTasks.test.tsx. Set SHOTS=<dir> to save the PR's
 * screenshots (WebKit, 1400x900, dark and light).
 */

const shots = process.env.SHOTS;
const MANUAL = "resize a thread while it prints (manual)";

test.beforeEach(async () => {
  await resetMock();
});

async function openPr145(page: Page): Promise<void> {
  await page.getByTestId("nav-pullrequests").click();
  await page.getByTestId("prs-authored").locator("[data-nav-key]").filter({ hasText: "#145" }).click();
  await expect(page.getByTestId("pr-surface")).toBeVisible();
}

const box = (page: Page, name: string) => page.getByTestId("pr-description").getByRole("checkbox", { name });

test("the box hangs in the gutter, rings on hover, and a tick comes back from the daemon", async ({ page }) => {
  await openApp(page);
  await openPr145(page);
  const manual = box(page, MANUAL);
  const b = await manual.boundingBox();
  const text = await page.getByTestId("pr-description").locator("li", { hasText: MANUAL }).evaluate((li) => {
    const range = document.createRange();
    range.selectNodeContents(li);
    const rects = [...range.getClientRects()].filter((r) => r.width > 40);
    return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) };
  });
  if (!b) throw new Error("no box");
  // Clear of the 3px hover ring.
  expect(b.x + b.width + 3).toBeLessThanOrEqual(text.left);
  expect(Math.abs(b.y + b.height / 2 - (text.top + text.bottom) / 2)).toBeLessThanOrEqual(3);

  await manual.hover();
  await expect(manual).not.toHaveCSS("box-shadow", "none");

  await manual.click();
  await expect(manual).toHaveAttribute("aria-checked", "true");
  await expect(manual).toHaveAttribute("aria-busy", "false");
  // Read again: this is the mock's body now, not the click's state.
  await openApp(page);
  await openPr145(page);
  await expect(box(page, MANUAL)).toHaveAttribute("aria-checked", "true");
});

for (const scheme of ["dark", "light"] as const) {
  test(`task box screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openApp(page);
    await openPr145(page);
    const manual = box(page, MANUAL);
    await manual.scrollIntoViewIfNeeded();
    // The side panel, toasts included.
    const panel = await page.getByTestId("pr-surface").boundingBox();
    if (!panel) throw new Error("no panel");
    const shoot = (name: string) => page.screenshot({ path: `${shots ?? ""}/${name}${suffix}.png`, clip: { x: panel.x - 12, y: 0, width: 1400 - panel.x + 12, height: 900 } });

    await manual.hover();
    await shoot("pr-task-hover");

    await mockPost("gh/pr-detail-delay?ms=4000");
    await manual.click();
    await expect(page.getByTestId("pr-task-saving")).toBeVisible();
    await page.mouse.move(700, 300);
    await shoot("pr-task-saving");
    await expect(page.getByTestId("pr-task-saving")).toHaveCount(0, { timeout: 10_000 });
    await mockPost("gh/pr-detail-delay?ms=0");

    await mockPost("gh/pr-fail?command=pr.checkbox");
    await manual.click();
    await expect(page.getByText("has a different task 2")).toBeVisible();
    await expect(manual).toHaveAttribute("aria-checked", "true");
    await page.mouse.move(700, 300);
    await page.waitForTimeout(600); // the toast's slide in
    await shoot("pr-task-refused");
  });
}
