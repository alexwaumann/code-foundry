import { expect, test, type Page } from "@playwright/test";
import { emit, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * The MCP side panel surface (docs/notes/mcp-panel.md, docs/sketches/mcp-panel variant B)
 * over the mock's scripted thread s-r1, seeded with the sketch's six servers (mock/mcp.ts):
 * t3-code and github connected, linear needing a login, playwright failed, filesystem
 * connecting, sentry disabled, under the Connected / Failed / Disabled tabs
 * (docs/notes/mcp-panel-tabs.md). Set SHOTS=<dir> to save screenshots (WebKit, dark and light).
 */

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const surface = (page: Page) => page.getByTestId("mcp-surface");
const card = (page: Page, name: string) => surface(page).locator(`[data-testid="mcp-card"][data-server="${name}"]`);
const mcpTab = (page: Page, bucket: string) => surface(page).locator(`[data-testid="mcp-tab"][data-bucket="${bucket}"]`);

/** The tabs as shown: label + count, which one is selected, and the shown cards' servers. */
async function expectTabs(page: Page, counts: [number, number, number], active: "connected" | "failed" | "disabled", servers: string[]): Promise<void> {
  await expect(surface(page).getByTestId("mcp-tab")).toHaveText([`Connected${String(counts[0])}`, `Failed${String(counts[1])}`, `Disabled${String(counts[2])}`]);
  await expect(mcpTab(page, active)).toHaveAttribute("aria-selected", "true");
  await expect(surface(page).getByTestId("mcp-card")).toHaveCount(servers.length);
  if (servers.length > 0) expect(await surface(page).getByTestId("mcp-card").evaluateAll((els) => els.map((e) => e.getAttribute("data-server")))).toEqual(servers);
}

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

  await expect(surface(page).getByTestId("mcp-count")).toHaveCount(0);
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked \d+s ago, at the start of the last turn$/);
  // Connected first; connecting counts as connected, needs login as failed.
  await expectTabs(page, [3, 2, 1], "connected", ["t3-code", "github", "filesystem"]);
  await expect(mcpTab(page, "failed").getByTestId("mcp-tab-count")).toHaveClass(/text-cf-error-text/);
  await expect(mcpTab(page, "connected").getByTestId("mcp-tab-count")).toHaveClass(/text-cf-text-muted/);
  await expect(surface(page).getByTestId("mcp-pill")).toHaveText(["Connected", "Connected", "Connecting…"]);
  await expect(card(page, "t3-code").getByTestId("mcp-version")).toHaveText("v0.4.2");
  await expect(card(page, "t3-code").getByTestId("mcp-meta")).toHaveText("project·http·5 tools");

  await mcpTab(page, "failed").click();
  await expectTabs(page, [3, 2, 1], "failed", ["linear", "playwright"]);
  await expect(surface(page).getByTestId("mcp-pill")).toHaveText(["Needs login", "Failed"]);
  await expect(card(page, "linear").getByTestId("mcp-login-hint")).toHaveText("Needs login · run claude in a shell and use /mcp, then reconnect");
  await expect(card(page, "playwright").getByTestId("mcp-error")).toHaveText("spawn npx ENOENT");

  await mcpTab(page, "disabled").click();
  await expectTabs(page, [3, 2, 1], "disabled", ["sentry"]);
  await expect(surface(page).getByTestId("mcp-pill")).toHaveText(["Disabled"]);

  // Reconnect on all but the connecting and the disabled server; tools only where connected.
  for (const [bucket, name, reconnect, tools] of [
    ["connected", "t3-code", 1, 1],
    ["connected", "github", 1, 1],
    ["failed", "linear", 1, 0],
    ["failed", "playwright", 1, 0],
    ["connected", "filesystem", 0, 0],
    ["disabled", "sentry", 0, 0],
  ] as const) {
    await mcpTab(page, bucket).click();
    await expect(card(page, name).getByTestId("mcp-reconnect")).toHaveCount(reconnect);
    await expect(card(page, name).getByTestId("mcp-tools-toggle")).toHaveCount(tools);
  }
});

test("each tab says when it is empty", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await mockPost("thread/mcp-servers?id=s-r1&keep=t3-code,github");
  await expectTabs(page, [2, 0, 0], "connected", ["t3-code", "github"]);
  await expect(surface(page).getByTestId("mcp-tab-empty")).toHaveCount(0);
  await expect(mcpTab(page, "failed").getByTestId("mcp-tab-count")).toHaveClass(/text-cf-text-muted/);
  await mcpTab(page, "failed").click();
  await expectTabs(page, [2, 0, 0], "failed", []);
  await expect(surface(page).getByTestId("mcp-tab-empty")).toHaveText("No failed servers. Nothing needs a login.");
  await mcpTab(page, "disabled").click();
  await expect(surface(page).getByTestId("mcp-tab-empty")).toHaveText("No disabled servers.");
  await mockPost("thread/mcp-servers?id=s-r1&keep=sentry");
  await mcpTab(page, "connected").click();
  await expectTabs(page, [0, 0, 1], "connected", []);
  await expect(surface(page).getByTestId("mcp-tab-empty")).toHaveText("No connected servers.");
  // No servers at all: the surface's own line, no tabs.
  await mockPost("thread/mcp-servers?id=s-r1&keep=");
  await expect(surface(page).getByTestId("mcp-none")).toHaveText("Claude has no MCP servers in this thread.");
  await expect(surface(page).getByTestId("mcp-tabs")).toHaveCount(0);
});

test("the chosen tab is kept per thread while the MCP tab stays open, and resets to Connected once it closes", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await mcpTab(page, "failed").click();
  await expectTabs(page, [3, 2, 1], "failed", ["linear", "playwright"]);

  // Another thread: its own panel, its own MCP tab on Connected.
  await row(page, "s:s-1").click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expect(panel(page)).toHaveAttribute("data-panel-key", "thread:s-1");
  await expect(surface(page)).toHaveAttribute("data-thread", "s-1");
  await expectTabs(page, [3, 2, 1], "connected", ["t3-code", "github", "filesystem"]);
  await mcpTab(page, "disabled").click();

  // Back: each remembers its own.
  await row(page, "s:s-r1").click();
  await expectMcpTab(page);
  await expectTabs(page, [3, 2, 1], "failed", ["linear", "playwright"]);
  await row(page, "s:s-1").click();
  await expect(surface(page)).toHaveAttribute("data-thread", "s-1");
  await expectTabs(page, [3, 2, 1], "disabled", ["sentry"]);
  await row(page, "s:s-r1").click();
  await expectMcpTab(page);

  // Closing the MCP tab forgets it: reopened, it starts on Connected.
  await panel(page).getByRole("button", { name: "Close MCP" }).click();
  await expect(surface(page)).toHaveCount(0);
  await page.getByTestId("thread-info-toggle").click();
  await page.getByTestId("thread-info-card").getByTestId("ti-mcp").click();
  await expectMcpTab(page);
  await expectTabs(page, [3, 2, 1], "connected", ["t3-code", "github", "filesystem"]);
});

test("the card's row and the command open it, not M or the + list; tools expand with hint icons and their tooltips", async ({ page }) => {
  await openThread(page);
  // Not in the panel's surface list, and M opens nothing (docs/notes/thread-header-crumb.md).
  await page.getByTestId("thread-pane").getByRole("button", { name: "Toggle Side Panel" }).click();
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await expect(page.getByTestId("panel-empty").locator('[data-surface="mcp"]')).toHaveCount(0);
  await page.keyboard.press("m");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  // Open, the toggle sits in the panel's header.
  await panel(page).getByTestId("panel-toggle").click();
  await expect(panel(page)).toHaveCount(0);
  // The thread info card's MCP row.
  await page.getByTestId("thread-info-toggle").click();
  // Its text, not the value column (which opens the row's menu).
  await page.getByTestId("thread-info-card").getByTestId("ti-mcp").locator("> span").nth(1).click();
  await expectMcpTab(page);
  await page.getByTestId("thread-info-toggle").click();
  await panel(page).getByTestId("panel-toggle").click();
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

test("Reconnect on the failed card: Connecting…, then Connected with its tools", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await mcpTab(page, "failed").click();
  const pw = card(page, "playwright");
  await pw.getByTestId("mcp-reconnect").click();
  await expect(pw).toHaveAttribute("data-status", "pending");
  await expect(pw.getByTestId("mcp-pill")).toHaveText("Connecting…");
  await expect(pw.getByTestId("mcp-reconnect")).toBeDisabled();

  // Connected, it leaves the Failed tab for the Connected one.
  await expectTabs(page, [4, 1, 1], "failed", ["linear"]);
  await mcpTab(page, "connected").click();
  await expectTabs(page, [4, 1, 1], "connected", ["t3-code", "github", "playwright", "filesystem"]);
  await expect(pw).toHaveAttribute("data-status", "connected");
  await expect(pw.getByTestId("mcp-pill")).toHaveText("Connected");
  await expect(pw.getByTestId("mcp-error")).toHaveCount(0);
  await expect(pw.getByTestId("mcp-version")).toHaveText("v0.0.41");
  await expect(pw.getByTestId("mcp-tools-toggle")).toHaveText("3 tools");
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Checked (just now|\d+s ago), after reconnecting playwright$/);
  expect(await threadCalls()).toContain("mcp-reconnect s-r1 playwright");

  // A needs-login server stays so: Claude's refusal is toasted.
  await mcpTab(page, "failed").click();
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
  await expectTabs(page, [3, 2, 1], "connected", ["t3-code", "github", "filesystem"]);
  await expect(surface(page).getByTestId("mcp-refresh")).toBeEnabled();
  await mcpTab(page, "failed").click();
  const pw = card(page, "playwright");
  await expect(pw.getByTestId("mcp-reconnect")).toBeEnabled();
  await pw.getByTestId("mcp-reconnect").click();
  await expectTabs(page, [4, 1, 1], "failed", ["linear"]);
  await mcpTab(page, "connected").click();
  await expect(pw).toHaveAttribute("data-status", "connected");
  expect(await threadCalls()).toContain("mcp-reconnect s-r1 playwright");
  await surface(page).getByTestId("mcp-refresh").click();
  // The mock answers without starting Claude (the daemon starts it), so the thread stays
  // stopped and the fresh check still reads stale (docs/notes/panel-polish.md).
  await expect(surface(page).getByTestId("mcp-checked")).toHaveText(/^Last check (just now|\d+s ago) · may be out of date$/);
  // Stale at once, however recent the check.
  await expectStale(page, true);
  expect(await threadCalls()).toContain("mcp s-r1 refresh");
});

/** The stale state (docs/notes/panel-polish.md): amber header line, muted dashed pills, Refresh as the primary button. */
async function expectStale(page: Page, on: boolean): Promise<void> {
  const header = surface(page).getByTestId("mcp-header");
  if (on) await expect(header).toHaveAttribute("data-stale", "true");
  else await expect(header).not.toHaveAttribute("data-stale");
  const line = surface(page).getByTestId("mcp-checked-line");
  if (on) await expect(line).toHaveClass(/text-cf-warning-text/);
  else await expect(line).not.toHaveClass(/text-cf-warning-text/);
  const dashed = await surface(page)
    .getByTestId("mcp-pill")
    .evaluateAll((els) => els.map((e) => getComputedStyle(e).borderStyle === "dashed" && getComputedStyle(e).borderTopWidth !== "0px"));
  expect(dashed.length).toBeGreaterThan(0);
  expect(dashed).toEqual(dashed.map(() => on));
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

test("a thread Claude never reported for says so without mentioning running; Refresh checks", async ({ page }) => {
  await mockPost("thread?state=crashed");
  await openApp(page);
  await row(page, "s:s-r1").click();
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await expect(surface(page).getByTestId("mcp-empty")).toHaveText("No MCP status yet. Refresh to check.");
  await surface(page).getByTestId("mcp-refresh").click();
  await expectTabs(page, [3, 2, 1], "connected", ["t3-code", "github", "filesystem"]);
});

test("hidden for a page: not in the panel's list, not in the palette", async ({ page }) => {
  await openThread(page);
  // The Projects page does not list it.
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

/** The DOM edits stretchNames makes, by tab (a tab switch remounts the cards). */
const STRETCH = {
  connected: [
    ['[data-server="t3-code"] [data-testid="mcp-version"]', "v1.2.3-a-prerelease-tag-that-goes-on-and-on-and-on"],
    ['[data-server="github"] [data-testid="mcp-name"]', "my-extremely-long-mcp-server-name-that-keeps-going-and-going-forever"],
    ['[data-server="github"] [data-testid="mcp-tool"] [data-testid="mcp-tool-name"]', "mcp__some_extremely_long_tool_name_that_never_ends_at_all_ok"],
  ],
  failed: [
    ['[data-server="linear"] [data-testid="mcp-name"]', "another_very_long_server_name_with_underscores_everywhere_and_more"],
    ['[data-server="playwright"] [data-testid="mcp-error"]', "Error: connect ECONNREFUSED https://example.com/a/very/long/path/that/has/no/spaces/in/it/at/all"],
  ],
} as const;

/** Stretches the names in the DOM of the shown tab: long names, versions and tool names truncate, never scroll the panel sideways. */
async function stretchNames(page: Page, bucket: keyof typeof STRETCH = "connected"): Promise<void> {
  if (bucket === "connected") {
    await card(page, "github").getByTestId("mcp-tools-toggle").click();
    await expect(card(page, "github").getByTestId("mcp-tool")).toHaveCount(5);
  }
  await page.evaluate((edits) => {
    for (const [sel, text] of edits) {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) throw new Error(`missing ${sel}`);
      el.textContent = text;
    }
  }, STRETCH[bucket]);
}

/** No sideways scroll, and each named card keeps its pill inside it. */
async function expectPillsInside(page: Page, names: string[]): Promise<void> {
  const body = page.getByTestId("panel-body");
  expect(await body.evaluate((e) => e.scrollWidth - e.clientWidth)).toBeLessThanOrEqual(1);
  for (const name of names) {
    const overhang = await card(page, name).evaluate((e) => {
      const pill = e.querySelector('[data-testid="mcp-pill"]');
      if (!pill) throw new Error("no pill");
      return pill.getBoundingClientRect().right - e.getBoundingClientRect().right;
    });
    expect(overhang).toBeLessThanOrEqual(0);
  }
}

test("long names truncate: the status pill stays in the card and the panel never scrolls sideways", async ({ page }) => {
  await openThread(page);
  expect(await emit({ showView: { name: "panel.mcp" } })).toBeGreaterThan(0);
  await expectMcpTab(page);
  await stretchNames(page);
  await expectPillsInside(page, ["t3-code", "github"]);
  // The name wins over the version.
  const t3 = card(page, "t3-code");
  expect(await t3.getByTestId("mcp-name").evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(await t3.getByTestId("mcp-version").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  expect(await card(page, "github").getByTestId("mcp-name").evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  await mcpTab(page, "failed").click();
  await stretchNames(page, "failed");
  await expectPillsInside(page, ["linear", "playwright"]);
});

/**
 * SHOTS=<dir>: the notes' and PR's screenshots, WebKit, 1680x860, dark and light: the
 * panel on each tab, an empty Failed tab, and the stale state; SHOTS_LONG=1 stretches the
 * names first.
 */
for (const scheme of ["dark", "light"] as const) {
  test(`screenshots (${scheme})`, async ({ page }, info) => {
    const shots = process.env.SHOTS;
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1680, height: 860 });
    await openThread(page);
    await page.getByTestId("thread-info-toggle").click();
    await page.getByTestId("thread-info-card").getByTestId("ti-mcp").click();
    await page.getByTestId("thread-info-toggle").click();
    await expectMcpTab(page);
    if (process.env.SHOTS_LONG) await stretchNames(page);
    await page.mouse.move(0, 0);
    await page.screenshot({ path: `${String(shots)}/mcp-${scheme}.png` });
    for (const bucket of ["connected", "failed", "disabled"] as const) {
      await mcpTab(page, bucket).click();
      await page.mouse.move(0, 0);
      await panel(page).screenshot({ path: `${String(shots)}/mcp-${bucket}-${scheme}-panel.png` });
    }
    // An empty tab.
    await mcpTab(page, "failed").click();
    await mockPost("thread/mcp-servers?id=s-r1&keep=t3-code,github");
    await expect(surface(page).getByTestId("mcp-tab-empty")).toBeVisible();
    await page.mouse.move(0, 0);
    await panel(page).screenshot({ path: `${String(shots)}/mcp-empty-${scheme}-panel.png` });
    // The stale state (docs/notes/panel-polish.md).
    await mcpTab(page, "connected").click();
    await mockPost("thread/mcp-age?id=s-r1&ago=720");
    await expectStale(page, true);
    await page.mouse.move(0, 0);
    await panel(page).screenshot({ path: `${String(shots)}/mcp-stale-${scheme}-panel.png` });
  });
}
