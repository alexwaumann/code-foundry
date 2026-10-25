import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { expectTooltip, freshCopyByDefault, invocations, mockPost, mockUrl, openApp, openTooltip, resetMock, row } from "./fixtures";

/**
 * Workspaces v2, fuzz round D fixes for the composer and sidebar
 * (docs/notes/workspaces-v2-fix-4-composer.md): an emptied workspace set, a like with the
 * workspace folder, folder-only sets in place, cmd+N on a project resets an empty draft,
 * Save as workspace in a workspace folder, the like headings and labels, a like draft whose
 * thread is removed, the menus' and palette's rules, deduped hints, the header chip.
 */

interface ThreadSummary {
  id: string;
  name: string;
  projectId: string;
  projectIds: string[];
  workspaceId: string;
}

async function threads(): Promise<ThreadSummary[]> {
  const res = await fetch(`${mockUrl}/__mock/threads`);
  return (await res.json()) as ThreadSummary[];
}

async function invoke(name: string, args: Record<string, string>, context: Record<string, string> = {}): Promise<{ message?: string; resultJson?: string }> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.CommandService/Invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify({ name, context, args, confirmed: true }),
  });
  expect(res.ok, `${name}: ${await res.clone().text()}`).toBe(true);
  return (await res.json()) as { message?: string; resultJson?: string };
}

async function invokedArgs(name: string): Promise<Record<string, string>[]> {
  return (await invocations()).filter((i) => i.name === name).map((i) => i.args);
}

async function lastInvoked(name: string): Promise<Record<string, string>> {
  await expect.poll(async () => (await invokedArgs(name)).length).toBeGreaterThan(0);
  return (await invokedArgs(name)).at(-1) ?? {};
}

function chips(page: Page) {
  return page.getByTestId("composer-member");
}

async function composeIn(page: Page, n: number): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
  await page.keyboard.press(`Meta+${String(n)}`);
  await expect(page.getByTestId("composer-input")).toBeFocused();
}

async function pickWorkspaceInHeading(page: Page, workspaceId: string): Promise<void> {
  await page.getByTestId("composer-project-trigger").click();
  const list = page.getByTestId("composer-project-list");
  await list.locator(`[data-workspace="${workspaceId}"]`).click();
  await page.keyboard.press("Escape");
  await expect(list).toHaveCount(0);
}

async function selectedThreadId(page: Page): Promise<string> {
  const created = page.locator('[data-row-kind="thread"][aria-selected="true"]');
  await expect(created).toBeVisible();
  return ((await created.getAttribute("data-row-key")) ?? "").slice(2);
}

async function openPaletteFor(page: Page, query: string) {
  await page.keyboard.press("Meta+k");
  await expect(page.getByTestId("palette")).toBeVisible();
  await page.keyboard.type(query);
  return page.getByTestId("palette").getByRole("option");
}

test.beforeEach(async () => {
  await resetMock();
});

test("1: taking out every project of a picked workspace drops it too; nothing sends until a project is picked", async ({ page }) => {
  await mockPost("workspace?name=shop&projects=repo-cf,repo-dot");
  await openApp(page);
  await composeIn(page, 1);
  await pickWorkspaceInHeading(page, "w-000000000001");
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await expect(chips(page)).toHaveCount(2);
  await chips(page).filter({ hasText: "code-foundry" }).getByTestId("composer-member-remove").click();
  await chips(page).filter({ hasText: "dotfiles" }).getByTestId("composer-member-remove").click();

  // The empty state: no workspace chip, no projects, nothing to run in, send disabled.
  await expect(page.getByTestId("composer-heading")).toHaveText("Pick a project");
  await expect(page.getByTestId("composer-workspace")).toHaveCount(0);
  await expect(chips(page)).toHaveCount(0);
  await expect(page.getByTestId("composer-empty-note")).toHaveText("Pick a project or a workspace to start the thread in.");
  await expect(page.getByTestId("composer-worktree")).toHaveCount(0);
  await expect(page.getByTestId("composer-primary")).toHaveCount(0);
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Ship it");
  await expect(page.getByTestId("composer-send")).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  expect(await invokedArgs("thread.new")).toEqual([]);

  // A project picked: the set again, sent without the workspace.
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "ghostty-playground" }).click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in ghostty-playground?");
  await expect(page.getByTestId("composer-send")).toBeEnabled();
  await page.getByTestId("composer-input").click();
  await page.keyboard.press("Enter");
  const args = await lastInvoked("thread.new");
  expect(args).toMatchObject({ project: "repo-gp", prompt: "Ship it" });
  expect(args).not.toHaveProperty("workspace");
  expect(args).not.toHaveProperty("projects");
});

test("2, 7, 8, 14, 15: New thread on this branch in place: heading, Workspace folder as the primary, the read-only pill's role", async ({ page }) => {
  await mockPost("workspace?name=shop&projects=repo-cf,repo-gp");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&workspace=shop&name=Shop%20member")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click({ button: "right" });
  await page.getByTestId("row-menu").getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  // In place: no branch form; the workspace's name.
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next in shop?");
  const pill = page.getByTestId("composer-like-mode");
  await expect(pill).toHaveText("In place");
  await expect(pill).toHaveClass(/\btext-body-sm\b/);
  await expect(pill.locator(".font-mono")).toHaveCount(0);

  const primary = page.getByTestId("composer-primary");
  await expect(primary).toHaveText("code-foundry");
  await primary.click();
  const options = page.getByTestId("composer-primary-list").getByRole("option");
  await expect(options).toHaveText([/^Workspace folder\s*shop's folder$/, /^code-foundry/, /^ghostty-playground/]);
  await options.first().click();
  await expect(primary).toHaveText("Workspace folder");

  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Write the shop notes");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new-like")).toMatchObject({ id: t.id, project: "workspace", prompt: "Write the shop notes" });
  const id = await selectedThreadId(page);
  expect(id).not.toBe(t.id);
  expect((await threads()).find((x) => x.id === id)).toMatchObject({ projectId: "", workspaceId: "w-000000000001" });
  await expect(row(page, `s:${id}`).getByTestId("row-project")).toHaveText("shop");

  // 6: its tooltip names the workspace, never its w-<id>.
  await page.mouse.move(0, 0);
  await row(page, `s:${id}`).hover();
  await expect(openTooltip(page).getByTestId("tip-project")).toHaveText("shop");
  await page.mouse.move(0, 0);
});

test("2: a single-project like reads the project's name; a branch keeps the branch form", async ({ page }) => {
  const solo = (await mockPost("set-thread?projects=repo-cf&name=Solo")) as ThreadSummary;
  const wt = (await mockPost("set-thread?projects=repo-cf,repo-gp&branch=feat/parser&name=Parser")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${solo.id}`).click({ button: "right" });
  await page.getByTestId("row-menu").getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next in code-foundry?");
  await row(page, `s:${wt.id}`).click({ button: "right" });
  await page.getByTestId("row-menu").getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What's next on feat/parser?");
  // Mono for the branch only.
  await expect(page.getByTestId("composer-like-mode")).toHaveText("On feat/parser");
  await expect(page.getByTestId("composer-like-mode").locator(".font-mono")).toHaveText("feat/parser");
});

test("3: a set without a git project offers no fresh copies and says it runs in place", async ({ page }) => {
  await freshCopyByDefault();
  await mockPost("workspace?name=folders&projects=repo-wr");
  await mockPost("workspace?name=zero&root=/Users/dev/zero");
  await openApp(page);

  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-workspace="w-000000000001"]').click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in folders?");
  await expect(page.getByTestId("composer-worktree")).toHaveText("In place");
  await expect(page.getByTestId("composer-nogit-note")).toHaveText("No git repository in this set: it runs in place");
  await page.getByTestId("composer-worktree").click();
  await expect(page.getByTestId("composer-worktree-list").getByRole("option")).toHaveText([/^Each project's own folder/]);
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Tidy the notes");
  await page.keyboard.press("Enter");
  expect(await lastInvoked("thread.new")).toMatchObject({ projects: "repo-wr", workspace: "w-000000000001", "new-worktree": "false" });
  await selectedThreadId(page);

  // A workspace without projects: its folder, in place, and no projects list at all.
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-workspace="w-000000000002"]').click();
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in zero?");
  await expect(page.getByTestId("composer-nogit-note")).toBeVisible();
  await expect(page.getByTestId("composer-worktree")).toHaveText("In place");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Plan the next quarter");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await invokedArgs("thread.new")).length).toBe(2);
  const args = await lastInvoked("thread.new");
  expect(args).toMatchObject({ project: "workspace", workspace: "w-000000000002", "new-worktree": "false" });
  expect(args).not.toHaveProperty("projects");
  await expect(page.getByTestId("composer-error")).toHaveCount(0);
});

test("4: cmd+N on a project with an empty draft starts from that project; a draft with text keeps its set", async ({ page }) => {
  await mockPost("workspace?name=shop&projects=repo-gp,repo-dot");
  await openApp(page);
  await composeIn(page, 1);
  await pickWorkspaceInHeading(page, "w-000000000001");
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await row(page, "s:s-1").click();
  await composeIn(page, 1);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in code-foundry?");
  await expect(page.getByTestId("composer-workspace")).toHaveCount(0);

  await pickWorkspaceInHeading(page, "w-000000000001");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Keep this");
  await row(page, "s:s-1").click();
  await composeIn(page, 1);
  // The typed draft keeps its set, and the heading says which.
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in shop?");
  await expect(page.getByTestId("composer-input")).toHaveText("Keep this");
});

test("5: no Save as workspace for a thread in its workspace's folder", async ({ page }) => {
  await mockPost("workspace?name=docs&projects=repo-cf,repo-gp");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp,repo-wr&project=workspace&workspace=docs&name=Docs")) as ThreadSummary;
  const plain = (await mockPost("set-thread?projects=repo-cf,repo-gp,repo-wr&name=Plain")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  await page.getByTestId("pane-thread-menu").click();
  await expect(page.getByTestId("pane-thread-menu-items").getByRole("menuitem")).toHaveText(["New thread on this branch"]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pane-thread-menu-items")).toHaveCount(0);
  // The same set outside the folder is offered it.
  await row(page, `s:${plain.id}`).click();
  await page.getByTestId("pane-thread-menu").click();
  await expect(page.getByTestId("pane-thread-menu-items").getByRole("menuitem")).toHaveText(["New thread on this branch", "Save as workspace"]);
});

test("9: a like draft whose thread is removed becomes a plain draft with the text, and says so", async ({ page }) => {
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&project=repo-gp&name=Src")) as ThreadSummary;
  await openApp(page);
  await row(page, `s:${t.id}`).click({ button: "right" });
  await page.getByTestId("row-menu").getByTestId("menu-new-like").click();
  await expect(page.getByTestId("composer")).toHaveAttribute("data-like", t.id);
  await page.keyboard.type("Carry on");
  await invoke("thread.remove", {}, { activeThreadId: t.id });
  await expect(page.getByText(`Thread Src was removed; starting fresh`)).toBeVisible();
  const composer = page.getByTestId("composer");
  await expect(composer).not.toHaveAttribute("data-like", /.+/);
  await expect(page.getByTestId("composer-heading")).toHaveText("What should we build in 2 projects?");
  await expect(page.getByTestId("composer-input")).toHaveText("Carry on");
  await expect(chips(page)).toHaveCount(2);
  await expect(page.getByTestId("composer-primary")).toHaveText("ghostty-playground");
  await expect(page.getByTestId("composer-worktree")).toHaveText("In place");
});

test("10: New thread on this branch and Run in… only where they apply, in the menus and the palette", async ({ page }) => {
  await mockPost("workspace?name=zero&root=/Users/dev/zero");
  const inZero = (await mockPost("set-thread?projects=&project=workspace&workspace=zero&name=Zero")) as ThreadSummary;
  const two = (await mockPost("set-thread?projects=repo-cf,repo-gp&name=Two")) as ThreadSummary;
  const home = JSON.parse((await invoke("thread.new", { "no-project": "true", focus: "false", name: "Homeless", prompt: "hi" }, { activeView: "compose" })).resultJson ?? "{}") as { id: string };
  await openApp(page);

  // No project: no New thread on this branch anywhere.
  await row(page, `s:${home.id}`).click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(page.getByTestId("row-menu").getByTestId("menu-new-like")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row(page, `s:${home.id}`).click();
  let opts = await openPaletteFor(page, "New thread on this branch");
  await expect(opts.filter({ hasText: "New thread on this branch" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // A workspace without projects, in its folder: nowhere else to run.
  await row(page, `s:${inZero.id}`).click({ button: "right" });
  await expect(page.getByTestId("row-menu")).toBeVisible();
  await expect(page.getByTestId("menu-run-in")).toHaveCount(0);
  await expect(page.getByTestId("row-menu").getByTestId("menu-new-like")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await row(page, `s:${inZero.id}`).click();
  opts = await openPaletteFor(page, "Run Thread In");
  await expect(opts.filter({ hasText: "Run Thread In" })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Two projects: both, the Run in… item labelled for the folder only with a workspace.
  await row(page, `s:${two.id}`).click();
  opts = await openPaletteFor(page, "Run Thread In");
  await expect(opts.filter({ hasText: "Run Thread In" })).toHaveCount(1);
  await page.keyboard.press("Escape");
  await row(page, `s:${two.id}`).click({ button: "right" });
  await expect(page.getByTestId("menu-run-in")).toHaveCount(1);
  await expect(page.getByTestId("row-menu").getByTestId("menu-new-like")).toHaveCount(1);
});

test("11, 13: the hints shown under the chips are not toasted again; a chip's tooltip is its path", async ({ page }) => {
  await mockPost("set-thread?projects=repo-sk,repo-wr&name=Busy%20one");
  await openApp(page);
  await page.keyboard.press("Meta+n");
  await page.getByTestId("palette").locator('[data-project="repo-sk"]').click();
  await page.getByTestId("composer-add-project").click();
  await page.getByTestId("composer-add-project-list").getByRole("option").filter({ hasText: "writing" }).click();
  await expect(page.getByTestId("composer-hint")).toHaveText(["sketches @ main is also open in Busy one", "writing is also open in Busy one"]);
  await expectTooltip(page, chips(page).filter({ hasText: "sketches" }).getByTestId("composer-member-body"), "~/src/sketches");
  await page.getByTestId("composer-input").click();
  await page.keyboard.type("Pair on the parser");
  await page.keyboard.press("Enter");
  await selectedThreadId(page);
  await page.waitForTimeout(500);
  await expect(page.getByText(/is also open in Busy one \(s-set-/)).toHaveCount(0);
});

test("12: the thread header's workspace chip opens the Projects page on that workspace's card", async ({ page }) => {
  for (const name of ["a1", "a2", "a3", "a4", "a5"]) await mockPost(`workspace?name=${name}&projects=repo-cf,repo-gp,repo-dot`);
  await mockPost("workspace?name=shop&projects=repo-cf,repo-gp");
  const t = (await mockPost("set-thread?projects=repo-cf,repo-gp&workspace=shop&name=Shop")) as ThreadSummary;
  await page.setViewportSize({ width: 1100, height: 640 });
  await openApp(page);
  await row(page, `s:${t.id}`).click();
  const chip = page.getByTestId("pane-workspace");
  await expect(chip).toHaveText("shop");
  await chip.click();
  await expect(page.getByTestId("projects-page")).toBeVisible();
  const header = page.locator('[data-nav-key="ws:w-000000000006"]');
  await expect(header).toHaveAttribute("aria-selected", "true");
  await expect(header).toBeInViewport();
});

test("16: cmd+N from a new-thread composer's prompt opens the project picker", async ({ page }) => {
  await openApp(page);
  await composeIn(page, 1);
  await page.keyboard.press("Meta+n");
  await expect(page.getByTestId("palette")).toHaveAttribute("data-mode", "projects");
});
