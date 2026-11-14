import { expect, test, type Page } from "@playwright/test";
import { infoCardOff, mockPost, openApp, resetMock, row, writes } from "./fixtures";
import { attachStreams, keyboardIn, terminalTabs } from "./shell-terminals";

/**
 * Servers roll up to the parent thread (docs/notes/server-rollup.md), what only a browser
 * shows: a child's terminal attaching in its tab with the keyboard in it, one Attach stream
 * however often the row shows it, and the hover buttons' place on the row. Which rows, their
 * words and what each press runs: src/components/threadinfo/ShellsGroup.test.tsx.
 */

const card = (page: Page) => page.getByTestId("thread-info-card");
const server = (page: Page, port: number) => card(page).locator(`[data-testid="ti-server"][data-port="${String(port)}"]`);
const host = (page: Page) => page.getByTestId("shell-terminal-host");
const tabs = (page: Page) => terminalTabs(page);
const pane = (page: Page) => page.getByTestId("thread-pane");
const keyboardInTerminal = (page: Page) => keyboardIn(page, "shell-terminal-host");

async function openParent(page: Page): Promise<string> {
  const { id } = (await mockPost("thread-info?scenario=child-server")) as { id: string };
  await openApp(page);
  await row(page, `s:${id}`).click();
  await expect(pane(page)).toHaveAttribute("data-thread-id", id);
  await page.getByTestId("thread-info-toggle").click();
  await expect(server(page, 5173)).toBeVisible();
  return id;
}

test.use({ viewport: { width: 1500, height: 900 } });

test.beforeEach(async () => {
  await resetMock();
  // The card off for threads never toggled (on by default), so its toggle shows it.
  await infoCardOff();
});

test("a child's terminal opens in a tab with the keyboard in it, on one Attach stream", async ({ page }) => {
  await openParent(page);
  expect(await attachStreams()).toBe(0);
  await server(page, 5173).click();
  // Its tab (the child's terminal, placed by the rules: the child's thread is not open, so the focused pane), live, with the keyboard.
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  // Its name is what runs in it (lib/terminalName.test.ts).
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(() => keyboardInTerminal(page)).toBe(true);
  await expect.poll(attachStreams).toBe(1);
  const id = (await host(page).getAttribute("data-terminal-id")) ?? "";

  await page.keyboard.type("q");
  await expect.poll(async () => (await writes()).some((w) => w.id === id && w.data.includes("q"))).toBe(true);

  // Back on the parent, the row again: the same tab is shown (one tab per terminal), still one stream.
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').first().click();
  await expect(server(page, 5173)).toBeVisible();
  await expect.poll(attachStreams).toBe(0);
  await server(page, 5173).click();
  await expect(host(page)).toHaveAttribute("data-terminal-id", id);
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect(tabs(page)).toHaveCount(1);
  await expect.poll(attachStreams).toBe(1);
});

test("a second press on the row shows the child's terminal tab again with the keyboard in it", async ({ page }) => {
  await openParent(page);
  await server(page, 5173).click();
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').first().click();
  await expect(server(page, 5173)).toBeVisible();
  await server(page, 5173).click();
  await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
  await expect.poll(() => keyboardInTerminal(page)).toBe(true);
});

test("the row's buttons show on hover, over the row's end, and line 2 stops short of them", async ({ page }) => {
  await openParent(page);
  const open = server(page, 9399).locator("xpath=..").getByTestId("ti-server-open");
  const stop = server(page, 9399).locator("xpath=..").getByTestId("ti-server-stop");
  const shown = () => open.evaluate((el) => getComputedStyle(el.parentElement as Element).opacity);
  await page.mouse.move(600, 300);
  await expect.poll(shown).toBe("0");
  await server(page, 9399).hover();
  await expect.poll(shown).toBe("1");
  const line = await server(page, 9399).getByTestId("ti-server-line").boundingBox();
  const o = await open.boundingBox();
  const s = await stop.boundingBox();
  const r = await server(page, 9399).boundingBox();
  if (!line || !o || !s || !r) throw new Error("no box");
  expect(line.x + line.width).toBeLessThanOrEqual(o.x);
  expect(o.x + o.width).toBeLessThanOrEqual(s.x);
  expect(s.x + s.width).toBeLessThanOrEqual(r.x + r.width);

  // The keyboard shows them too, with the pointer elsewhere, and Tab reaches both (WebKit leaves plain buttons out by default).
  await page.mouse.move(600, 300);
  await expect.poll(shown).toBe("0");
  await open.focus();
  await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
  await expect.poll(shown).toBe("1");
});

/** SHOTS=<dir>: the PR's screenshots, WebKit at 2x, dark and light. */
for (const scheme of ["dark", "light"] as const) {
  test.describe(`screenshots (${scheme})`, () => {
    test.use({ colorScheme: scheme, deviceScaleFactor: 2 });
    test("the rolled-up rows, a hovered row, its terminal in a tab", async ({ page }, info) => {
      const shots = process.env.SHOTS;
      test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
      const dir = String(shots);
      await openParent(page);
      await server(page, 5173).hover();
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${dir}/rollup-hover-${scheme}.png` });
      await server(page, 5173).click();
      await expect(host(page)).toHaveAttribute("data-attach-phase", "live");
      await page.mouse.move(600, 300);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${dir}/rollup-terminal-${scheme}.png` });
    });
  });
}
