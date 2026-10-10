/**
 * Live e2e: the Add Project dialog's GitHub tab against a REAL daemon and GitHub
 * (docs/notes/add-project-3-dialog.md). Opt-in (LIVE_DAEMON=1), run with
 * playwright.live.config.ts, which starts nothing: bring up an isolated daemon whose
 * CODE_FOUNDRY_HOME is under $HOME (clones must land under home) and the Vite dev server
 * pointed at it (recipe in docs/notes/phase2-integration.md), and name a small
 * repository you can clone (LIVE_CLONE_REPO=owner/name) that is not cloned there yet.
 *
 * It searches for the repository, looks it up by URL, clones it with the dialog (gh's
 * progress streams in), checks the new project opens, then unregisters it and deletes
 * the clone.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const LIVE = process.env.LIVE_DAEMON === "1";
const HOME = process.env.CODE_FOUNDRY_HOME ?? "";
const REPO = process.env.LIVE_CLONE_REPO ?? "";
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

test.skip(!LIVE || !HOME || !REPO, "LIVE_DAEMON=1, CODE_FOUNDRY_HOME and LIVE_CLONE_REPO are required");

test("search, look up and clone a GitHub repository with the dialog", async ({ page }) => {
  const [owner = "", name = ""] = REPO.split("/");
  const dest = path.join(HOME, "projects", owner, name);
  await page.goto("/");
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-github").click();
  const input = page.getByTestId("add-project-github-input");

  await input.fill(`${name} user:${owner}`);
  await input.press("Enter");
  await expect(page.getByTestId("add-project-github-result").and(page.locator(`[data-slug="${REPO}" i]`))).toBeVisible();
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "addproject-search.png") });

  await input.fill(`https://github.com/${REPO}.git`);
  await input.press("Enter");
  const card = page.getByTestId("add-project-github-selected");
  await expect(card).toHaveAttribute("data-slug", new RegExp(`^${REPO}$`, "i"));
  await expect(card.getByTestId("add-project-clone-dest")).toHaveText(new RegExp(`/projects/${owner}/${name}$`, "i"));

  try {
    await card.getByTestId("add-project-clone").click();
    await expect(card.getByTestId("add-project-clone-line").first()).toContainText("Cloning into");
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "addproject-cloning.png") });
    await expect(page.getByTestId("add-project-dialog")).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId("worktree-surface-title")).toContainText(`${name}@`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, "addproject-cloned.png") });
    expect(await projectAt(dest)).not.toBe("");
  } finally {
    const id = await projectAt(dest);
    if (id) cli("repo", "unregister", "--context-repo", id, "--yes");
    rmSync(dest, { recursive: true, force: true });
  }
});
