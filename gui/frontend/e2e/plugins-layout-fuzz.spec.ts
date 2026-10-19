import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Exploratory layout checks on the mock (WebKit; /tmp/cf-layout-fuzz/gui.md has the
 * findings). Custom views go through the mock's `view:<json>` demo tab and its fuzz controls
 * (`__viewdelay`, `__actdelay`, `__failnext`: mock/plugins.ts fuzzControl). `test.fail()`
 * marks a check that shows a bug today (it passes while the bug is there); the bugs fixed
 * since (docs/notes/plugins-layout-fixes-gui.md) are plain checks now.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);

async function acts(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/plugin/acts`);
  return (await res.json()) as string[];
}

/** Errors the page logged or threw. */
function watchErrors(page: Page): string[] {
  const out: string[] = [];
  page.on("pageerror", (e) => out.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    // The Wails runtime's browser notice and its /wails/custom.js 404 are the mock's normal noise.
    if ((m.type() === "error" || m.type() === "warning") && !/Browser Environment Detected|Failed to load resource/.test(m.text())) out.push(`${m.type()}: ${m.text()}`);
  });
  return out;
}

async function openDemo(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(surface(page)).toHaveAttribute("data-phase", "live");
}

async function control(what: string): Promise<void> {
  await mockPost(`plugin/demotab?tab=${encodeURIComponent(what)}`);
}

async function showView(page: Page, spec: Record<string, unknown>): Promise<void> {
  const before = Number((await surface(page).getAttribute("data-version")) ?? "0");
  await control(`view:${JSON.stringify(spec)}`);
  await expect.poll(async () => Number((await surface(page).getAttribute("data-version")) ?? "0")).toBeGreaterThan(before);
}

/** Drags the panel's edge by dx px (negative: wider). */
async function dragPanel(page: Page, dx: number, steps = 4): Promise<void> {
  const h = await page.getByTestId("panel-resize-handle").boundingBox();
  if (!h) throw new Error("no handle");
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + dx, h.y + h.height / 2, { steps });
  await page.mouse.up();
}

const rows = (n: number, prefix = "r") => Array.from({ length: n }, (_, i) => ({ key: `${prefix}${String(i)}`, title: `Row ${String(i)}` }));

test.beforeEach(async () => {
  await resetMock();
});

test("a long list in a sized pane renders its rows as the pane scrolls (virtualized lists and pane scroll)", async ({ page }) => {
  await openDemo(page);
  await showView(page, { view: { nodes: [{ key: "box", pane: { height: 300, children: [{ key: "lst", list: { rows: rows(80) } }] } }] } });
  const pane = surface(page).locator('[data-testid="plugin-pane"][data-key="box"]');
  await expect(pane.locator('[data-testid="plugin-list"]')).toHaveAttribute("data-virtual", "true");
  await pane.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  // The last rows must be drawn where the pane now shows them.
  await expect(pane.locator('[data-testid="plugin-row"][data-key="r79"]')).toBeVisible({ timeout: 2000 });
});

test("a long list in a wide master-detail's detail renders as the detail side scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await dragPanel(page, -600);
  await showView(page, { view: { nodes: [{ key: "md", masterDetail: { list: { rows: rows(3, "m") }, selected: "m0", detail: [{ key: "dl", list: { rows: rows(80) } }] } }] } });
  const md = surface(page).locator('[data-testid="plugin-master-detail"]');
  await expect(md).toHaveAttribute("data-layout", "wide");
  const detail = md.getByTestId("plugin-md-detail");
  await detail.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(300);
  await expect(detail.locator('[data-testid="plugin-row"][data-key="r79"]')).toBeVisible({ timeout: 2000 });
});

test("a fill pane follows its top when a section above it folds and unfolds", async ({ page }) => {
  await openDemo(page);
  await showView(page, {
    view: {
      nodes: [
        { key: "sec", section: { title: "Above", collapsible: true, children: [{ key: "tall", log: { lines: rows(12).map((r) => ({ text: r.title })), rows: 12 } }] } },
        { key: "fp", pane: { height: "fill", minHeight: 120, children: [{ key: "fp-t", text: { content: "fill" } }] } },
      ],
    },
  });
  const scroll = surface(page).getByTestId("plugin-scroll");
  const pane = surface(page).locator('[data-testid="plugin-pane"][data-key="fp"]');
  const bottomGap = async () => {
    const s = await scroll.boundingBox();
    const p = await pane.boundingBox();
    return s && p ? Math.round(s.y + s.height - (p.y + p.height)) : NaN;
  };
  const initial = await bottomGap();
  await surface(page).getByTestId("plugin-section-toggle").click();
  await page.waitForTimeout(200);
  const folded = await bottomGap();
  test.info().annotations.push({ type: "fill-1", description: `bottom gap: ${String(initial)} px unfolded at mount, ${String(folded)} px after folding the section above` });
  expect(initial).toBe(16);
  expect(folded).toBe(16);
});

test("a group of eight progress bars with noWrap at the panel's default width", async ({ page }) => {
  await openDemo(page);
  await showView(page, { view: { nodes: [{ key: "grp", group: { noWrap: true, items: rows(8, "pg").map((r, i) => ({ key: r.key, progress: { value: i / 8, label: r.title } })) } }] } });
  const grp = surface(page).getByTestId("plugin-group");
  const over = await grp.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  const scroll = await surface(page).getByTestId("plugin-scroll").evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }));
  test.info().annotations.push({ type: "group-1", description: `group ${JSON.stringify(over)}, scroll area ${JSON.stringify(scroll)}` });
  expect(scroll.scroll).toBeLessThanOrEqual(scroll.client);
});

test("a group of eight progress bars wraps one per line at 240 px; between with one item sits at the start", async ({ page }) => {
  await openDemo(page);
  await showView(page, {
    view: {
      nodes: [
        { key: "narrow", container: { width: "narrow", children: [{ key: "grp", group: { items: rows(8, "pg").map((r, i) => ({ key: r.key, progress: { value: i / 8 } })) } }] } },
        { key: "one", group: { align: "between", items: [{ key: "solo", text: { content: "alone" } }] } },
      ],
    },
  });
  // Each bar keeps its 160 px basis; they wrap (two a line in the panel's ~328 px) and nothing overflows.
  const items = surface(page).locator('[data-testid="plugin-group"][data-key="grp"] [data-testid="plugin-group-item"]');
  for (const b of await items.all()) expect((await b.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(160);
  expect(await surface(page).getByTestId("plugin-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  const one = await surface(page).locator('[data-testid="plugin-group"][data-key="one"]').boundingBox();
  const solo = await surface(page).locator('[data-testid="plugin-group-item"][data-key="solo"]').boundingBox();
  expect(one && solo && Math.abs(solo.x - one.x) < 1).toBe(true);
});

test("a flex spacer in a strip with a form: what follows sits at the row's end, the form keeps the free width", async ({ page }) => {
  await openDemo(page);
  await showView(page, {
    view: {
      nodes: [{ key: "body", text: { content: "body" } }],
      footer: [
        { key: "ff", form: { fields: [{ key: "ff-q", name: "q", label: "Q", input: { placeholder: "Q" } }], submit: { key: "ff-go", label: "Go", action: { event: "go" } } } },
        { key: "sp", spacer: { flex: true } },
        { key: "bar", actions: { buttons: [{ key: "b1", label: "Run", action: { event: "run" } }] } },
      ],
    },
  });
  const item = (k: string) => surface(page).locator(`[data-testid="plugin-strip-item"][data-key="${k}"]`).boundingBox();
  const [f, s, b] = await Promise.all([item("ff"), item("sp"), item("bar")]);
  const foot = await surface(page).getByTestId("plugin-footer").boundingBox();
  test.info().annotations.push({ type: "strip-flex", description: `form ${String(f?.width)} px, spacer ${String(s?.width)} px, bar ${String(b?.width)} px, footer ${String(foot?.width)} px` });
  expect(b && foot && Math.abs(b.x + b.width - (foot.x + foot.width - 16)) < 2).toBe(true);
  // strip-flex: the spacer beside a form keeps about its size; the form has the free width.
  expect(s && s.width < 20, `spacer ${String(s?.width)} px`).toBe(true);
});

test("a tabs node with eight long titles at the panel's width scrolls its strip, not the surface", async ({ page }) => {
  test.fail(!process.env.FUZZ_NOFAIL, "BUG tabs-3: the active last tab is cut by the prev chevron that appears after it was scrolled into view");
  await openDemo(page);
  const items = Array.from({ length: 8 }, (_, i) => ({ key: `t${String(i)}`, label: `A long tab title ${String(i)}` }));
  await showView(page, { view: { nodes: [{ key: "tn", tabs: { items, active: "t7", children: [{ key: "c7", text: { content: "seven" } }] } }] } });
  const strip = surface(page).getByTestId("plugin-node-tabs");
  await expect(strip).toHaveAttribute("data-overflow-start", "true");
  const scroll = await surface(page).getByTestId("plugin-scroll").evaluate((el) => el.scrollWidth <= el.clientWidth);
  expect(scroll).toBe(true);
  // The active (last) tab was scrolled into view.
  const active = await surface(page).locator('[data-testid="plugin-node-tab"][data-key="t7"]').boundingBox();
  const list = await strip.getByRole("tablist").boundingBox();
  const geom = await strip.getByRole("tablist").evaluate((el) => ({ scrollLeft: el.scrollLeft, max: el.scrollWidth - el.clientWidth }));
  test.info().annotations.push({ type: "tabs-3", description: `active ${JSON.stringify(active)} tablist ${JSON.stringify(list)} ${JSON.stringify(geom)}` });
  // BUG tabs-3 (reported, soft so the rest runs): the prev chevron appears after the active tab was scrolled into view and cuts it.
  expect.soft(active && list && active.x + active.width <= list.x + list.width + 1, "BUG tabs-3: the active tab is cut at the strip's end").toBe(true);
  // Switch to the first while acts take 300 ms: it reads as active meanwhile; the act names the node.
  await control("__actdelay:300");
  await surface(page).getByTestId("plugin-node-tabs-prev").click();
  await surface(page).locator('[data-testid="plugin-node-tab"][data-key="t0"]').click();
  await expect(surface(page).locator('[data-testid="plugin-node-tab"][data-key="t0"]')).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("plugin-tabs-node")).toHaveAttribute("data-active", "t0");
  expect((await acts()).some((a) => a.includes(" t0 "))).toBe(true);
});

test("runs: select and Back thrash with slow acts and coalesced views ends consistent, nothing stuck pending", async ({ page }) => {
  const errors = watchErrors(page);
  await openDemo(page);
  await tab(page, "run-list").click();
  await expect(tab(page, "run-list")).toHaveAttribute("aria-selected", "true");
  await control("__actdelay:120");
  await control("__viewdelay:100");
  const md = surface(page).locator('[data-testid="plugin-master-detail"][data-key="runs-md"]');
  const runRow = (n: number) => md.locator(`[data-testid="plugin-row"][data-key="runs-run-${String(n)}"]`);
  const seen = new Set<string>();
  const observe = async () => {
    seen.add((await md.getAttribute("data-showing")) ?? "");
  };
  for (const n of [5, 3, 1, 4]) {
    await runRow(n).click();
    await observe();
    await md.getByTestId("plugin-md-back").click();
  }
  await runRow(2).click();
  // Sample the narrow state while the act and the coalesced view land.
  const trail: string[] = [];
  for (let i = 0; i < 30; i++) {
    trail.push(`${(await md.getAttribute("data-showing")) ?? ""}:${(await md.getAttribute("data-selected")) ?? ""}`);
    await page.waitForTimeout(10);
  }
  test.info().annotations.push({ type: "md-trail", description: trail.join(" ") });
  await expect(md).toHaveAttribute("data-selected", "runs-run-2");
  await expect(md).toHaveAttribute("data-showing", "detail");
  await expect(md.locator('[data-testid="plugin-md-content"][data-pending]')).toHaveCount(0);
  expect(errors).toEqual([]);
  // The flash: after the act answered and before the view came, the old selection (or the list) showed again.
  expect(trail.filter((t) => t !== "detail:runs-run-2"), `md-3 flash: ${trail.join(" ")}`).toEqual([]);
});

test("runs: a refused choice after a later one leaves the later one's detail", async ({ page }) => {
  await openDemo(page);
  await tab(page, "run-list").click();
  await expect(tab(page, "run-list")).toHaveAttribute("aria-selected", "true");
  const md = surface(page).locator('[data-testid="plugin-master-detail"][data-key="runs-md"]');
  const runRow = (n: number) => md.locator(`[data-testid="plugin-row"][data-key="runs-run-${String(n)}"]`);
  await control("__actdelay:600");
  await control("__failnext:runs-run-5");
  await runRow(5).click(); // refused after 600 ms
  await md.getByTestId("plugin-md-back").click();
  await page.waitForTimeout(200);
  await runRow(3).click(); // answered 600 ms later, 200 ms after the refusal
  await page.waitForTimeout(450);
  await expect(md).toHaveAttribute("data-showing", "detail");
});

test("tab switching mid-act and resize thrash end on the plugin's tab with its drafts", async ({ page }) => {
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await tab(page, "layout").click();
  await expect(tab(page, "layout")).toHaveAttribute("aria-selected", "true");
  const search = surface(page).getByTestId("plugin-toolbar").getByTestId("plugin-input");
  await search.fill("draft-on-layout");
  await control("__actdelay:250");
  await tab(page, "run-list").click();
  await tab(page, "overview").click();
  await tab(page, "layout").click();
  for (let i = 0; i < 8; i++) await dragPanel(page, i % 2 === 0 ? -500 : 500, 2);
  await expect.poll(async () => (await acts()).filter((a) => / (run-list|overview|layout) /.test(a)).length).toBeGreaterThanOrEqual(3);
  await page.waitForTimeout(400);
  await expect(tab(page, "layout")).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("plugin-toolbar").getByTestId("plugin-input")).toHaveValue("draft-on-layout");
  // Columns and grid follow the final width.
  const cols = surface(page).locator('[data-testid="plugin-columns"][data-key="layout-cols"]');
  const w = Number(await cols.getAttribute("data-width"));
  await expect(cols).toHaveAttribute("data-layout", w >= 492 ? "row" : "stack");
  expect(errors).toEqual([]);
});

test("the strips never paint over the scrolled body (z-order)", async ({ page }) => {
  await openDemo(page);
  await tab(page, "layout").click();
  const scroll = surface(page).getByTestId("plugin-scroll");
  for (const top of [0, 150, 400, 10_000]) {
    await scroll.evaluate((el, t) => {
      el.scrollTop = t;
    }, top);
    for (const id of ["plugin-toolbar", "plugin-footer"]) {
      const b = await surface(page).getByTestId(id).boundingBox();
      if (!b) throw new Error(`no ${id}`);
      const hit = await page.evaluate(([x, y, tid]) => document.elementFromPoint(x, y)?.closest(`[data-testid="${tid}"]`) !== null, [b.x + 4, b.y + b.height / 2, id] as const);
      expect(hit, `${id} at scrollTop ${String(top)}`).toBe(true);
    }
  }
});

test("Back from a row far down a narrow list scrolls the body to that row", async ({ page }) => {
  await openDemo(page);
  await showView(page, { view: { nodes: [{ key: "md", masterDetail: { list: { rows: rows(30) }, selected: "", detail: [] } }] } });
  const md = surface(page).locator('[data-testid="plugin-master-detail"]');
  const scroll = surface(page).getByTestId("plugin-scroll");
  await md.locator('[data-testid="plugin-row"][data-key="r25"]').scrollIntoViewIfNeeded();
  await md.locator('[data-testid="plugin-row"][data-key="r25"]').click();
  await expect(md).toHaveAttribute("data-showing", "detail");
  const detailTop = await scroll.evaluate((el) => el.scrollTop);
  await md.getByTestId("plugin-md-back").click();
  await expect(md).toHaveAttribute("data-showing", "list");
  const r = md.locator('[data-testid="plugin-row"][data-key="r25"]');
  await expect(r).toBeFocused();
  await expect(r).toBeInViewport();
  test.info().annotations.push({ type: "scroll", description: `scrollTop on the detail ${String(detailTop)}, after Back ${String(await scroll.evaluate((el) => el.scrollTop))}` });
});

test("a fill pane in the second of stacked columns follows its top when the columns go side by side", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openDemo(page);
  await showView(page, {
    view: {
      nodes: [
        {
          key: "cols",
          columns: {
            items: [
              { key: "c1", children: [{ key: "c1-log", log: { lines: rows(10).map((r) => ({ text: r.title })), rows: 10 } }] },
              { key: "c2", children: [{ key: "fp", pane: { height: "fill", minHeight: 120, children: [{ key: "fp-t", text: { content: "fill" } }] } }] },
            ],
          },
        },
      ],
    },
  });
  const cols = surface(page).locator('[data-testid="plugin-columns"][data-key="cols"]');
  const scroll = surface(page).getByTestId("plugin-scroll");
  const pane = surface(page).locator('[data-testid="plugin-pane"][data-key="fp"]');
  const gap = async () => {
    const s = await scroll.boundingBox();
    const p = await pane.boundingBox();
    return s && p ? Math.round(s.y + s.height - (p.y + p.height)) : NaN;
  };
  await expect(cols).toHaveAttribute("data-layout", "stack");
  const stacked = await gap();
  await dragPanel(page, -500);
  await expect(cols).toHaveAttribute("data-layout", "row");
  await page.waitForTimeout(200);
  const row = await gap();
  test.info().annotations.push({ type: "fill-3", description: `gap under the fill pane: stacked ${String(stacked)} px, side by side ${String(row)} px` });
  expect(row).toBe(16);
});

test("Back from a row far down a long (virtualized) list focuses that row; the focus is not paid later to a row the plugin selects", async ({ page }) => {
  await openDemo(page);
  const spec = (sel: string) => ({
    view: {
      toolbar: [{ key: "search", form: { fields: [{ key: "q", name: "q", label: "Filter", input: { placeholder: "Filter" } }] } }],
      nodes: [{ key: "md", masterDetail: { list: { rows: rows(60) }, selected: sel, detail: [{ key: `d-${sel}`, text: { content: `detail ${sel}` } }] } }],
    },
  });
  await showView(page, spec(""));
  const md = surface(page).locator('[data-testid="plugin-master-detail"]');
  await expect(md.locator('[data-testid="plugin-list"]')).toHaveAttribute("data-virtual", "true");
  const r55 = md.locator('[data-testid="plugin-row"][data-key="r55"]');
  const scroll = surface(page).getByTestId("plugin-scroll");
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await r55.click();
  await expect(md).toHaveAttribute("data-showing", "detail");
  await expect(md).toHaveAttribute("data-selected", "r55");
  await md.getByTestId("plugin-md-back").click();
  await expect(md).toHaveAttribute("data-showing", "list");
  const drawn = await r55.count();
  const back = { drawn, focused: drawn > 0 && (await r55.evaluate((el) => el === document.activeElement)), active: await page.evaluate(() => document.activeElement?.tagName ?? ""), scrollTop: await scroll.evaluate((el) => el.scrollTop) };
  test.info().annotations.push({ type: "md-4", description: JSON.stringify(back) });
  // The user types in the toolbar; then the plugin selects a row near the top by itself.
  const input = surface(page).getByTestId("plugin-toolbar").getByTestId("plugin-input");
  await input.click();
  await input.pressSequentially("ab");
  await showView(page, spec("r1"));
  await page.waitForTimeout(200);
  const stolen = await input.evaluate((el) => el !== document.activeElement);
  const now = await page.evaluate(() => `${document.activeElement?.getAttribute("data-testid") ?? ""}[${document.activeElement?.getAttribute("data-key") ?? ""}]`);
  test.info().annotations.push({ type: "md-6", description: `focus left the search field: ${String(stolen)}, now on ${now}` });
  expect(stolen, "md-6: the owed focus must not jump to the row the plugin selects").toBe(false);
  expect(back.focused, "md-4: Back focuses the chosen row").toBe(true);
});

test("two flex spacers in one fill pane share its free height; a flex spacer in a strip without a form takes the free width", async ({ page }) => {
  await openDemo(page);
  await showView(page, {
    view: {
      nodes: [
        {
          key: "box",
          pane: {
            height: 400,
            children: [
              { key: "a", text: { content: "a" } },
              { key: "s1", spacer: { flex: true } },
              { key: "b", text: { content: "b" } },
              { key: "s2", spacer: { flex: true } },
              { key: "c", text: { content: "c" } },
            ],
          },
        },
      ],
      toolbar: [
        { key: "tt", text: { content: "3 runs" } },
        { key: "tsp", spacer: { flex: true } },
        { key: "tbar", actions: { buttons: [{ key: "tb1", label: "Run", action: { event: "run" } }] } },
      ],
    },
  });
  const h = async (k: string) => (await surface(page).locator(`[data-testid="plugin-spacer"][data-key="${k}"]`).boundingBox())?.height ?? 0;
  const [h1, h2] = [await h("s1"), await h("s2")];
  expect(h1).toBeGreaterThan(100);
  expect(Math.abs(h1 - h2)).toBeLessThan(2);
  const c = await surface(page).locator('[data-testid="plugin-text"]').filter({ hasText: /^c$/ }).boundingBox();
  const box = await surface(page).locator('[data-testid="plugin-pane"][data-key="box"]').boundingBox();
  expect(c && box && Math.abs(c.y + c.height - (box.y + box.height)) < 2).toBe(true);
  const bar = await surface(page).locator('[data-testid="plugin-strip-item"][data-key="tbar"]').boundingBox();
  const tb = await surface(page).getByTestId("plugin-toolbar").boundingBox();
  expect(bar && tb && Math.abs(bar.x + bar.width - (tb.x + tb.width - 16)) < 2).toBe(true);
});
