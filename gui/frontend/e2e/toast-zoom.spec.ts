import { expect, test, type Page } from "@playwright/test";
import { openApp, resetMock, setZoom } from "./fixtures";

/**
 * Toasts under page zoom (CSS zoom on <html>, lib/zoom.ts). sonner measures each card with
 * getBoundingClientRect (viewport px) and its stylesheet uses the numbers as lengths inside
 * the zoomed page, so without the rules in index.css a hovered (expanded) card was pinned to
 * zoom × its height and the stack's offsets were scaled too. docs/notes/toast-zoom.md.
 * Geometry only; what the card holds is src/lib/notify.test.tsx.
 */

test.beforeEach(async () => {
  await resetMock();
});

/** Shows toasts through the app's notify (src/lib/notify.ts), by the dev build's module hook. */
async function show(page: Page, calls: string): Promise<void> {
  await page.evaluate(`__cfModule("/src/lib/notify.ts").then((m) => { ${calls}; })`);
}

const LONG = "A description long enough to wrap onto three lines of the card, so its height is well above a one-line toast and any zoom factor applied to it shows.";

/** Three toasts, oldest first: the front one has a long description and two buttons. */
async function showStack(page: Page): Promise<void> {
  await show(page, `m.notify({ level: "info", title: "Oldest", description: "${LONG}", duration: 600000 })`);
  await show(page, `m.notify({ level: "warning", title: "Middle", duration: 600000 })`);
  await show(page, `m.notify({ level: "success", title: "Front", description: "${LONG}", action: { label: "Open", onClick: () => {} }, cancel: { label: "Show in Finder", onClick: () => {} }, duration: 600000 })`);
  await expect(page.locator("[data-sonner-toast][data-mounted='true']")).toHaveCount(3);
}

type Box = { top: number; bottom: number; left: number; height: number };
type Card = { title: string; front: boolean; rect: Box; layoutHeight: number; measured: number; buttons: Box[] };

/** Every card, top to bottom, with its buttons relative to the card's top-left corner (viewport px). */
function cards(page: Page): Promise<Card[]> {
  return page.evaluate(() => {
    const box = (r: DOMRect, o?: DOMRect): Box => ({ top: r.top - (o?.top ?? 0), bottom: r.bottom - (o?.top ?? 0), left: r.left - (o?.left ?? 0), height: r.height });
    return [...document.querySelectorAll<HTMLElement>("[data-sonner-toast]")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          title: el.querySelector("[data-title]")?.textContent ?? "",
          front: el.dataset.front === "true",
          rect: box(r),
          layoutHeight: el.offsetHeight,
          // sonner's own measurement at height: auto, in viewport px: the card's natural height.
          measured: parseFloat(el.style.getPropertyValue("--initial-height")),
          buttons: [...el.querySelectorAll("button[data-button]")].map((b) => box(b.getBoundingClientRect(), r)),
        };
      })
      .sort((a, b) => a.rect.top - b.rect.top);
  });
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

// 90% is the bottom of the zoom ladder (stores/ui.ts ZOOM_LEVELS); at 100% sonner's numbers
// were already right.
for (const zoom of [90, 125]) {
  test(`at ${String(zoom)}% hovering a toast stack changes nothing inside a card and spaces it like 100%`, async ({ page }) => {
    const f = zoom / 100;
    await page.setViewportSize({ width: 1280, height: 900 });
    await openApp(page);
    await setZoom(page, zoom);
    await showStack(page);

    // At rest: the front card at its natural height; the collapsed ones behind it as tall as it.
    let rest: Card | undefined;
    await expect
      .poll(async () => {
        const all = await cards(page);
        rest = all.find((c) => c.front);
        if (!rest) return "no front";
        return all.every((c) => near(c.layoutHeight * f, rest?.rect.height ?? 0)) && near(rest.rect.height, rest.measured, 0.5);
      })
      .toBe(true);
    const front = rest as Card;
    expect(front.buttons).toHaveLength(2);

    // Hovered: every card at its natural height, the front one exactly as at rest, 14px gaps.
    await page.locator("[data-sonner-toast][data-front='true']").hover();
    await expect(page.locator("[data-sonner-toast][data-expanded='true']")).toHaveCount(3);
    await expect
      .poll(async () => {
        const all = await cards(page);
        const hovered = all.find((c) => c.front);
        const gaps = all.slice(1).map((c, i) => c.rect.top - (all[i]?.rect.bottom ?? 0));
        return {
          heights: all.every((c) => near(c.rect.height, c.measured, 0.5)),
          front: near(hovered?.rect.height ?? 0, front.rect.height, 0.5),
          buttons: hovered?.buttons.every((b, i) => near(b.top, front.buttons[i]?.top ?? -1, 0.5) && near(b.left, front.buttons[i]?.left ?? -1, 0.5)),
          inside: all.every((c) => c.buttons.every((b) => b.bottom <= c.rect.height)),
          // sonner's default gap (14 layout px), zoomed like the page around it.
          gaps: gaps.length === 2 && gaps.every((g) => near(g, 14 * f)),
        };
      })
      .toEqual({ heights: true, front: true, buttons: true, inside: true, gaps: true });
  });
}

test("screenshots: a hovered stack at 90% and 125%, dark and light", async ({ page }) => {
  test.skip(!process.env.SHOTS, "SHOTS=<dir> only");
  const shots = process.env.SHOTS ?? "";
  await page.setViewportSize({ width: 1280, height: 900 });
  await openApp(page);
  for (const zoom of [90, 125]) {
    await setZoom(page, zoom);
    await showStack(page);
    const toaster = page.locator("[data-sonner-toaster]");
    await page.locator("[data-sonner-toast][data-front='true']").hover();
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(600);
      const box = await toaster.boundingBox();
      if (!box) throw new Error("no toaster");
      const top = await page.evaluate(() => Math.min(...[...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.getBoundingClientRect().top)));
      await page.screenshot({ path: `${shots}/toast-zoom-${String(zoom)}-${scheme}.png`, clip: { x: box.x - 24, y: top - 24, width: box.width + 44, height: box.y + box.height - top + 44 } });
    }
    await page.emulateMedia({ colorScheme: null });
    await show(page, "m.dismissNotice()");
    await page.mouse.move(10, 10);
    await page.waitForTimeout(600);
  }
});
