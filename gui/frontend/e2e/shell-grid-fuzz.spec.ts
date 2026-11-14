import { expect, test, type Page } from "@playwright/test";
import { appPath, mockUrl, openStreams, resetMock } from "./fixtures";
import { paneNode, rowNode, seedLayout, threadTab, type LayoutNode } from "./shell";

/**
 * A seeded fuzz of the pane grid against the mock (docs/notes/shell-24c-last-pass.md): random tab
 * drags, pane drags, gutter drags, closes, splits, space switches, full screen, new threads' and
 * terminals' tabs and window sizes that fold panes to rails, with the pointer where a user would
 * use it. After every step the panes must tile the grid exactly, no tab id may appear twice and
 * the focused pane must exist; at the end (and every 40 steps) the streams must match what is
 * visible: one WatchThread per thread shown, one Attach per terminal shown, none for hidden tabs,
 * rails or panes behind full screen. FUZZ_SEED=<n>[,<n>…] runs those seeds; FUZZ_STEPS=<n> sets the length.
 * A failure names its seed and step and lists the steps before it.
 */

const SEEDS = process.env.FUZZ_SEED ? process.env.FUZZ_SEED.split(",").map(Number) : [1, 2];
const STEPS = Number(process.env.FUZZ_STEPS ?? 150);
const SIZES = [
  { width: 1400, height: 900 },
  { width: 1100, height: 720 },
  { width: 820, height: 620 },
];

/** mulberry32: a small seeded generator, so a seed replays the same run. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[Math.floor(next() * xs.length)] : undefined),
  };
}
type Rng = ReturnType<typeof rng>;

type Box = { x: number; y: number; w: number; h: number };

async function mockLayout(): Promise<{ rev: number; applied: unknown[]; state: { spaces: { id: string; focus?: string; root: LayoutNode | null }[] } }> {
  const res = await fetch(`${mockUrl}/__mock/layout`);
  return (await res.json()) as never;
}

const frames = (page: Page, n = 2) =>
  page.evaluate(
    (k) =>
      new Promise<void>((resolve) => {
        const step = (left: number) => {
          if (left === 0) resolve();
          else
            requestAnimationFrame(() => {
              step(left - 1);
            });
        };
        step(k);
      }),
    n,
  );

/** Waits until the window holds the mock's rev and nothing more arrives for a round. */
async function settle(page: Page): Promise<void> {
  let last = "";
  for (let i = 0; i < 120; i++) {
    const m = await mockLayout();
    const w = await page.evaluate(() => (window as unknown as { __cfModule: (p: string) => Promise<{ useLayoutStore: { getState: () => { rev: number } } }> }).__cfModule("/src/stores/layout.ts").then((x) => x.useLayoutStore.getState().rev));
    const key = `${String(m.rev)}/${String(m.applied.length)}/${String(w)}`;
    if (m.rev === w && key === last) return;
    last = key;
    await frames(page);
  }
  throw new Error("the layout never settled");
}

/** What the drawn grid breaks, as text; empty when it holds. */
function gridErrors(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    type Store = { getState: () => unknown };
    const mod = (window as unknown as { __cfModule: (p: string) => Promise<{ useLayoutStore: Store; useShellViewStore: Store }> }).__cfModule;
    const L = (await mod("/src/stores/layout.ts")).useLayoutStore.getState() as {
      currentSpaceId: string;
      spaces: Record<string, { focus: string }>;
      trees: Record<string, { t: string; id: string; kids?: unknown[] } | null>;
    };
    const V = (await mod("/src/stores/shellView.ts")).useShellViewStore.getState() as {
      fullscreen: string;
      frame: { w: number; h: number; rects: Record<string, { x: number; y: number; w: number; h: number }>; gutters: { x: number; y: number; w: number; h: number; split: string; i: number }[] } | null;
    };
    const errs: string[] = [];
    const grid = document.querySelector<HTMLElement>('[data-testid="shell-grid"]');
    if (!grid) return ["no grid"];
    const tree = L.trees[L.currentSpaceId] ?? null;
    const ids: string[] = [];
    const walk = (n: { t: string; id: string; kids?: unknown[] } | null) => {
      if (!n) return;
      if (n.t === "pane") ids.push(n.id);
      else for (const k of n.kids ?? []) walk(k as never);
    };
    walk(tree);
    const drawn = [...grid.querySelectorAll<HTMLElement>('[data-testid="shell-pane"], [data-testid="shell-rail"]')];
    const drawnIds = drawn.map((el) => el.dataset.paneId ?? "");
    if (!tree) {
      if (drawn.length > 0) errs.push(`no tree but ${String(drawn.length)} panes drawn`);
      return errs;
    }
    const full = V.fullscreen === L.currentSpaceId;
    const want = full ? [L.spaces[L.currentSpaceId]?.focus ?? ""] : ids;
    if ([...drawnIds].sort().join() !== [...want].sort().join()) errs.push(`drawn panes [${drawnIds.join()}] are not the tree's [${want.join()}]`);
    const f = V.frame;
    if (!f) return [...errs, "no frame"];
    if (Math.abs(f.w - grid.clientWidth) > 1 || Math.abs(f.h - grid.clientHeight) > 1) errs.push(`frame ${String(f.w)}x${String(f.h)} is not the grid's ${String(grid.clientWidth)}x${String(grid.clientHeight)}`);
    // Each drawn pane sits at its frame rectangle.
    for (const el of drawn) {
      const r = f.rects[el.dataset.paneId ?? ""];
      const s = { x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) };
      if (!r || Math.abs(r.x - s.x) > 0.5 || Math.abs(r.y - s.y) > 0.5 || Math.abs(r.w - s.w) > 0.5 || Math.abs(r.h - s.h) > 0.5) errs.push(`pane ${el.dataset.paneId ?? ""} is drawn at ${JSON.stringify(s)}, its frame says ${JSON.stringify(r)}`);
    }
    // Panes and gutters tile the frame: inside it, no overlap, covering it all.
    const all: [string, { x: number; y: number; w: number; h: number }][] = [...Object.entries(f.rects), ...f.gutters.map((g): [string, typeof g] => [`gutter ${g.split}/${String(g.i)}`, g])];
    const eps = 0.01;
    let area = 0;
    for (const [id, r] of all) {
      if (r.w < 0 || r.h < 0 || r.x < -eps || r.y < -eps || r.x + r.w > f.w + eps || r.y + r.h > f.h + eps) errs.push(`${id} ${JSON.stringify(r)} leaves the ${String(f.w)}x${String(f.h)} grid`);
      area += r.w * r.h;
    }
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [ia, a] = all[i] ?? ["", { x: 0, y: 0, w: 0, h: 0 }];
        const [ib, b] = all[j] ?? ["", { x: 0, y: 0, w: 0, h: 0 }];
        if (Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > eps && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > eps) errs.push(`${ia} overlaps ${ib}`);
      }
    }
    if (Math.abs(area - f.w * f.h) > 1) errs.push(`panes and gutters cover ${String(area)} of ${String(f.w * f.h)} px²`);
    // The focused pane exists, and is the one drawn focused.
    const focus = L.spaces[L.currentSpaceId]?.focus ?? "";
    if (!ids.includes(focus)) errs.push(`the focused pane ${focus} is not in the tree`);
    const marked = [...grid.querySelectorAll<HTMLElement>('[data-testid="shell-pane"][data-focused]')].map((el) => el.dataset.paneId);
    if (marked.length > 1 || (marked.length === 1 && marked[0] !== focus)) errs.push(`drawn focused [${marked.join()}], the space's focus ${focus}`);
    // No tab id twice on screen.
    const tabs = [...grid.querySelectorAll<HTMLElement>('[data-testid="shell-tab"], [data-testid="shell-rail-tab"]')].map((el) => el.dataset.tabId ?? "");
    const dup = tabs.filter((t, i) => tabs.indexOf(t) !== i);
    if (dup.length) errs.push(`tabs drawn twice: ${dup.join()}`);
    return errs;
  });
}

/** Tab ids that appear twice in the daemon's (the mock's) layout, across every space. */
async function storedDuplicates(): Promise<string[]> {
  const { state } = await mockLayout();
  const seen = new Set<string>();
  const dup: string[] = [];
  const walk = (n: LayoutNode | null) => {
    if (!n) return;
    if (n.t === "pane") {
      for (const t of n.tabs) {
        const id = String(t.id);
        if (seen.has(id)) dup.push(id);
        seen.add(id);
      }
    } else n.kids.forEach(walk);
  };
  for (const sp of state.spaces) walk(sp.root);
  return dup;
}

/** The streams the visible views should hold against those the mock has open, once they agree. */
async function expectStreams(page: Page): Promise<void> {
  // A neutral spot: no hover card holds a thread's Watch.
  await page.mouse.move(2, 2);
  const want = () =>
    page.evaluate(() => {
      const threads = new Set([...document.querySelectorAll<HTMLElement>('[data-testid="thread-pane"]')].map((el) => el.dataset.threadId));
      const terminals = [...document.querySelectorAll<HTMLElement>('[data-testid="shell-terminal-host"], [data-testid="quick-terminal-host"]')].filter((el) => el.dataset.terminalId).length;
      return { watch: threads.size, attach: terminals };
    });
  const have = async () => {
    const s = await openStreams();
    return { watch: s["ThreadService/WatchThread"] ?? 0, attach: s["TerminalService/Attach"] ?? 0 };
  };
  await expect
    .poll(async () => {
      const w = await want();
      const h = await have();
      return w.watch === h.watch && w.attach === h.attach ? "as shown" : `shown ${JSON.stringify(w)}, open ${JSON.stringify(h)}`;
    })
    .toBe("as shown");
}

/** A pointer drag from one point to another, as a user's: press, a small move to start it, then the way there. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 8, from.y + 4, { steps: 2 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function boxes(page: Page, selector: string): Promise<{ box: Box; id: string }[]> {
  return page.locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { box: { x: r.x, y: r.y, w: r.width, h: r.height }, id: (el as HTMLElement).dataset.tabId ?? (el as HTMLElement).dataset.paneId ?? (el as HTMLElement).dataset.split ?? "" };
    }),
  );
}

/** Where a drag may end: inside a strip, on a pane's edge band, on the grid's outer edge, on a space tab. */
async function dropPoint(page: Page, r: Rng): Promise<{ x: number; y: number; what: string } | null> {
  const kind = r.int(4);
  if (kind === 0) {
    const strip = r.pick(await boxes(page, '[data-testid="shell-tab-strip"]'));
    return strip ? { x: strip.box.x + r.next() * strip.box.w * 0.6, y: strip.box.y + strip.box.h / 2, what: "a strip" } : null;
  }
  if (kind === 1) {
    const pane = r.pick(await boxes(page, '[data-testid="shell-pane"]'));
    if (!pane) return null;
    const b = pane.box;
    const side = r.int(4);
    const at = [
      { x: b.x + b.w * 0.08, y: b.y + b.h * 0.55 },
      { x: b.x + b.w * 0.92, y: b.y + b.h * 0.55 },
      { x: b.x + b.w * 0.5, y: b.y + 40 + (b.h - 40) * 0.1 },
      { x: b.x + b.w * 0.5, y: b.y + b.h * 0.93 },
    ][side];
    return at ? { ...at, what: `${["left", "right", "top", "bottom"][side] ?? ""} edge of ${pane.id}` } : null;
  }
  if (kind === 2) {
    const g = (await boxes(page, '[data-testid="shell-grid"]'))[0];
    if (!g) return null;
    const side = r.int(4);
    const b = g.box;
    const at = [
      { x: b.x + 4, y: b.y + b.h / 2 },
      { x: b.x + b.w - 4, y: b.y + b.h / 2 },
      { x: b.x + b.w / 2, y: b.y + 4 },
      { x: b.x + b.w / 2, y: b.y + b.h - 4 },
    ][side];
    return at ? { ...at, what: `the grid's ${["left", "right", "top", "bottom"][side] ?? ""} edge` } : null;
  }
  const sp = r.pick(await boxes(page, '[data-testid="space-tab"]'));
  return sp ? { x: sp.box.x + sp.box.w / 2, y: sp.box.y + sp.box.h / 2, what: "a space tab" } : null;
}

const run = (page: Page, name: string, args: Record<string, string>) =>
  page.evaluate(([n, a]) => (window as unknown as { __cfModule: (p: string) => Promise<{ runCommandForResult: (n: string, a: Record<string, string>, o: { quiet: boolean }) => Promise<unknown> }> }).__cfModule("/src/stores/commands.ts").then((m) => m.runCommandForResult(n, a, { quiet: true }).then(() => undefined)), [name, args] as const);

/** One random step; what it did, or "" when it found nothing to do. */
async function step(page: Page, r: Rng): Promise<string> {
  const roll = r.int(100);
  if (roll < 24) {
    const tab = r.pick(await boxes(page, '[data-testid="shell-tab"], [data-testid="shell-rail-tab"]'));
    const to = tab ? await dropPoint(page, r) : null;
    if (!tab || !to) return "";
    await drag(page, { x: tab.box.x + tab.box.w / 2, y: tab.box.y + tab.box.h / 2 }, to);
    return `drag tab ${tab.id} to ${to.what}`;
  }
  if (roll < 34) {
    // A pane by its strip's free space: between the "+" and the collapse button (full screen's left neighbour).
    const panes = await page.locator('[data-testid="shell-pane"]').evaluateAll((els) =>
      els.flatMap((el) => {
        const plus = el.querySelector('[aria-label="Open a tab"]')?.getBoundingClientRect();
        const fs = (el.querySelector('[data-testid="shell-collapse"]') ?? el.querySelector('[data-testid="shell-fullscreen"]'))?.getBoundingClientRect();
        if (!plus || !fs || fs.left - plus.right < 16) return [];
        return [{ id: (el as HTMLElement).dataset.paneId ?? "", x: (plus.right + fs.left) / 2, y: plus.top + plus.height / 2 }];
      }),
    );
    const p = r.pick(panes);
    const to = p ? await dropPoint(page, r) : null;
    if (!p || !to) return "";
    await drag(page, p, to);
    return `drag pane ${p.id} to ${to.what}`;
  }
  if (roll < 48) {
    const g = r.pick(await boxes(page, '[data-testid="shell-gutter"]'));
    if (!g) return "";
    const d = (r.next() - 0.5) * 400;
    const row = g.box.h > g.box.w;
    const c = { x: g.box.x + g.box.w / 2, y: g.box.y + g.box.h / 2 };
    await page.mouse.move(c.x, c.y);
    await page.mouse.down();
    await page.mouse.move(row ? c.x + d : c.x, row ? c.y : c.y + d, { steps: 4 });
    await page.mouse.up();
    return `drag gutter ${g.id} by ${String(Math.round(d))}`;
  }
  if (roll < 58) {
    const tab = r.pick(await boxes(page, '[data-testid="shell-tab"]'));
    if (!tab) return "";
    await page.mouse.click(tab.box.x + tab.box.w / 2, tab.box.y + tab.box.h / 2, { button: "middle" });
    return `close tab ${tab.id}`;
  }
  if (roll < 68) {
    // Not a Needs you row: its title opens the popup, a dialog over the grid (shell-needs.spec.ts).
    const rows = await page.locator('[data-testid="thread-list"] [data-row-key^="s:"]:not([data-section="needs"])').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.rowKey ?? ""));
    const key = r.pick(rows);
    if (!key) return "";
    await page.locator(`[data-testid="thread-list"] [data-row-key="${key}"]:not([data-section="needs"])`).first().click({ position: { x: 40, y: 30 } });
    return `open thread ${key}`;
  }
  if (roll < 74) {
    await run(page, "terminal.new-free", {});
    return "new free terminal";
  }
  if (roll < 80) {
    const pane = r.pick(await page.locator('[data-testid="shell-pane"]').evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.paneId ?? "")));
    if (!pane) return "";
    const edge = r.pick(["left", "right", "top", "bottom"]) ?? "right";
    await run(page, "pane.split", { pane, edge });
    return `split ${pane} ${edge}`;
  }
  if (roll < 88) {
    const sp = r.pick(await boxes(page, '[data-testid="space-tab"]'));
    if (!sp) return "";
    await page.mouse.click(sp.box.x + sp.box.w / 2, sp.box.y + sp.box.h / 2);
    return "switch space";
  }
  if (roll < 93) {
    const exit = page.getByTestId("shell-fullscreen-exit");
    if (await exit.count()) {
      await exit.click();
      return "leave full screen";
    }
    const pane = r.pick(await boxes(page, '[data-testid="shell-pane"]'));
    if (!pane) return "";
    await page.locator(`[data-testid="shell-pane"][data-pane-id="${pane.id}"] [data-testid="shell-fullscreen"]`).click();
    return `full screen ${pane.id}`;
  }
  if (roll < 97) {
    const size = r.pick(SIZES) ?? SIZES[0];
    if (size) await page.setViewportSize(size);
    return `window ${String(size?.width)}x${String(size?.height)}`;
  }
  await run(page, "view.pullrequests", {});
  return "the Pull Requests page";
}

for (const seed of SEEDS) {
  test(`the grid holds through ${String(STEPS)} random steps (seed ${String(seed)})`, async ({ page }) => {
    test.setTimeout(120_000);
    await resetMock();
    await seedLayout(rowNode([paneNode("p-1", [threadTab("s-1"), threadTab("s-3")]), paneNode("p-2", [{ id: "t-prs", kind: "prs" }])]), "p-1");
    await page.setViewportSize(SIZES[0] ?? { width: 1400, height: 900 });
    await page.goto(appPath);
    await expect(page.locator('[data-testid="shell"][data-shell-mode="shell"]')).toBeVisible();
    await run(page, "space.new", { name: "Two", focus: "false" });
    const r = rng(seed);
    const log: string[] = [];
    const fail = (i: number, errs: string[]) => {
      throw new Error(`seed ${String(seed)}, step ${String(i)}:\n  ${errs.join("\n  ")}\nsteps before it (FUZZ_SEED=${String(seed)} FUZZ_STEPS=${String(i + 1)} replays them):\n  ${log.slice(-12).join("\n  ")}`);
    };
    for (let i = 0; i < STEPS; i++) {
      const did = await step(page, r);
      log.push(`${String(i)}: ${did || "(nothing to do)"}`);
      await settle(page);
      await frames(page);
      const errs = [...(await gridErrors(page)), ...(await storedDuplicates()).map((id) => `tab ${id} is stored twice`)];
      if (errs.length) fail(i, errs);
      if (i % 40 === 39) {
        try {
          await expectStreams(page);
        } catch (e) {
          fail(i, [`streams: ${e instanceof Error ? e.message : String(e)}`]);
        }
      }
    }
    // FUZZ_LOG=1 prints what the run did, and how many commits it made.
    if (process.env.FUZZ_LOG) console.log(`seed ${String(seed)}: ${String((await mockLayout()).rev)} commits\n${log.join("\n")}`);
    try {
      await expectStreams(page);
    } catch (e) {
      fail(STEPS, [`streams: ${e instanceof Error ? e.message : String(e)}`]);
    }
  });
}
