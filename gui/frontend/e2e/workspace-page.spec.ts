import { expect, test, type Page } from "@playwright/test";
import { expectTooltip, invocations, mockPost, mockUrl, openApp, openProjectPage, openProjects, openWorkspacePage, resetMock } from "./fixtures";

/**
 * A workspace's page on the Projects view (docs/notes/projects-redesign-3-workspace-page.md):
 * its Projects card, Threads table and Instructions and skills, under the header PR 2
 * built (docs/notes/projects-redesign-1-index.md). The mock's projects: code-foundry
 * (repo-cf) and ghostty-playground (repo-gp) on GitHub, dotfiles (repo-dot, origin not on
 * GitHub), sketches (repo-sk) and writing (repo-wr, no git).
 */

test.beforeEach(async () => {
  await resetMock();
});

const body = (page: Page, id: string) => page.locator(`[data-testid="workspace"][data-workspace="${id}"]`);
const member = (page: Page, id: string, projectId: string) => body(page, id).locator(`[data-nav-key="m:${id}::${projectId}"]`);
const threadRow = (page: Page, id: string, threadId: string) => body(page, id).locator(`[data-nav-key="wt:${id}::${threadId}"]`);

async function lastInvocation(name: string) {
  await expect.poll(async () => (await invocations()).filter((i) => i.name === name).length).toBeGreaterThan(0);
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

async function menuItems(page: Page, testId: string): Promise<string[]> {
  const menu = page.getByTestId(`${testId}-menu`);
  await expect(menu).toBeVisible();
  return (await menu.getByRole("menuitem").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
}

async function twoWorkspaces(): Promise<{ shop: string; mono: string }> {
  const shop = (await mockPost("workspace?name=shop&projects=repo-gp,repo-cf")) as { id: string };
  const mono = (await mockPost("workspace?name=mono&projects=repo-dot&root=/Users/dev/mono&instructions=CLAUDE.md&skills=release,demo")) as { id: string };
  return { shop: shop.id, mono: mono.id };
}

test("a synthetic workspace: its projects by name with where threads start and their captions, no folder row, the instructions rows", async ({ page }) => {
  const { shop, mono } = await twoWorkspaces();
  await openApp(page);
  await openProjects(page);
  // On the index, without threads: by name, mono then shop; the contents read from the same fields.
  await expect(page.getByTestId("index-workspace").getByTestId("workspace-name")).toHaveText(["mono", "shop"]);
  await expect(page.locator(`[data-testid="index-workspace"][data-workspace="${shop}"]`).getByTestId("workspace-contents")).toHaveText("no instructions · no skills");
  await expect(page.locator(`[data-testid="index-workspace"][data-workspace="${mono}"]`).getByTestId("workspace-contents")).toHaveText("CLAUDE.md · 2 skills");

  await openWorkspacePage(page, shop);
  const s = body(page, shop);
  await expect(s).not.toHaveAttribute("data-rooted");
  await expect(s.getByTestId("workspace-projects-title")).toHaveText(/Projects\s*· every thread checks these out together on one branch/);
  await expect(s.getByTestId("member-name")).toHaveText(["code-foundry", "ghostty-playground"]);
  await expect(s.getByTestId("member-caption")).toHaveText(["alexwaumann/code-foundry", "alexwaumann/ghostty-playground"]);
  // The first project given starts threads; its row carries the pill, the others none.
  await expect(s.locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-gp");
  await expect(s.getByTestId("workspace-default")).toHaveCount(1);
  await expect(member(page, shop, "repo-gp").getByTestId("workspace-default")).toHaveText("starts here");
  // A synthetic workspace whose projects start threads shows nothing for its folder.
  await expect(s.getByTestId("workspace-folder")).toHaveCount(0);
  // No worktree rows: worktrees show under their projects.
  await expect(s.getByTestId("project-worktree")).toHaveCount(0);

  // No threads yet.
  await expect(s.getByTestId("workspace-threads-title")).toHaveText(/Threads\s*· none yet/);
  await expect(s.getByTestId("workspace-threads-empty")).toBeVisible();

  // Instructions and skills.
  await expect(s.getByTestId("workspace-instructions-label")).toHaveText("CLAUDE.md");
  await expect(s.getByTestId("workspace-instructions-none")).toHaveText("None yet");
  await expect(s.getByTestId("workspace-edit-instructions")).toHaveText("Write instructions");
  await expect(s.getByTestId("workspace-instructions-reach")).toHaveText("(starts a thread)");
  await expect(s.getByTestId("workspace-skills-none")).toHaveText("None yet");
  await expect(s.getByTestId("workspace-folder-path")).toHaveText(new RegExp(`/workspaces/${shop}$`));
  await expect(s.getByTestId("workspace-folder-kind")).toHaveText("kept by the app");

  // What a thread writes in the workspace's folder shows up (the daemon re-reads it after a turn).
  await mockPost(`workspace-files?workspace=${shop}&instructions=AGENTS.md&skills=lint,docs`);
  await expect(s.getByTestId("workspace-instructions-label")).toHaveText("AGENTS.md");
  await expect(s.getByTestId("workspace-instructions-path")).toHaveText(/\/AGENTS\.md$/);
  await expect(s.getByTestId("workspace-instructions-open")).toHaveText("View");
  await expect(s.getByTestId("workspace-edit-instructions")).toHaveText("Edit instructions");
  await expect(s.getByTestId("workspace-skills-list")).toHaveText("docs, lint");

  // Browse marketplace: Settings → Skills.
  await s.getByTestId("workspace-browse-skills").click();
  await expect(page.getByTestId("settings-page")).toBeVisible();
  await expect(page.getByTestId("settings-nav-skills")).toHaveAttribute("aria-current", "page");
});

test("a rooted workspace: its folder row (the root, where threads start, marked missing when moved), the root's instructions open as a File tab", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await openApp(page);
  await openWorkspacePage(page, mono);
  const m = body(page, mono);
  await expect(m).toHaveAttribute("data-rooted", "true");
  const folder = m.getByTestId("workspace-folder");
  await expect(folder).toHaveAttribute("data-default", "true");
  await expect(folder).toContainText("Workspace folder");
  await expect(folder.getByTestId("workspace-default")).toHaveText("starts here");
  await expect(folder.getByTestId("workspace-root")).toHaveText("~/mono");
  await expect(m.getByTestId("member-caption")).toHaveText(["origin · not GitHub"]);
  await expect(m.getByTestId("workspace-instructions")).toHaveAttribute("data-file", "/Users/dev/mono/CLAUDE.md");
  await expect(m.getByTestId("workspace-instructions-path")).toHaveText("~/mono/CLAUDE.md");
  await expect(m.getByTestId("workspace-skills-list")).toHaveText("demo, release");
  await expect(m.getByTestId("workspace-folder-path")).toHaveText("~/mono");
  await expect(m.getByTestId("workspace-folder-kind")).toHaveText("its root");

  await m.getByTestId("workspace-instructions-open").click();
  const panel = page.getByTestId("side-panel");
  // The workspace's page has its own panel.
  await expect(panel).toHaveAttribute("data-panel-key", `view:projects:workspace:${mono}`);
  await expect(panel.getByRole("tab", { selected: true })).toHaveText("CLAUDE.md");

  // A root that moved is marked missing (workspace set-root repairs it).
  await expect(m.getByTestId("workspace-root-missing")).toHaveCount(0);
  await mockPost(`workspace-files?workspace=${mono}&rootMissing=1`);
  await expect(m.getByTestId("workspace-root-missing")).toHaveText("missing");
  await expect(m.getByTestId("workspace-root")).toHaveAttribute("data-missing", "true");
});

test("Start here: a project, or a rooted workspace's folder; the row that starts threads has no Start here", async ({ page }) => {
  const { shop } = await twoWorkspaces();
  const rooted = (await mockPost("workspace?name=rooted&projects=repo-cf&root=/Users/dev/rooted&primary=repo-cf")) as { id: string };
  await openApp(page);
  await openWorkspacePage(page, shop);
  const cf = member(page, shop, "repo-cf");
  const gp = member(page, shop, "repo-gp");
  await expect(gp.getByTestId("member-make-default")).toHaveCount(0);
  // Hidden at rest, shown on hover.
  await expect(cf.getByTestId("member-actions")).toHaveCSS("opacity", "0");
  await cf.hover();
  await expect(cf.getByTestId("member-actions")).toHaveCSS("opacity", "1");
  await expect(cf.getByTestId("member-make-default")).toHaveText("Start here");
  await cf.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "repo-cf", workspace: shop });
  await expect(body(page, shop).locator('[data-testid="workspace-member"][data-default]')).toHaveAttribute("data-project", "repo-cf");
  await expect(cf.getByTestId("member-make-default")).toHaveCount(0);

  await openWorkspacePage(page, rooted.id);
  const folder = body(page, rooted.id).getByTestId("workspace-folder");
  await expect(folder).not.toHaveAttribute("data-default");
  await folder.hover();
  await folder.getByTestId("member-make-default").click();
  expect((await lastInvocation("workspace.set-primary"))?.args).toEqual({ primary: "workspace", workspace: rooted.id });
  await expect(folder).toHaveAttribute("data-default", "true");
  await expect(body(page, rooted.id).locator('[data-testid="workspace-member"][data-default]')).toHaveCount(0);
});

// Add project and Remove, Open in Finder, rename, Remove workspace, New workspace, Edit instructions' steer and toast, a project named “workspace”, members by name and the keyboard: unit-tested in src/components/projects/WorkspacePage.test.tsx.

test("the Threads table: one column per member with its checkout, working first, archived only counted; a click opens the thread; the row menu", async ({ page }) => {
  const ws = (await mockPost("workspace?name=platform&projects=repo-cf,repo-gp,repo-wr&primary=repo-cf")) as { id: string };
  const idle = (await mockPost(`workspace-thread?workspace=${ws.id}&name=helper&status=idle`)) as { id: string; worktreePath: string };
  const driver = (await mockPost(`workspace-thread?workspace=${ws.id}&name=driver&status=busy`)) as { id: string; worktreePath: string };
  await mockPost(`thread/hold?id=${driver.id}&id=${idle.id}`);
  const gone = (await mockPost(`workspace-thread?workspace=${ws.id}&name=old`)) as { id: string };
  await mockPost(`thread/archive?id=${gone.id}`);
  // The threads share the branch cf/platform, so the same worktrees; ghostty-playground's has two files changed.
  const gpPath = "/Users/dev/.code-foundry/worktrees/alexwaumann/ghostty-playground/cf-platform";
  await mockPost(`worktree/dirty?path=${encodeURIComponent(gpPath)}&modified=2`);
  await openApp(page);
  await openWorkspacePage(page, ws.id);
  const b = body(page, ws.id);
  await expect(b.getByTestId("workspace-threads-title")).toHaveText(/Threads\s*· 1 working · 1 idle · 1 archived/);
  await expect(b.getByTestId("threads-head")).toHaveText(/Branch\s*Thread\s*code-foundry\s*ghostty-playground\s*writing/);
  // Working first; the archived one is not listed.
  await expect(b.getByTestId("workspace-thread")).toHaveCount(2);
  await expect(b.getByTestId("thread-name-status")).toHaveText([/driver\s*·\s*working/, /helper\s*·\s*idle/]);
  const d = threadRow(page, ws.id, driver.id);
  await expect(d.getByTestId("thread-branch")).toHaveText("cf/platform");
  await expect(d.locator('[data-live="true"]')).toHaveCount(1);
  await expect(d.getByTestId("thread-member-state")).toHaveText(["clean · no commits yet", "2 files · no commits yet", "folder · no git"]);

  // A project added to the workspace later is not in the thread's set.
  await b.getByTestId("workspace-add-member").click();
  await page.getByTestId("workspace-add-member-list").getByRole("option", { name: "dotfiles" }).click();
  await expect(d.locator('[data-testid="thread-member-state"][data-project="repo-dot"]')).toHaveText("not in this thread");
  await expect(b.getByTestId("threads-col-member")).toHaveText(["code-foundry", "dotfiles", "ghostty-playground", "writing"]);

  // The row menu: each git member's changes, Finder, the path.
  await d.hover();
  await d.getByTestId("thread-more").click();
  expect(await menuItems(page, "thread-more")).toEqual(["Show changes in code-foundry", "Show changes in ghostty-playground", "Open in Finder", "Copy path"]);
  await page.getByTestId("thread-more-menu").getByText("Show changes in ghostty-playground").click();
  await expect(page.getByTestId("changes-surface")).toHaveAttribute("data-path", gpPath);
  await expect(page.getByTestId("projects-page")).toHaveAttribute("data-page", "workspace");
  await d.hover();
  await d.getByTestId("thread-more").click();
  await page.getByTestId("thread-menu-reveal").click();
  const reveal = await lastInvocation("worktree.reveal");
  expect(reveal?.args).toEqual({ worktree: driver.worktreePath });
  expect(reveal?.context).toMatchObject({ activeProjectId: "repo-cf", activeWorktreePath: driver.worktreePath });

  // Its chevron opens the thread; so do a click and Enter on the row.
  await d.hover();
  await expectTooltip(page, d.getByTestId("thread-open"), "Open thread");
  await d.getByTestId("thread-open").click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", driver.id);
  await openWorkspacePage(page, ws.id);
  await threadRow(page, ws.id, idle.id).click();
  await expect(page.getByTestId("thread-pane")).toHaveAttribute("data-thread-id", idle.id);
});

test("Write instructions starts a thread in the workspace's folder, then Edit instructions steers it", async ({ page }) => {
  const { mono } = await twoWorkspaces();
  await mockPost(`workspace-files?workspace=${mono}&instructions=`);
  await openApp(page);
  await openWorkspacePage(page, mono);
  const m = body(page, mono);
  await expect(m.getByTestId("workspace-instructions-reach")).toHaveText("(starts a thread)");
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
  await expect(m.getByTestId("workspace-instructions-reach")).toHaveText(/^\(sends to /);
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

test("an unregistered member reads “not registered” and opens nothing; a registered one shows its main checkout's changes", async ({ page }) => {
  const ws = (await mockPost("workspace?name=sk&projects=repo-sk,repo-cf")) as { id: string };
  await openApp(page);
  await openProjectPage(page, "repo-sk");
  await page.getByTestId("project-more").click();
  await page.getByTestId("project-unregister").click();
  await page.getByTestId("confirm-dialog").getByTestId("confirm-ok").click();
  await expect(page.locator('[data-nav-key="p:repo-sk"]')).toHaveCount(0);
  await openWorkspacePage(page, ws.id);
  const sk = member(page, ws.id, "repo-sk");
  await expect(sk.getByTestId("workspace-member")).toHaveAttribute("data-unregistered", "true");
  await expect(sk).toContainText("not registered");
  await sk.dblclick();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("side-panel").getByRole("tab", { name: /repo-sk/ })).toHaveCount(0);
  await member(page, ws.id, "repo-cf").dblclick();
  await expect(page.getByTestId("side-panel").getByRole("tab", { selected: true })).toHaveText("Changes · code-foundry");
});
