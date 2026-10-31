import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, mockUrl, openApp, openProjects, openWorkspacePage, resetMock } from "./fixtures";

/**
 * The workspace card (workspaces v2, docs/notes/workspaces-v2-4-projects-page.md), the
 * body of a workspace's page on the Projects view until its redesign
 * (docs/notes/projects-redesign-1-index.md). The mock's projects: code-foundry
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

test("a card shows its name, root, projects by name with where threads start, the instructions file and skills; no worktree rows", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  // On the index, without threads: by name, mono then shop.
  await expect(page.getByTestId("index-workspace").getByTestId("workspace-name")).toHaveText(["mono", "shop"]);

  // A synthetic workspace: no root, its projects by name, the first given starts threads.
  await openWorkspacePage(page, shop);
  const s = card(page, shop);
  await expect(s).not.toHaveAttribute("data-rooted");
  await expect(s.getByTestId("workspace-root")).toHaveCount(0);
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground"]);
  await expect(s.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-gp");
  await expect(s.getByTestId("workspace-folder")).not.toHaveAttribute("data-default");
  await expect(s.getByTestId("workspace-instructions-none")).toHaveText("none yet");
  await expect(s.getByTestId("workspace-skills-none")).toHaveText("none yet");

  // Worktrees show only under their projects: no worktree rows in a card.
  await expect(s.getByTestId("project-worktree")).toHaveCount(0);
  // What a thread writes in the workspace's folder shows up (the daemon re-reads it after a turn).
  await mockPost(`workspace-files?workspace=${shop}&instructions=AGENTS.md&skills=lint`);
  await expect(s.getByTestId("workspace-instructions-open")).toHaveText("AGENTS.md");
  await expect(s.getByTestId("workspace-skill")).toHaveText(["lint"]);

  // A rooted one: its root, the folder starts threads, the root's CLAUDE.md, skills sorted.
  await openWorkspacePage(page, mono);
  const m = card(page, mono);
  await expect(m).toHaveAttribute("data-rooted", "true");
  await expect(m.getByTestId("workspace-root")).toHaveText("~/mono");
  await expect(m.getByTestId("workspace-folder")).toHaveAttribute("data-default", "true");
  await expect(m.getByTestId("workspace-folder").getByTestId("workspace-default")).toHaveText("starts here");
  await expect(m.getByTestId("workspace-instructions-open")).toHaveText("CLAUDE.md");
  await expect(m.getByTestId("workspace-instructions")).toHaveAttribute("data-file", "/Users/dev/mono/CLAUDE.md");
  await expect(m.getByTestId("workspace-skill")).toHaveText(["demo", "release"]);

  // A root that moved is marked missing (workspace set-root repairs it).
  await expect(m.getByTestId("workspace-root-missing")).toHaveCount(0);
  await mockPost(`workspace-files?workspace=${mono}&rootMissing=1`);
  await expect(m.getByTestId("workspace-root-missing")).toHaveText("missing");
  await expect(m.getByTestId("workspace-root")).toHaveAttribute("data-missing", "true");
});

test("rename in place: double-click or Rename…, Enter renames, Escape keeps, a taken name is refused", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, shop);
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
  // The page's list has the keyboard back, and Enter renamed once (the blur that follows does not again).
  await expect(page.getByTestId("projects-list")).toBeFocused();
  expect((await invocations()).filter((i) => i.name === "workspace.rename")).toHaveLength(1);

  // Escape after typing a good name keeps the stored one: nothing is renamed.
  await s.getByTestId("workspace-name").dblclick();
  await input.fill("renamedByEscape");
  await page.keyboard.press("Escape");
  await expect(s.getByTestId("workspace-name")).toHaveText("store");
  await expect(page.getByTestId("projects-list")).toBeFocused();
  expect((await invocations()).filter((i) => i.name === "workspace.rename")).toHaveLength(1);

  // Leaving the field renames, once.
  await s.getByTestId("workspace-name").dblclick();
  await input.fill("shop");
  await page.getByTestId("workspace-meta").click();
  await expect(s.getByTestId("workspace-name")).toHaveText("shop");
  expect((await invocations()).filter((i) => i.name === "workspace.rename").map((i) => i.args.name)).toEqual(["store", "shop"]);
});

test("set where new threads start: a project, or the workspace's folder", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, shop);
  const cf = member(page, shop, "repo-cf");
  // The default has no button; the others do.
  await expect(member(page, shop, "repo-gp").getByTestId("member-make-default")).toHaveCount(0);
  await cf.hover();
  await cf.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "repo-cf", workspace: shop });
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
  await openWorkspacePage(page, shop);
  const s = card(page, shop);
  await s.getByTestId("workspace-add-member").click();
  const list = page.getByTestId("workspace-add-member-list");
  // Plain folders can be members too.
  await expect(list.getByRole("option")).toHaveText(["dotfiles", "sketches", "writing"]);
  await list.getByRole("option", { name: "writing" }).click();
  expect((await lastInvocation("workspace.add-project"))?.args).toEqual({ project: "repo-wr", workspace: shop });
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground", "writing"]);

  // Removing the default moves it to the folder; nothing is asked (nothing on disk changes).
  const gp = member(page, shop, "repo-gp");
  await gp.hover();
  await gp.getByTestId("member-remove").click();
  expect((await lastInvocation("workspace.remove-project"))?.args).toEqual({ project: "repo-gp", workspace: shop });
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "writing"]);
  await expect(s.getByTestId("workspace-folder")).toHaveAttribute("data-default", "true");
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
});

test("remove asks first: a synthetic workspace's instructions and skills go, a rooted one's root stays", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, mono);
  const dialog = page.getByTestId("confirm-dialog");

  await card(page, mono).getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
  await expect(dialog).toContainText("Remove workspace mono? Its root folder /Users/dev/mono and everything in it stay");
  await page.keyboard.press("Escape");
  await expect(card(page, mono)).toBeVisible();

  // From the page's header too.
  await openWorkspacePage(page, shop);
  await page.getByTestId("workspace-page-more").click();
  await page.getByTestId("workspace-page-remove").click();
  await expect(dialog).toContainText("Remove workspace shop? Its instructions and skills are deleted too.");
  await page.keyboard.press("Escape");
  await card(page, shop).getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
  await expect(dialog).toContainText("Remove workspace shop? Its instructions and skills are deleted too.");
  await dialog.getByTestId("confirm-ok").click();
  await expect(card(page, shop)).toHaveCount(0);
  // Its page goes: back to the index.
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "index");
  const removed = (await invocations()).filter((i) => i.name === "workspace.remove");
  expect(removed.map((i) => i.confirmed)).toEqual([false, false, false, true]);
  expect(removed.at(-1)?.args).toEqual({ workspace: "shop" });
  // Its projects stay.
  await expect(page.getByTestId("index-project")).toHaveCount(5);
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
  const created = page.getByTestId("index-workspace");
  await expect(created.getByTestId("workspace-name")).toHaveText("payments");
  await created.click();
  const c = page.getByTestId("workspace");
  await expect(c.getByTestId("workspace-name")).toHaveText("payments");
  await expect(c.getByTestId("member-name")).toHaveText(["dotfiles", "ghostty-playground"]);
  await expect(c.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-dot");

  // A taken name, whatever its case, is caught before the daemon is asked.
  await page.getByTestId("projects-crumb").click();
  await page.getByTestId("projects-new-workspace").click();
  await dialog.getByTestId("new-workspace-name").fill("Payments");
  await expect(dialog.getByTestId("new-workspace-name-error")).toHaveText("A workspace named “Payments” exists.");
});

test("the instructions file opens as a File tab; Edit instructions starts a thread in the workspace's folder, then steers it", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, mono);
  const m = card(page, mono);
  await m.getByTestId("workspace-instructions-open").click();
  const panel = page.getByTestId("side-panel");
  // The workspace's page has its own panel.
  await expect(panel).toHaveAttribute("data-panel-key", `view:projects:workspace:${mono}`);
  await expect(panel.getByRole("tab", { selected: true })).toHaveText("CLAUDE.md");

  await m.getByTestId("workspace-edit-instructions").click();
  const started = await lastInvocation("thread.new");
  expect(started?.args).toMatchObject({ workspace: mono, project: "workspace", "new-worktree": "false" });
  expect(started?.context).toMatchObject({ activeView: "compose", activeWorkspaceId: mono });
  expect(started?.args.prompt).toContain("/Users/dev/mono/CLAUDE.md");
  // The daemon focuses the new thread: it runs in the root.
  await expect(page.getByTestId("thread-pane")).toBeVisible();

  // Again while that thread is still on its first turn: it is only shown, nothing is sent or started.
  const id = (await page.getByTestId("thread-pane").getAttribute("data-thread-id")) ?? "";
  expect(id).not.toBe("");
  await openWorkspacePage(page, mono);
  await m.getByTestId("workspace-edit-instructions").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", id);
  expect((await invocations()).filter((i) => i.name === "thread.send")).toHaveLength(0);
  expect((await invocations()).filter((i) => i.name === "thread.new")).toHaveLength(1);

  // Once it is up and idle: the thread in the workspace's folder is steered, not a second one started.
  await expect.poll(async () => ((await (await fetch(`${mockUrl}/__mock/threads`)).json()) as { id: string; state: string }[]).find((x) => x.id === id)?.state).toBe("CONNECTED");
  await mockPost(`thread/status?id=${id}&status=idle`);
  await openWorkspacePage(page, mono);
  await m.getByTestId("workspace-edit-instructions").click();
  const sent = await lastInvocation("thread.send");
  expect(sent?.args.text).toContain("/Users/dev/mono/CLAUDE.md");
  expect((await invocations()).filter((i) => i.name === "thread.new")).toHaveLength(1);
  await expect(page.getByTestId("thread-pane")).toBeVisible();
});

test("Open in Finder is workspace.reveal with the card's workspace", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, mono);
  await expectTooltip(page, card(page, mono).getByTestId("workspace-reveal"), "Open in Finder");
  await card(page, mono).getByTestId("workspace-reveal").click();
  const inv = await lastInvocation("workspace.reveal");
  expect(inv?.args).toEqual({ workspace: mono });
});

test("a project named “workspace”: its star sets the project, by id, not the workspace's folder", async ({ page }) => {
  await mockPost("project/rename?id=repo-dot&name=workspace");
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, mono);
  const m = card(page, mono);
  await expect(m.getByTestId("workspace-folder")).toHaveAttribute("data-default", "true");
  const dot = member(page, mono, "repo-dot");
  await expect(dot.getByTestId("member-name")).toHaveText("workspace");
  await dot.hover();
  await dot.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "repo-dot", workspace: mono });
  await expect(m.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-dot");
  await expect(m.getByTestId("workspace-folder")).not.toHaveAttribute("data-default");
  // Removing it goes by id too.
  await dot.hover();
  await dot.getByTestId("member-remove").click();
  expect((await lastInvocation("workspace.remove-project"))?.args).toEqual({ project: "repo-dot", workspace: mono });
  await expect(m.getByTestId("workspace-member")).toHaveCount(0);
});

test("an unregistered member reads “not registered” and opens nothing", async ({ page }) => {
  const ws = (await mockPost("workspace?name=sk&projects=repo-sk,repo-cf")) as { id: string };
  await openApp(page);
  await openProjects(page);
  await page.locator('[data-nav-key="p:repo-sk"]').hover();
  await page.locator('[data-nav-key="p:repo-sk"]').getByTestId("project-more").click();
  await page.getByTestId("project-unregister").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(page.locator('[data-nav-key="p:repo-sk"]')).toHaveCount(0);
  await openWorkspacePage(page, ws.id);
  const sk = member(page, ws.id, "repo-sk");
  await expect(sk.getByTestId("workspace-member")).toHaveAttribute("data-unregistered", "true");
  await expect(sk).toContainText("not registered");
  await sk.dblclick();
  await page.keyboard.press("Enter");
  // No blank tab: the page's panel has no tab for it (nor opened at all).
  await expect(page.getByTestId("side-panel").getByRole("tab", { name: /repo-sk/ })).toHaveCount(0);
  // A registered member still opens its main worktree.
  await member(page, ws.id, "repo-cf").dblclick();
  await expect(page.getByTestId("side-panel").getByRole("tab", { selected: true })).toHaveText("Changes · code-foundry");
});

test("Edit instructions steers once: the toast names the thread (no CLI text); while it works a press only shows it", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  const t = (await mockPost(`workspace-thread?workspace=${mono}&project=workspace&name=driver&status=busy`)) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, mono);
  const edit = card(page, mono).getByTestId("workspace-edit-instructions");
  await edit.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", t.id);
  const toasts = page.locator("[data-sonner-toast]");
  await expect(toasts.filter({ hasText: "Sent to driver" })).toHaveCount(1);
  await expect(toasts.filter({ hasText: "wait with" })).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "thread.send")).toHaveLength(1);

  // Still working on it: shown again, not sent again.
  await openWorkspacePage(page, mono);
  await edit.click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", t.id);
  expect((await invocations()).filter((i) => i.name === "thread.send")).toHaveLength(1);

  // Done: the next press steers again.
  await mockPost(`thread/status?id=${t.id}&status=idle`);
  await openWorkspacePage(page, mono);
  await edit.click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "thread.send").length).toBe(2);
  expect((await invocations()).filter((i) => i.name === "thread.new")).toHaveLength(0);
});

test("member rows and the New workspace list show projects by name, not by id", async ({ page }) => {
  // repo-cf sorts first by id; as "Zebra" it goes last by name.
  await mockPost("project/rename?id=repo-cf&name=Zebra");
  const ws = (await mockPost("workspace?name=zoo&projects=repo-cf,repo-gp,repo-dot")) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, ws.id);
  await expect(card(page, ws.id).getByTestId("member-name")).toHaveText(["dotfiles", "ghostty-playground", "Zebra"]);
  // The keyboard walks them in the same order.
  await card(page, ws.id).getByTestId("workspace-name").click();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator('[aria-selected="true"][data-nav-key]')).toHaveAttribute("data-nav-key", `m:${ws.id}::repo-dot`);

  await page.getByTestId("projects-crumb").click();
  await page.getByTestId("projects-new-workspace").click();
  await expect(page.getByTestId("new-workspace-project").locator("label")).toHaveText(["dotfiles", "ghostty-playground", "sketches", "writing", "Zebra"]);
  await page.keyboard.press("Escape");
});

test("skills: eight chips, then “+N more” whose tooltip lists the rest; the label sits on the first row", async ({ page }) => {
  const skills = Array.from({ length: 11 }, (_, i) => `skill-${String(i).padStart(2, "0")}`);
  const ws = (await mockPost(`workspace?name=many&projects=repo-dot&skills=${skills.join(",")}`)) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, ws.id);
  const line = card(page, ws.id).getByTestId("workspace-skills");
  await expect(line.getByTestId("workspace-skill")).toHaveText(skills.slice(0, 8));
  const more = line.getByTestId("workspace-skills-more");
  await expect(more).toHaveText("+3 more");
  await expectTooltip(page, more, "skill-08, skill-09, skill-10");
  // Top-aligned: the label's box starts where the first chip row's does.
  const label = await line.getByText("Skills", { exact: true }).boundingBox();
  const first = await line.getByTestId("workspace-skill").first().boundingBox();
  expect(Math.abs((label?.y ?? 0) + (label?.height ?? 0) / 2 - ((first?.y ?? 0) + (first?.height ?? 0) / 2))).toBeLessThanOrEqual(2);
});

test("the index filter matches a workspace by a project's name; a removed workspace's collapsed mark goes", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  await page.getByTestId("projects-filter").fill("ghostty");
  await expect(page.getByTestId("index-workspace").getByTestId("workspace-name")).toHaveText(["shop"]);
  await page.getByTestId("projects-filter").fill("");

  await openWorkspacePage(page, mono);
  await card(page, mono).getByTestId("workspace-collapse").click();
  await expect(card(page, mono)).toHaveAttribute("data-collapsed", "true");
  const collapsed = () => page.evaluate(() => (JSON.parse(localStorage.getItem("code-foundry.ui") ?? "{}") as { state?: { collapsedWorkspaces?: string[] } }).state?.collapsedWorkspaces ?? []);
  expect(await collapsed()).toEqual([mono]);
  await card(page, mono).getByTestId("workspace-more").click();
  await page.getByTestId("workspace-remove").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(card(page, mono)).toHaveCount(0);
  await expect.poll(collapsed).toEqual([]);
  await expect(page.locator(`[data-nav-key="ws:${shop}"]`)).toBeVisible();
});
