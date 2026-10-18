import { expect, test, type Page } from "@playwright/test";
import { emit, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * The MCP side panel surface (docs/notes/mcp-panel.md, docs/sketches/mcp-panel variant B)
 * over the mock's scripted thread s-r1, seeded with the sketch's six servers (mock/mcp.ts):
 * t3-code and github connected, linear needing a login, playwright failed, filesystem
 * connecting, sentry disabled. Set SHOTS=<dir> to save screenshots (WebKit, dark and light).
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("mcp-surface");
const card = (page: Page, name: string) => surface(page).locator(`[data-testid="mcp-card"][data-server="${name}"]`);

async function openThread(page: Page): Promise<void> {
  await mockPost("thread?state=idle");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
}

async function expectMcpTab(page: Page): Promise<void> {
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-r1");
  await expect(tabs(page).and(page.locator('[aria-selected="true"]'))).toHaveText("MCP");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "mcp");
}

async function threadCalls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/thread/calls`);
  return (await res.json()) as string[];
}

test.beforeEach(async () => {
  await resetMock();
});

test("the palette opens it: one card per server in every state, the header counts and dates the check", async ({ page }) => {
  await openThread(page);
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show MCP Servers");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="view.panel.mcp"]').click();
  await expect(palette).toHaveCount(0);
  await expectMcpTab(page);

  await expect(surface(page).getByTestId("mcp-count")).toHaveText("2 of 6 connected");
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked \d+s ago, at the start of the last turn$/);
  const cards = surface(page).getByTestId("mcp-card");
  await expect(cards).toHaveCount(6);
  expect(await cards.evaluateAll((els) => els.map((e) => [e.getAttribute("data-server"), e.getAttribute("data-status")]))).toEqual([
    ["t3-code", "connected"],
    ["github", "connected"],
    ["linear", "needs-auth"],
    ["playwright", "failed"],
    ["filesystem", "pending"],
    ["sentry", "disabled"],
  ]);
  await expect(surface(page).getByTestId("mcp-pill")).toHaveText(["Connected", "Connected", "Needs login", "Failed", "Connecting…", "Disabled"]);
  await expect(card(page, "t3-code").getByTestId("mcp-version")).toHaveText("v0.4.2");
  await expect(card(page, "t3-code").getByTestId("mcp-meta")).toHaveText("project·http·5 tools");
  await expect(card(page, "linear").getByTestId("mcp-login-hint")).toHaveText("Needs login · run claude in a shell and use /mcp, then reconnect");
  await expect(card(page, "playwright").getByTestId("mcp-error")).toHaveText("spawn npx ENOENT");
  // Reconnect on all but the connecting and the disabled server; tools only where connected.
  for (const [name, reconnect, tools] of [
    ["t3-code", 1, 1],
    ["github", 1, 1],
    ["linear", 1, 0],
    ["playwright", 1, 0],
    ["filesystem", 0, 0],
    ["sentry", 0, 0],
  ] as const) {
    await expect(card(page, name).getByTestId("mcp-reconnect")).toHaveCount(reconnect);
    await expect(card(page, name).getByTestId("mcp-tools-toggle")).toHaveCount(tools);
  }
});

test("M and the command open it; tools expand with hint icons and their tooltips", async ({ page }) => {
  await openThread(page);
  // M in the panel's surface list (the header's toggle opens the panel and focuses it).
  await page.getByTestId("thread-pane").getByRole("button", { name: "Toggle Side Panel" }).click();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="mcp"]')).toBeVisible();
  await page.keyboard.press("m");
  await expectMcpTab(page);
  await page.keyboard.press("Meta+w");
  await expect(panel(page)).toHaveCount(0);
  // view.panel.mcp from the CLI (a ShowView intent).
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);

  const github = card(page, "github");
  await expect(github.getByTestId("mcp-tools")).toHaveCount(0);
  await github.getByTestId("mcp-tools-toggle").click();
  await expect(github.getByTestId("mcp-tools-toggle")).toHaveAttribute("aria-expanded", "true");
  await expect(github.getByTestId("mcp-tool")).toHaveCount(5);
  const tool = (name: string) => github.locator(`[data-testid="mcp-tool"][data-tool="${name}"]`);
  expect(await tool("merge_pull_request").getByTestId("mcp-hint").evaluateAll((els) => els.map((e) => e.getAttribute("data-hint")))).toEqual(["writes", "destructive", "open-world"]);
  expect(await tool("get_pull_request").getByTestId("mcp-hint").evaluateAll((els) => els.map((e) => e.getAttribute("data-hint")))).toEqual(["read-only"]);

  // The open tooltip (the one before may still be fading out).
  const tip = page.locator('[data-testid="mcp-hint-tooltip"]:not([data-state="closed"])');
  await tool("get_pull_request").locator('[data-hint="read-only"]').hover();
  await expect(tip).toHaveText("Read-only");
  await tool("merge_pull_request").locator('[data-hint="destructive"]').hover();
  await expect(tip).toHaveText("Destructive");
  await tool("merge_pull_request").locator('[data-hint="open-world"]').hover();
  await expect(tip).toHaveText("Open-world (reaches outside the server)");
  await tool("push_files").locator('[data-hint="writes"]').hover();
  await expect(tip).toHaveText("Writes");

  await github.getByTestId("mcp-tools-toggle").click();
  await expect(github.getByTestId("mcp-tools")).toHaveCount(0);
});

test("Reconnect on the failed card: Connecting… with a spinner, then Connected with its tools", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  const pw = card(page, "playwright");
  await expect(pw.getByTestId("mcp-reconnect")).toHaveClass(/border-warning\/40/);
  await pw.getByTestId("mcp-reconnect").click();
  await expect(pw).toHaveAttribute("data-status", "pending");
  await expect(pw.getByTestId("mcp-pill")).toHaveText("Connecting…");
  await expect(pw.getByTestId("mcp-reconnect")).toBeDisabled();
  await expect(pw.getByTestId("mcp-reconnect").locator(".animate-spin")).toHaveCount(1);

  await expect(pw).toHaveAttribute("data-status", "connected");
  await expect(pw.getByTestId("mcp-pill")).toHaveText("Connected");
  await expect(pw.getByTestId("mcp-error")).toHaveCount(0);
  await expect(pw.getByTestId("mcp-version")).toHaveText("v0.0.41");
  await expect(pw.getByTestId("mcp-tools-toggle")).toHaveText("3 tools");
  await expect(surface(page).getByTestId("mcp-count")).toHaveText("3 of 6 connected");
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked (just now|\d+s ago), after reconnecting playwright$/);
  expect(await threadCalls()).toContain("mcp-reconnect s-r1 playwright");

  // A needs-login server stays so: Claude's refusal is toasted.
  await card(page, "linear").getByTestId("mcp-reconnect").click();
  await expect(page.getByText("Could not reconnect linear")).toBeVisible();
  await expect(card(page, "linear")).toHaveAttribute("data-status", "needs-auth");

  // Refresh re-asks (thread.mcp --refresh).
  await surface(page).getByTestId("mcp-refresh").click();
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked (just now|\d+s ago)$/);
  expect(await threadCalls()).toContain("mcp s-r1 refresh");
});

test("a stopped thread keeps its last status; Refresh and Reconnect are enabled and work (the daemon starts Claude)", async ({ page }) => {
  await mockPost("thread?state=stopped");
  await openApp(page);
  await row(page, "s:s-r1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await expect(surface(page)).not.toContainText(/not running|Reconnect it/);
  await expect(surface(page).getByTestId("mcp-count")).toHaveText("2 of 6 connected");
  await expect(surface(page).getByTestId("mcp-refresh")).toBeEnabled();
  const pw = card(page, "playwright");
  await expect(pw.getByTestId("mcp-reconnect")).toBeEnabled();
  await pw.getByTestId("mcp-reconnect").click();
  await expect(pw).toHaveAttribute("data-status", "connected");
  expect(await threadCalls()).toContain("mcp-reconnect s-r1 playwright");
  await surface(page).getByTestId("mcp-refresh").click();
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked (just now|\d+s ago)$/);
  expect(await threadCalls()).toContain("mcp s-r1 refresh");
});

/** The stale state (docs/notes/panel-polish.md): amber header line, muted dashed pills, Refresh as the primary button. */
async function expectStale(page: Page, on: boolean): Promise<void> {
  const header = surface(page).getByTestId("mcp-header");
  if (on) await expect(header).toHaveAttribute("data-stale", "true");
  else await expect(header).not.toHaveAttribute("data-stale");
  const line = surface(page).getByTestId("mcp-checked-line");
  if (on) await expect(line).toHaveClass(/text-warning/);
  else await expect(line).not.toHaveClass(/text-warning/);
  const dashed = await surface(page)
    .getByTestId("mcp-pill")
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).borderStyle === "dashed" && getComputedStyle(e).borderTopWidth !== "0px"));
  expect(dashed).toEqual(Array.from({ length: 6 }, () => on));
  const refresh = surface(page).getByTestId("mcp-refresh");
  if (on) {
    await expect(refresh).toHaveAttribute("data-cta", "");
    await expect(refresh).toHaveText("Refresh");
  } else {
    await expect(refresh).not.toHaveAttribute("data-cta");
    await expect(refresh).toHaveText("");
  }
}

test("a check 10 min old goes stale: amber line, dashed pills, Refresh as the call to action; a refresh clears it", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await expectStale(page, false);
  await mockPost("thread/mcp-age?id=s-r1&ago=720");
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText("Last check 12 min ago · may be out of date");
  await expectStale(page, true);
  await surface(page).getByTestId("mcp-refresh").click();
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked (just now|\d+s ago)$/);
  await expectStale(page, false);
  expect(await threadCalls()).toContain("mcp s-r1 refresh");
});

test("a stopped thread's status is stale at once, however recent the check", async ({ page }) => {
  await mockPost("thread?state=stopped");
  await openApp(page);
  await row(page, "s:s-r1").click();
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Last check (just now|\d+s ago) · may be out of date$/);
  await expectStale(page, true);
});

test("a thread Claude never reported for says so without mentioning running; Refresh checks", async ({ page }) => {
  await mockPost("thread?state=crashed");
  await openApp(page);
  await row(page, "s:s-r1").click();
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await expect(surface(page).getByTestId("mcp-empty")).toHaveText("No MCP status yet. Refresh to check.");
  await surface(page).getByTestId("mcp-refresh").click();
  await expect(surface(page).getByTestId("mcp-count")).toHaveText("2 of 6 connected");
});

test("listed for every thread; hidden for a page: not in the panel's list, not in the palette", async ({ page }) => {
  await openThread(page);
  // A seeded thread lists it too.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty").locator('[data-surface="mcp"]')).toBeVisible();
  // The Projects page does not.
  await page.getByTestId("nav-projects").click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="mcp"]')).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show MCP Servers");
  await expect(page.getByTestId("palette").locator('[data-command="view.panel.mcp"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  // The ShowView from the CLI does nothing there either.
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expect(page.getByTestId("panel-body")).toHaveCount(0);
});

/** Stretches the names in the DOM: long names, versions and tool names truncate, never scroll the panel sideways. */
async function stretchNames(page: Page): Promise<void> {
  await card(page, "github").getByTestId("mcp-tools-toggle").click();
  await expect(card(page, "github").getByTestId("mcp-tool")).toHaveCount(5);
  await page.evaluate(() => {
    const set = (sel: string, text: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      el.textContent = text;
    };
    set('[data-server="t3-code"] [data-testid="mcp-version"]', "v1.2.3-a-prerelease-tag-that-goes-on-and-on-and-on");
    set('[data-server="github"] [data-testid="mcp-name"]', "my-extremely-long-mcp-server-name-that-keeps-going-and-going-forever");
    set('[data-server="github"] [data-testid="mcp-tool"] [data-testid="mcp-tool-name"]', "mcp__some_extremely_long_tool_name_that_never_ends_at_all_ok");
    set('[data-server="linear"] [data-testid="mcp-name"]', "another_very_long_server_name_with_underscores_everywhere_and_more");
    set('[data-server="playwright"] [data-testid="mcp-error"]', "Error: connect ECONNREFUSED https://example.com/a/very/long/path/that/has/no/spaces/in/it/at/all");
  });
}

test("long names truncate: the status pill stays in the card and the panel never scrolls sideways", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await stretchNames(page);
  const body = page.getByTestId("panel-body");
  expect(await body.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  // Each card's row keeps its pill inside the card; the name wins over the version.
  for (const name of ["t3-code", "github", "linear", "playwright"]) {
    const c = card(page, name);
    const overhang = await c.evaluate((e) => {
      const pill = e.querySelector('[data-testid="mcp-pill"]');
      if (!pill) throw new Error("no pill");
      return pill.getBoundingClientRect().right - e.getBoundingClientRect().right;
    });
    expect(overhang).toBeLessThanOrEqual(0);
  }
  const t3 = card(page, "t3-code");
  expect(await t3.getByTestId("mcp-name").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(await t3.getByTestId("mcp-version").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await card(page, "github").getByTestId("mcp-name").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
});

/** SHOTS=<dir>: the notes' screenshots, WebKit, 1440x900, dark and light; SHOTS_LONG=1 stretches the names first. */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openThread(page);
    expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
    await expectMcpTab(page);
    if (process.env.SHOTS_LONG) await stretchNames(page);
    else await card(page, "github").getByTestId("mcp-tools-toggle").click();
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/mcp-${scheme}.png` });
    await panel(page).screenshot({ path: `${String(shots)}/mcp-${scheme}-panel.png` });
    // The stale state (docs/notes/panel-polish.md).
    await mockPost("thread/mcp-age?id=s-r1&ago=720");
    await expectStale(page, true);
    await page.mouse.move(0, 0);
    await panel(page).screenshot({ path: `${String(shots)}/mcp-stale-${scheme}-panel.png` });
  });
}
