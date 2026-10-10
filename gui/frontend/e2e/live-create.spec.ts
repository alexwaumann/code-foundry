/**
 * Live e2e: the Add Project dialog's New tab and the publish picker against a REAL daemon
 * and GitHub (docs/notes/add-project-4-create.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon whose
 * CODE_FOUNDRY_HOME is under $HOME (projects must land under home) and the Vite dev
 * server pointed at it (recipe in docs/notes/phase2-integration.md).
 *
 * It creates a project with the dialog, checks the picker lists the viewer first with
 * Public and Private (Public selected), opens the overview's publish dialog, and never
 * publishes (nothing is created on GitHub). Then it unregisters and deletes the project.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const BIN = process.env.LIVE_BIN ?? path.join(path.resolve(process.cwd(), "../.."), "bin/code-foundry");
const SHOTS = process.env.LIVE_SHOTS ?? "";

function cli(...args: string[]): string {
  return execFileSync(BIN, args, { env: { ...process.env, CODE_FOUNDRY_HOME: HOME }, encoding: "utf8", timeout: 60_000 });
}

/** The registered project at dir, over the daemon's loopback listener. */
async function projectAt(dir: string): Promise<string> {
  const read = (f: string) => readFileSync(path.join(HOME, f), "utf8").trim();
  const res = await fetch(`http://127.0.0.1:${read("daemon.port")}/codefoundry.v1.RepoService/List`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${read("daemon.token")}` },
    body: "{}",
  });
  const { repos = [] } = (await res.json()) as { repos?: { id: string; path: string }[] };
  return repos.find((r) => r.path.toLowerCase() === dir.toLowerCase())?.id ?? "";
}

test.skip(!LIVE || !HOME, "LIVE_DAEMON=1 and CODE_FOUNDRY_HOME are required");

test("create a project with the New tab; the publish picker lists the viewer", async ({ page }) => {
  const name = `cf-live-create-${String(Date.now() % 100000)}`;
  const dest = path.join(HOME, "projects", name);
  await page.goto("/");
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-new").click();
  await page.getByTestId("add-project-new-name").fill(name);
  await expect(page.getByTestId("add-project-new-dest")).toHaveText(new RegExp(`/projects/${name}$`));

  await page.getByTestId("add-project-new-publish").check();
  const owner = page.getByTestId("publish-owner");
  await expect(owner).not.toHaveAttribute("data-owner", "", { timeout: 30_000 });
  await expect(page.getByTestId("publish-visibility").getByRole("radio")).toHaveText(["Public", "Private"]);
  await expect(page.getByTestId("publish-visibility")).toHaveAttribute("data-value", "public");
  await owner.click();
  await expect(page.getByTestId("publish-owner-option").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "create-owners.png") });
  await page.keyboard.press("Escape");
  await page.getByTestId("add-project-new-publish").uncheck();

  try {
    await page.getByTestId("add-project-create").click();
    await expect(page.getByTestId("add-project-dialog")).toHaveCount(0);
    await expect(page.getByTestId("overview-title")).toHaveText(new RegExp(`^${name}@`));
    expect(await projectAt(dest)).not.toBe("");

    await page.getByTestId("publish-github").click();
    await expect(page.getByTestId("publish-dialog")).toBeVisible();
    await expect(page.getByTestId("publish-name")).toHaveValue(name);
    await expect(page.getByTestId("publish-visibility")).toHaveAttribute("data-value", "public");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "create-publish-dialog.png") });
    await page.keyboard.press("Escape");
  } finally {
    const id = await projectAt(dest);
    if (id) cli("repo", "unregister", "--context-repo", id, "--yes");
    rmSync(dest, { recursive: true, force: true });
  }
});
