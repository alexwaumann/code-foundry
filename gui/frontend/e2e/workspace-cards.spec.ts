import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, openProjects, resetMock, row } from "./fixtures";

/**
 * The Projects page's workspace cards and the Worktree tab's Also in list (workspaces v2,
 * docs/notes/workspaces-v2-4-projects-page.md). The mock's projects: code-foundry
 * (repo-cf) and ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot), sketches
 * (repo-sk) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const card = (page: Page, id: string) => page.locator(`[data-testid="workspace"][data-workspace="${id}"]`);
const member = (page: Page, id: string, projectId: string) => card(page, id).locator(`[data-nav-key="m:${id}::${projectId}"]`);

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

async function twoWorkspaces(): Promise<{ shop: string; mono: string }> {
  const shop = (await mockPost("workspace?name=shop&projects=repo-gp,repo-cf")) as { id: string };
  const mono = (await mockPost("workspace?name=mono&projects=repo-dot&root=/Users/dev/mono&instructions=CLAUDE.md&skills=release,demo")) as { id: string };
  return { shop: shop.id, mono: mono.id };
}

test("a card shows its name, root, projects by id with where threads start, the instructions file and skills; no worktree rows", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  await expect(page.getByTestId("projects-counts")).toHaveText("5 projects · 2 workspaces");
  // Sorted by name: mono, shop.
  await expect(page.getByTestId("workspace-name")).toHaveText(["mono", "shop"]);

  // A synthetic workspace: no root, its projects by id (repo-cf before repo-gp), the first given starts threads.
  const s = card(page, shop);
  await expect(s).not.toHaveAttribute("data-rooted");
  await expect(s.getByTestId("workspace-root")).toHaveCount(0);
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground"]);
  await expect(s.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-gp");
  await expect(s.getByTestId("workspace-folder")).not.toHaveAttribute("data-default");
  await expect(s.getByTestId("workspace-instructions-none")).toHaveText("none yet");
  await expect(s.getByTestId("workspace-skills-none")).toHaveText("none yet");

  // A rooted one: its root, the folder starts threads, the root's CLAUDE.md, skills sorted.
  const m = card(page, mono);
  await expect(m).toHaveAttribute("data-rooted", "true");
  await expect(m.getByTestId("workspace-root")).toHaveText("~/mono");
  await expect(m.getByTestId("workspace-folder")).toHaveAttribute("data-default", "true");
  await expect(m.getByTestId("workspace-folder").getByTestId("workspace-default")).toHaveText("starts here");
  await expect(m.getByTestId("workspace-instructions-open")).toHaveText("CLAUDE.md");
  await expect(m.getByTestId("workspace-instructions")).toHaveAttribute("data-file", "/Users/dev/mono/CLAUDE.md");
  await expect(m.getByTestId("workspace-skill")).toHaveText(["demo", "release"]);

  // Worktrees show only under their projects: no worktree rows in a card.
  await expect(s.getByTestId("project-worktree")).toHaveCount(0);
  await expect(page.locator('[data-testid="project"][data-project="repo-cf"]').getByTestId("project-worktree")).toHaveCount(3);

  // What a thread writes in the workspace's folder shows up (the daemon re-reads it after a turn).
  await mockPost(`workspace-files?workspace=${shop}&instructions=AGENTS.md&skills=lint`);
  await expect(s.getByTestId("workspace-instructions-open")).toHaveText("AGENTS.md");
  await expect(s.getByTestId("workspace-skill")).toHaveText(["lint"]);
});

test("rename in place: double-click or Rename…, Enter renames, Escape keeps, a taken name is refused", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  const s = card(page, shop);
  await s.getByTestId("workspace-name").dblclick();
  const input = s.getByTestId("workspace-name-input");
  await expect(input).toBeFocused();
  await input.fill("MONO");
  await expect(s.getByTestId("workspace-name-error")).toHaveText("A workspace named “MONO” exists.");
  await page.keyboard.press("Enter");
  await expect(input).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(s.getByTestId("workspace-name")).toHaveText("shop");
  expect((await invocations()).filter((i) => i.name === "workspace.rename")).toHaveLength(0);

  await s.getByTestId("workspace-more").click();
  await page.getByTestId("workspace-rename").click();
  await expect(input).toBeFocused();
  await input.fill("store");
  await page.keyboard.press("Enter");
  await expect(s.getByTestId("workspace-name")).toHaveText("store");
  const inv = await lastInvocation("workspace.rename");
  expect(inv?.args).toEqual({ name: "store", workspace: shop });
  expect(inv?.context).toMatchObject({ activeView: "projects", activeWorkspaceId: shop });
  // The page's list has the keyboard back.
  await expect(page.getByTestId("projects-list")).toBeFocused();
});

test("set where new threads start: a project, or the workspace's folder", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  const cf = member(page, shop, "repo-cf");
  // The default has no button; the others do.
  await expect(member(page, shop, "repo-gp").getByTestId("member-make-default")).toHaveCount(0);
  await cf.hover();
  await cf.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "code-foundry", workspace: shop });
  await expect(card(page, shop).locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-cf");

  const folder = card(page, shop).getByTestId("workspace-folder");
  await folder.hover();
  await folder.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "workspace", workspace: shop });
  await expect(folder).toHaveAttribute("data-default", "true");
  await expect(card(page, shop).locator('[data-testid="workspace-member"][data-default]')).toHaveCount(0);
});

test("add and remove a project: a picker of the registered projects that are not in it", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  const s = card(page, shop);
  await s.getByTestId("workspace-add-member").click();
  const list = page.getByTestId("workspace-add-member-list");
  // Plain folders can be members too.
  await expect(list.getByRole("option")).toHaveText(["dotfiles", "sketches", "writing"]);
  await list.getByRole("option", { name: "writing" }).click();
  expect((await lastInvocation("workspace.add-project"))?.args).toEqual({ project: "writing", workspace: shop });
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground", "writing"]);

  // Removing the default moves it to the folder; nothing is asked (nothing on disk changes).
  const gp = member(page, shop, "repo-gp");
  await gp.hover();
  await gp.getByTestId("member-remove").click();
  expect((await lastInvocation("workspace.remove-project"))?.args).toEqual({ project: "ghostty-playground", workspace: shop });
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "writing"]);
  await expect(s.getByTestId("workspace-folder")).toHaveAttribute("data-default", "true");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("remove asks first: a synthetic workspace's instructions and skills go, a rooted one's root stays", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  const dialog = page.getByTestId("confirm-dialog");

  await card(page, mono).getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
  await expect(dialog).toContainText("Remove workspace mono? Its root folder /Users/dev/mono and everything in it stay");
  await page.keyboard.press("Escape");
  await expect(card(page, mono)).toBeVisible();

  await card(page, shop).getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
  await expect(dialog).toContainText("Remove workspace shop? Its instructions and skills are deleted too.");
  await dialog.getByTestId("confirm-ok").click();
  await expect(card(page, shop)).toHaveCount(0);
  const removed = (await invocations()).filter((i) => i.name === "workspace.remove");
  expect(removed.map((i) => i.confirmed)).toEqual([false, false, true]);
  expect(removed.at(-1)?.args).toEqual({ workspace: "shop" });
  // Its projects and their worktrees stay.
  await expect(page.getByTestId("project")).toHaveCount(5);
});

test("New workspace: a name and its projects, then workspace.new", async ({ page }) => {
  await openApp(page);
  await openProjects(page);
  await expect(page.getByTestId("workspaces-empty")).toBeVisible();
  await page.getByTestId("projects-new-workspace").click();
  const dialog = page.getByTestId("new-workspace-dialog");
  await expect(dialog.getByTestId("new-workspace-name")).toBeFocused();
  const submit = dialog.getByTestId("new-workspace-submit");
  await expect(submit).toBeDisabled();
  await page.keyboard.type("workspace");
  await expect(dialog.getByTestId("new-workspace-name-error")).toHaveText("“workspace” is reserved.");
  await dialog.getByTestId("new-workspace-name").fill("payments");
  await expect(submit).toBeDisabled(); // no project yet
  await dialog.locator('[data-project="repo-gp"]').getByRole("checkbox").click();
  await dialog.locator('[data-project="repo-dot"]').getByRole("checkbox").click();
  await submit.click();
  await expect(dialog).toHaveCount(0);
  const inv = await lastInvocation("workspace.new");
  // The page's order (by name): dotfiles first, so it is the default primary.
  expect(inv?.args).toEqual({ name: "payments", projects: "dotfiles,ghostty-playground" });
  const c = page.getByTestId("workspace");
  await expect(c.getByTestId("workspace-name")).toHaveText("payments");
  await expect(c.getByTestId("member-name")).toHaveText(["dotfiles", "ghostty-playground"]);
  await expect(c.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-dot");

  // A taken name, whatever its case, is caught before the daemon is asked.
  await page.getByTestId("projects-new-workspace").click();
  await dialog.getByTestId("new-workspace-name").fill("Payments");
  await expect(dialog.getByTestId("new-workspace-name-error")).toHaveText("A workspace named “Payments” exists.");
});

test("the instructions file opens as a File tab; Edit instructions starts a thread in the workspace's folder, then steers it", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  const m = card(page, mono);
  await m.getByTestId("workspace-instructions-open").click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel-key", "view:projects");
  await expect(panel.getByRole("tab", { selected: true })).toHaveText("CLAUDE.md");

  await m.getByTestId("workspace-edit-instructions").click();
  const started = await lastInvocation("thread.new");
  expect(started?.args).toMatchObject({ workspace: mono, project: "workspace", "new-worktree": "false" });
  expect(started?.context).toMatchObject({ activeView: "compose", activeWorkspaceId: mono });
  expect(started?.args.prompt).toContain("/Users/dev/mono/CLAUDE.md");
  // The daemon focuses the new thread: it runs in the root.
  await expect(page.getByTestId("thread-pane")).toBeVisible();

  // Again: the thread in the workspace's folder is steered, not a second one started.
  await openProjects(page);
  await m.getByTestId("workspace-edit-instructions").click();
  const sent = await lastInvocation("thread.send");
  expect(sent?.args.text).toContain("/Users/dev/mono/CLAUDE.md");
  expect((await invocations()).filter((i) => i.name === "thread.new")).toHaveLength(1);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
});

test("Reveal in Finder is workspace.reveal with the card's workspace", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  await card(page, mono).getByTestId("workspace-reveal").click();
  const inv = await lastInvocation("workspace.reveal");
  expect(inv?.args).toEqual({ workspace: mono });
});

const GP_FEAT = "/Users/dev/.code-foundry/worktrees/alexwaumann/ghostty-playground/feat-multi";
const CF_FEAT = "/Users/dev/.code-foundry/worktrees/alexwaumann/code-foundry/feat-multi";

test("the Worktree tab's Also in: the thread's other checkouts, each opening as its own tab; none for a single-project thread", async ({ page }) => {
  const t = (await mockPost("multi-thread?projects=repo-cf,repo-gp,repo-wr&project=repo-cf&branch=feat/multi&name=multi")) as { id: string };
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await expect(page.getByTestId("thread-pane")).toBeVisible();
  await page.keyboard.press("Meta+Shift+e");
  await page.keyboard.press("t");
  const surface = page.getByTestId("worktree-surface");
  await expect(surface).toHaveAttribute("data-path", CF_FEAT);
  const also = surface.getByTestId("worktree-also-in");
  await expect(also.getByTestId("also-in-name")).toHaveText(["ghostty-playground", "writing"]);
  await expect(also.locator('[data-project="repo-gp"]').getByTestId("also-in-branch")).toHaveText("feat/multi");
  await expect(also.locator('[data-project="repo-wr"]').getByTestId("also-in-branch")).toHaveCount(0);
  await expect(also.getByTestId("also-in-dirty")).toHaveCount(0);

  // A dirty member shows its changed files, live from the project's status.
  await mockPost(`worktree/dirty?path=${encodeURIComponent(GP_FEAT)}&modified=3`);
  await expect(also.locator('[data-project="repo-gp"]').getByTestId("also-in-dirty")).toHaveText("3");

  // A click opens that checkout as its own Worktree tab, in the thread's panel.
  await also.locator('[data-project="repo-gp"]').click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel-key", `thread:${t.id}`);
  await expect(panel.getByRole("tab", { selected: true })).toHaveText("ghostty-playground · feat/multi");
  await expect(surface).toHaveAttribute("data-path", GP_FEAT);
  // From there, the primary is one of the others.
  await expect(surface.getByTestId("worktree-also-in").getByTestId("also-in-name")).toHaveText(["code-foundry", "writing"]);

  // A single-project thread has no list.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+Shift+e");
  await page.keyboard.press("t");
  await expect(surface).toHaveAttribute("data-path", CF);
  await expect(surface.getByTestId("worktree-surface-title")).toHaveText("code-foundry@main");
  await expect(surface.getByTestId("worktree-also-in")).toHaveCount(0);
});

test("Also in follows the thread's set: a worktree not made yet is marked, and the list asks again when one is made", async ({ page }) => {
  // repo-gp's worktree on the branch is made here; repo-cf's is not (a resumed thread recreates it).
  const t = (await mockPost("multi-thread?projects=repo-gp&project=repo-gp&branch=feat/later&name=later")) as { id: string };
  await mockPost(`thread/project-ids?id=${t.id}&projects=repo-cf,repo-gp`);
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.keyboard.press("Meta+Shift+e");
  await page.keyboard.press("t");
  const also = page.getByTestId("worktree-surface").getByTestId("worktree-also-in");
  const cf = also.locator('[data-project="repo-cf"]');
  await expect(cf).toHaveAttribute("data-missing", "true");
  await expect(cf.getByTestId("also-in-missing")).toHaveText("made at the next start");
  // The worktree appears (a start made it): the list reads the checkouts again.
  await mockPost("worktree/merged?project=repo-cf&branch=feat/later");
  await expect(cf).not.toHaveAttribute("data-missing");
});
