import { expect, test, type Locator, type Page } from "@playwright/test";
import { CF, infoCardOff, mockPost, openApp, openProjectPage, resetMock, row } from "./fixtures";

/**
 * A copy shows where it was pressed (docs/notes/toast-success-rule.md): what only the real
 * theme CSS shows is the check's colour, the success slot, in both schemes. The check, its
 * name and its timing: src/components/ui/copy-button.test.tsx; no toast, and a menu's copy
 * that keeps its toast: ThreadInfoCard.test.tsx and menus.test.ts. SHOTS=<dir> saves the
 * pull request's screenshots.
 */

test.beforeEach(async () => {
  await resetMock();
  await infoCardOff();
});

const FEAT = `${CF}.worktrees/feat-sidebar`;
const card = (page: Page) => page.getByTestId("thread-info-card");

/** A slot's colour as the browser computes it (rgb()), to compare with a computed style. */
const slot = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

/** A thread with the info card open (its branch row). */
async function openCard(page: Page): Promise<void> {
  const { id } = (await mockPost("thread-info?scenario=single")) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await page.getByTestId("thread-info-toggle").click();
  await expect(card(page)).toBeVisible();
}

const checkColour = (el: Locator) => el.locator("svg[data-copied]").evaluate((svg) => getComputedStyle(svg).color);

for (const scheme of ["dark", "light"] as const) {
  test(`${scheme}: a copy's check is the success colour, on a copy button and on the card's branch row`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    await openProjectPage(page, "repo-cf");
    const copy = page.getByTestId("details-copy-path");
    await copy.click();
    await expect(copy).toHaveAttribute("data-copied", "true");
    expect(await checkColour(copy)).toBe(await slot(page, "--cf-success-text"));

    await openCard(page);
    const branch = card(page).getByTestId("ti-branch");
    await branch.click();
    await expect(branch).toHaveAttribute("data-copied", "true");
    expect(await checkColour(branch)).toBe(await slot(page, "--cf-success-text"));
  });
}

test("screenshots: a copy button and the card's branch row at rest and copied; a menu's copy with its toast", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  /** The element's box with some room around it, in both schemes. */
  const shoot = async (name: string, around: Locator, pad = 24) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(150);
      const b = await around.boundingBox();
      if (!b) throw new Error(`no box for ${name}`);
      await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } });
    }
  };
  // Shot within the 1.5 s the check shows: one scheme each pass, a fresh copy before each.
  const shootCopied = async (name: string, press: Locator, around: Locator, pad = 24) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(5, 5);
      await page.waitForTimeout(1600);
      await press.click();
      await page.mouse.move(5, 5);
      await page.waitForTimeout(250);
      const b = await around.boundingBox();
      if (!b) throw new Error(`no box for ${name}`);
      await page.screenshot({ path: `${shots}/${name}-${scheme}.png`, clip: { x: Math.max(0, b.x - pad), y: Math.max(0, b.y - pad), width: b.width + 2 * pad, height: b.height + 2 * pad } });
    }
  };

  // The project page's Details: Copy path, a copy button.
  await openApp(page);
  await openProjectPage(page, "repo-cf");
  const details = page.getByTestId("details-path");
  await shoot("copy-button-rest", details);
  await shootCopied("copy-button-copied", page.getByTestId("details-copy-path"), details);

  // A checkout's context menu: Copy path, then its toast (the menu is gone).
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(`[data-nav-key="pw:repo-cf::${FEAT}"]`).click({ button: "right" });
    await page.getByTestId("checkout-menu-copy-path").click();
    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible();
    await page.waitForTimeout(400);
    const b = await toast.boundingBox();
    if (!b) throw new Error("no toast");
    await page.screenshot({ path: `${shots}/menu-copy-toast-${scheme}.png`, clip: { x: b.x - 24, y: b.y - 24, width: b.width + 48, height: b.height + 48 } });
    await page.evaluate(`__cfModule("/src/lib/notify.ts").then((m) => m.dismissNotice())`);
    await page.waitForTimeout(500);
  }

  // The thread card's branch row (and where its toast was, bottom right).
  await page.emulateMedia({ colorScheme: null });
  await openCard(page);
  const branch = card(page).getByTestId("ti-branch");
  await shoot("branch-row-rest", branch, 16);
  for (const scheme of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1600);
    await branch.click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/branch-row-copied-${scheme}.png` });
    await page.evaluate(`__cfModule("/src/lib/notify.ts").then((m) => m.dismissNotice())`);
  }
});
