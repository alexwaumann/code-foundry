import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, mockPost, mockUrl, openApp, resetMock, row } from "./fixtures";

/**
 * Plugin surfaces, consent and Settings → Plugins (docs/notes/plugins-5-gui.md) against the
 * mock's plugins (mock/plugins.ts): hello running with its demo surface (the captured
 * views of the real example), crasher crashed, acme-data disabled and never consented.
 */

const surface = (page: Page) => page.getByTestId("plugin-surface");
const tab = (page: Page, key: string) => surface(page).locator(`[data-testid="plugin-tab"][data-key="${key}"]`);

async function acts(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/plugin/acts`);
  return (await res.json()) as string[];
}

/** Thread s-3 selected, its panel showing the hello demo (opened from the palette). */
async function openDemo(page: Page): Promise<void> {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+k");
  await page.keyboard.type("Show Hello Demo");
  await page.getByTestId("palette").locator('[data-command="plugin.hello.show.demo"]').click();
  await expect(surface(page)).toHaveAttribute("data-phase", "live");
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "plugin.hello.demo");
}

test.beforeEach(async () => {
  await resetMock();
});

test("the demo opens in the panel with its header, tabs and every node kind; the tab takes the view's title", async ({ page }) => {
  await openDemo(page);
  await expect(page.getByTestId("panel-tabs").getByRole("tab", { selected: true })).toHaveText("Hello");
  await expect(surface(page).getByTestId("plugin-title")).toHaveText("Hello demo");
  await expect(surface(page).getByTestId("plugin-subline")).toContainText("thread s-3");
  await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
  for (const id of ["plugin-text", "plugin-markdown", "plugin-pairs", "plugin-list", "plugin-chips", "plugin-progress", "plugin-notice", "plugin-section", "plugin-empty"]) {
    await expect(surface(page).getByTestId(id).first()).toBeVisible();
  }
  await expect(surface(page).getByTestId("plugin-row")).toHaveCount(3);
  await expect(surface(page).getByTestId("plugin-chip")).toHaveCount(7);
  // The section collapses on the host, without a round trip.
  const nested = surface(page).locator('[data-testid="plugin-section"][data-key="more"]');
  await nested.getByTestId("plugin-section-toggle").click();
  await expect(nested).toHaveAttribute("data-collapsed", "true");
  await expect(nested.getByTestId("plugin-empty")).toHaveCount(0);
});

test("a button click reaches Act and the plugin's next view; a command button runs the command", async ({ page }) => {
  await openDemo(page);
  await surface(page).locator('[data-testid="plugin-button"][data-key="click"]').click();
  await expect(surface(page).locator('[data-testid="plugin-button"][data-key="click"]')).toHaveText("Click (1)");
  await expect(surface(page).getByTestId("plugin-header")).toContainText("1 click");
  expect((await acts()).some((a) => a.startsWith("hello/demo/thread:s-3 click "))).toBe(true);

  await surface(page).locator('[data-testid="plugin-button"][data-key="greet"]').click();
  await expect.poll(async () => (await invocations()).some((i) => i.name === "plugin.hello.greet" && i.args.name === "panel" && i.context?.activeThreadId === "s-3")).toBe(true);

  // A destructive command asks first, in the daemon's words.
  await surface(page).locator('[data-testid="plugin-button"][data-key="forget"]').click();
  await expect(page.getByTestId("confirm-dialog")).toContainText("Forget the remembered word?");
  await page.getByTestId("confirm-cancel").click();
});

test("switching tabs acts on the tab; the log tab streams appended lines", async ({ page }) => {
  await openDemo(page);
  await tab(page, "log").click();
  await expect(tab(page, "log")).toHaveAttribute("aria-selected", "true");
  const lint = surface(page).getByTestId("plugin-log").nth(1);
  await expect(lint.locator('[data-tone="attention"]')).toHaveText("warning: unused variable x");
  await expect(lint.locator('[data-tone="error"]')).toHaveText("error: missing return");
  await surface(page).locator('[data-testid="plugin-button"][data-key="log-start"]').click();
  const build = surface(page).getByTestId("plugin-log-box").first();
  await expect(build).toContainText("[1/6] fetching sources");
  await expect(build).toContainText("[6/6] done");
  await expect(build).toHaveAttribute("data-lines", "6");
});

test("the form checks on the host, submits its values to the plugin, and keeps drafts per tab", async ({ page }) => {
  await openDemo(page);
  await tab(page, "form").click();
  const form = surface(page).getByTestId("plugin-form");
  await expect(form).toBeVisible();
  // Required: the host refuses before the plugin hears of it.
  await form.locator('[data-testid="plugin-button"][data-key="f-save"]').click();
  await expect(form.locator('[data-name="name"] [data-testid="plugin-field-error"]')).toHaveText("Required");
  const name = form.locator('[data-testid="plugin-input"][data-name="name"]');
  await name.fill("Ada1");
  await name.blur();
  await expect(form.locator('[data-name="name"] [data-testid="plugin-field-error"]')).toHaveText("Letters and spaces only");
  await name.fill("Ada");
  // A draft survives a trip to another tab.
  await tab(page, "overview").click();
  await expect(tab(page, "overview")).toHaveAttribute("aria-selected", "true");
  await tab(page, "form").click();
  await expect(name).toHaveValue("Ada");
  await form.locator('[data-testid="plugin-input"][data-name="token"]').fill("tok-123");
  await form.locator('[data-testid="plugin-select"][data-name="tags"] [data-value="b"]').click();
  await form.locator('[data-testid="plugin-toggle"][data-name="notifyDone"]').click();
  await form.locator('[data-testid="plugin-button"][data-key="f-save"]').click();
  await expect(surface(page).getByTestId("plugin-text").first()).toContainText('Saved: {"name":"Ada"');
  await expect(page.getByText("saved", { exact: true })).toBeVisible();
  const sent = (await acts()).find((a) => a.includes(" f-save "));
  expect(sent).toBeDefined();
  const values = JSON.parse(sent?.slice(sent.indexOf("{")) ?? "{}") as Record<string, unknown>;
  expect(values).toMatchObject({ name: "Ada", token: "tok-123", env: "dev", tags: ["a", "b"], notifyFail: true, notifyDone: true });
  // The secret is never echoed: the field is empty again, saying a value is stored.
  await expect(form.locator('[data-testid="plugin-input"][data-name="token"]')).toHaveValue("");
  await expect(form.locator('[data-testid="plugin-input"][data-name="token"]')).toHaveAttribute("placeholder", "Saved · type to replace");
});

test("the surface list shows plugin surfaces below the built-ins; Pin flips the pinned surface's availability", async ({ page }) => {
  await openDemo(page);
  await page.getByTestId("panel-new-tab").click();
  const plugins = page.getByTestId("panel-plugin-surfaces");
  await expect(plugins.locator("[data-surface]")).toHaveCount(1);
  await expect(plugins.locator('[data-surface="plugin.hello.demo"]')).toHaveText(/Hello Demo/);
  await plugins.locator('[data-surface="plugin.hello.demo"]').click();
  await surface(page).locator('[data-testid="plugin-button"][data-key="pin"]').click();
  await page.getByTestId("panel-new-tab").click();
  await expect(plugins.locator('[data-surface="plugin.hello.pinned"]')).toBeVisible();
  await plugins.locator('[data-surface="plugin.hello.pinned"]').click();
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "plugin.hello.pinned");
});

test("a plugin that goes down keeps its last view dimmed and offers a restart; ShowView with a thread selects it", async ({ page }) => {
  await openDemo(page);
  await mockPost("plugin/state?name=hello&state=crashed");
  await expect(surface(page).getByTestId("plugin-down")).toContainText("Hello crashed");
  await expect(surface(page).getByTestId("plugin-body")).toHaveAttribute("data-stale", "true");
  await surface(page).getByTestId("plugin-restart").click();
  await expect(surface(page).getByTestId("plugin-down")).toHaveCount(0);
  await expect(surface(page)).toHaveAttribute("data-phase", "live");

  await emit({ showView: { name: "panel.plugin.hello.demo?thread=s-4" } });
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel-key", "thread:s-4");
  await expect(surface(page).getByTestId("plugin-subline")).toContainText("thread s-4");
});

test("an InvokeCommand intent runs the command through the confirm dialog, naming the plugin", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await mockPost("plugin/invoke?name=hello&command=plugin.hello.forget&thread=s-3");
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toContainText("Forget the remembered word?");
  await expect(dialog.getByTestId("confirm-caller")).toHaveText("Asked by Hello");
  await dialog.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await invocations()).some((i) => i.name === "plugin.hello.forget" && i.confirmed === true)).toBe(true);
});

test("Settings → Plugins lists them; enabling one asks for consent with its permissions in words", async ({ page }) => {
  await openApp(page);
  await row(page, "s:s-3").click();
  await page.keyboard.press("Meta+,");
  await page.getByTestId("settings-nav-plugins").click();
  const rows = page.getByTestId("plugin-row-settings");
  await expect(rows).toHaveCount(4);
  await expect(rows.locator('[data-testid="plugin-pill"]')).toHaveText(["Disabled", "Crashed", "Running", "Running"]);
  const hello = rows.and(page.locator('[data-plugin="hello"]'));
  await expect(hello.getByTestId("plugin-process")).toHaveText("pid 48213");
  await expect(hello.getByTestId("plugin-env")).toContainText("CF_HELLO");
  await expect(hello.getByTestId("plugin-env")).not.toContainText("CF_HELLO=");
  await expect(hello.getByTestId("plugin-env")).toContainText("running threads keep what they spawned with");
  await expect(rows.and(page.locator('[data-plugin="crasher"]')).getByTestId("plugin-last-error")).toHaveText("exited with status 1: crasher: cannot read config");

  await hello.getByTestId("plugin-logs-open").click();
  await expect(page.getByTestId("plugin-logs")).toContainText("hello is up");
  await page.keyboard.press("Escape");

  const acme = rows.and(page.locator('[data-plugin="acme-data"]'));
  await acme.getByTestId("plugin-enable").click();
  const consent = page.getByTestId("consent-dialog");
  await expect(consent.getByTestId("consent-title")).toHaveText("Enable Acme Data 1.2.0?");
  await expect(consent.getByTestId("consent-permissions").locator("li")).toHaveText([
    /run Code Foundry commands: thread.send/,
    /add environment variables to new Claude threads/,
    /keep secrets in your Keychain/,
  ]);
  await consent.getByTestId("consent-cancel").click();
  await expect(acme.locator('[data-testid="plugin-pill"]')).toHaveText("Disabled");
  await acme.getByTestId("plugin-enable").click();
  await consent.getByTestId("consent-enable").click();
  await expect(acme.locator('[data-testid="plugin-pill"]')).toHaveText("Running");

  // Its global surface opens from the row: Settings closes, the panel shows it.
  await acme.locator('[data-testid="plugin-open-surface"][data-surface="plugin.acme-data.access"]').click();
  await expect(page.getByTestId("settings-page")).toHaveCount(0);
  await expect(page.getByTestId("panel-body")).toHaveAttribute("data-surface", "plugin.acme-data.access");
  await expect(surface(page).getByTestId("plugin-title")).toHaveText("Data access");
});
