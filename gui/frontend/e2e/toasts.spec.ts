import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock } from "./fixtures";

/**
 * The toast card's colours per level, in both schemes (docs/notes/toast-levels.md): what only
 * the real theme CSS shows. What notify passes to sonner and what the card holds:
 * src/lib/notify.test.tsx. SHOTS=<dir> saves the cards, dark and light, for the pull request.
 */

test.beforeEach(async () => {
  await resetMock();
});

const LEVELS = ["success", "info", "warning", "error"] as const;

/** Shows a toast through the app's notify (src/lib/notify.ts), by the dev build's module hook. */
async function show(page: Page, calls: string): Promise<void> {
  await page.evaluate(
    (src) => (window.__cfModule?.("/src/lib/notify.ts") as Promise<unknown>).then((m) => new Function("m", src)(m) as unknown),
    calls,
  );
}

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

const card = (page: Page, title: string) => page.locator("[data-sonner-toast]").filter({ has: page.locator("[data-title]", { hasText: title }) });

for (const scheme of ["dark", "light"] as const) {
  test(`${scheme}: a level tints its card and colours its icon and title; buttons stay neutral; progress is plain`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await openApp(page);
    for (const level of LEVELS) {
      await show(page, `m.notify({ level: "${level}", id: "${level}", title: "A ${level}", description: "Why", action: { label: "Open", onClick: () => {} }, duration: 60000 })`);
      const t = card(page, `A ${level}`);
      await expect(t).toBeVisible();
      await expect(t.locator("[data-title]")).toHaveCSS("color", await slot(page, `--cf-${level}-text`));
      await expect(t.locator("[data-icon]")).toHaveCSS("color", await slot(page, `--cf-${level}`));
      await expect(t.locator("[data-description]")).toHaveCSS("color", await slot(page, "--cf-text-secondary"));
      await expect(t.locator("button[data-action]")).toHaveCSS("background-color", await slot(page, "--cf-text"));
      expect(await t.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(await slot(page, "--cf-border"));
      await show(page, `m.dismissNotice("${level}")`);
    }
    await show(page, `m.notifyProgress({ id: "p", title: "Preparing worktree for #63…" })`);
    const p = card(page, "Preparing worktree for #63…");
    await expect(p).toHaveCSS("border-top-color", await slot(page, "--cf-border"));
    await expect(p.locator("[data-title]")).toHaveCSS("color", await slot(page, "--cf-text"));
  });
}

test("screenshots: each level, a description, buttons, a sticky failure and progress", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page);
  const groups = {
    levels: [
      `m.notify({ level: "success", title: "Saved rows.csv", description: "~/wt/fix/out/rows.csv", action: { label: "Open", onClick: () => {} }, cancel: { label: "Show in Finder", onClick: () => {} }, duration: 600000 })`,
      `m.notify({ level: "info", title: "Relaunch requested", description: "Reopen the app to run the installed version.", duration: 600000 })`,
      `m.notify({ level: "warning", title: "Disabled code-review", description: "Threads that are running keep it until they restart. New threads pick this up at once.", duration: 600000 })`,
    ],
    failures: [
      `m.notify({ level: "error", title: "Could not delete scratch-api", description: "remove /Users/dev/projects/scratch-api: directory not empty", duration: 600000 })`,
      `m.notify({ level: "error", title: "Push failed", description: "! [rejected] cf/poller -> cf/poller (fetch first): the remote has commits this branch does not", sticky: true })`,
      `m.notifyProgress({ title: "Preparing worktree for #63…" })`,
    ],
  };
  for (const [name, calls] of Object.entries(groups)) {
    for (const c of calls) await show(page, c);
    const toaster = page.locator("[data-sonner-toaster]");
    await toaster.locator("[data-sonner-toast]").first().hover();
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(500);
      const box = await toaster.boundingBox();
      if (!box) throw new Error("no toaster");
      const top = await page.evaluate(() => Math.min(...[...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.getBoundingClientRect().top)));
      await page.screenshot({ path: `${shots}/toasts-${name}-${scheme}.png`, clip: { x: box.x - 24, y: top - 24, width: box.width + 44, height: box.y + box.height - top + 44 } });
    }
    await page.emulateMedia({ colorScheme: null });
    await show(page, "m.dismissNotice()");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(500);
  }
});
