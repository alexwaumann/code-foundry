import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockUrl, openApp, openProjects, resetMock, row, selectProject } from "./fixtures";

// Add-project PR 4: the Add Project dialog's New tab (repo.create, then optionally
// repo.github.publish) and the overview's Publish to GitHub dialog, against the mock's
// owners (mock/create.ts): "dev" (Public/Private), "octo-org" (known: Public and
// Internal), "acme" (policy unknown: all three). Publishing a repository named "taken"
// fails like gh. docs/notes/add-project-4-create.md.

const PROJECTS = "/Users/dev/.code-foundry/projects";
const GH_NAME_TAKEN = "GraphQL: Name already exists on this account (createRepository)";

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

async function projectCalls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/projects/calls`);
  return (await res.json()) as string[];
}

async function lastInvocation(name: string) {
  return (await invocations()).filter((i) => i.name === name).at(-1);
}

async function openNew(page: Page) {
  await openApp(page);
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-new").click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "new");
  const name = page.getByTestId("add-project-new-name");
  await expect(name).toBeFocused();
  return name;
}

async function pickOwner(page: Page, login: string) {
  await page.getByTestId("publish-owner").click();
  await page.locator(`[data-testid="publish-owner-option"][data-login="${login}"]`).click();
  await expect(page.getByTestId("publish-owner")).toHaveAttribute("data-owner", login);
}

/** The offered visibilities, in order, and the selected one. */
async function expectVisibilities(page: Page, offered: string[], selected: string) {
  await expect(page.getByTestId("publish-visibility").getByRole("radio")).toHaveText(offered);
  await expect(page.getByTestId("publish-visibility")).toHaveAttribute("data-value", selected);
  await expect(page.getByTestId(`publish-visibility-${selected}`)).toHaveAttribute("aria-checked", "true");
}

test("New: the name is checked as typed, Create makes the project and opens it", async ({ page }) => {
  const name = await openNew(page);
  await expect(page.getByTestId("add-project-create")).toBeDisabled();
  await expect(page.getByTestId("add-project-new-dest")).toHaveText("~/.code-foundry/projects/<name>");

  const refused: [string, string][] = [
    [".hidden", "cannot start with"],
    ["a/b", "letters, digits"],
    ["two words", "letters, digits"],
  ];
  for (const [bad, why] of refused) {
    await name.fill(bad);
    await expect(page.getByTestId("add-project-new-error")).toContainText(why);
  }
  // A refused name never reaches the daemon.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-new-error")).toBeVisible();
  expect(await projectCalls()).toEqual([]);

  await name.fill("my-app");
  await expect(page.getByTestId("add-project-new-error")).toHaveCount(0);
  await expect(page.getByTestId("add-project-new-dest")).toHaveText("~/.code-foundry/projects/my-app");
  await expect(page.getByTestId("add-project-create")).toHaveText("Create project");
  await page.getByTestId("add-project-create").click();

  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("my-app@main");
  // A new project has no remote: the overview offers to publish it.
  await expect(page.getByTestId("publish-github")).toBeVisible();
  expect((await lastInvocation("repo.create"))?.args).toEqual({ name: "my-app" });
  expect(await lastInvocation("repo.github.publish")).toBeUndefined();

  // The same name again is AlreadyExists, shown under the name.
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-new").click();
  await page.getByTestId("add-project-new-name").fill("my-app");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-new-error")).toContainText(`${PROJECTS}/my-app already exists`);
  await expect(dialog(page)).toBeVisible();
});

test("New with publish to octo-org: Public by default, Private not offered", async ({ page }) => {
  const name = await openNew(page);
  await name.fill("octo-app");
  await page.getByTestId("add-project-new-publish").check();

  // The viewer's own account first: Public and Private, Public selected.
  await expect(page.getByTestId("publish-owner")).toHaveAttribute("data-owner", "dev");
  await expectVisibilities(page, ["Public", "Private"], "public");
  await expect(page.getByTestId("publish-visibility-hint")).toHaveCount(0);

  await pickOwner(page, "octo-org");
  await expectVisibilities(page, ["Public", "Internal"], "public");
  await expect(page.getByTestId("publish-visibility-private")).toHaveCount(0);
  await expect(page.getByTestId("publish-visibility-hint")).toHaveCount(0);

  await expect(page.getByTestId("add-project-create")).toHaveText("Create and publish");
  await page.getByTestId("add-project-create").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("octo-app@main");
  // Published: origin on GitHub, so no Publish button any more.
  await expect(page.getByTestId("publish-github")).toHaveCount(0);
  expect((await lastInvocation("repo.github.publish"))?.args).toEqual({ repo: "repo-octo-app", owner: "octo-org", name: "octo-app", visibility: "public" });
  expect(await projectCalls()).toEqual(["create octo-app", "publish repo-octo-app octo-org/octo-app public"]);
});

test("an organization whose policy is unknown offers all three, Public by default", async ({ page }) => {
  const name = await openNew(page);
  await name.fill("acme-tool");
  await page.getByTestId("add-project-new-publish").check();
  await pickOwner(page, "acme");
  await expectVisibilities(page, ["Public", "Internal", "Private"], "public");
  await expect(page.getByTestId("publish-visibility-hint")).toContainText("does not show acme's repository policy");

  // A choice the owner allows survives switching owners; one it does not falls back.
  await page.getByTestId("publish-visibility-private").click();
  await expectVisibilities(page, ["Public", "Internal", "Private"], "private");
  await pickOwner(page, "octo-org");
  await expectVisibilities(page, ["Public", "Internal"], "public");
  await pickOwner(page, "acme");
  await page.getByTestId("publish-visibility-internal").click();
  await page.getByTestId("add-project-create").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await lastInvocation("repo.github.publish"))?.args).toMatchObject({ owner: "acme", visibility: "internal" });
});

test("a refused publish shows gh's error, keeps the picker, and the project exists", async ({ page }) => {
  const name = await openNew(page);
  await name.fill("taken");
  await page.getByTestId("add-project-new-publish").check();
  await expect(page.getByTestId("publish-owner")).toHaveAttribute("data-owner", "dev");
  await page.getByTestId("add-project-create").click();

  // gh's words, verbatim, under the picker; the dialog and picker stay.
  await expect(page.getByTestId("publish-error")).toHaveText(GH_NAME_TAKEN);
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("publish-picker")).toBeVisible();
  // Created locally regardless: the name is locked, Create became Publish.
  await expect(page.getByTestId("add-project-new")).toHaveAttribute("data-created", "repo-taken");
  await expect(page.getByTestId("add-project-new-created")).toContainText("Created taken");
  await expect(name).toBeDisabled();
  await expect(page.getByTestId("add-project-create")).toHaveText("Publish");
  const res = await fetch(`${mockUrl}/codefoundry.v1.RepoService/List`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: "{}",
  });
  const projects = (await res.json()) as { repos: { id: string; path: string }[] };
  expect(projects.repos.find((r) => r.id === "repo-taken")?.path).toBe(`${PROJECTS}/taken`);

  // Retrying publishes again (same refusal); Keep it local closes on the project.
  await page.getByTestId("add-project-create").click();
  await expect(page.getByTestId("publish-error")).toHaveText(GH_NAME_TAKEN);
  expect((await projectCalls()).filter((c) => c.startsWith("create"))).toEqual(["create taken"]);
  await page.getByTestId("add-project-keep-local").click();
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("taken@main");
  await expect(page.getByTestId("publish-github")).toBeVisible();
});

test("cancelling after a refused publish deletes the new project; Keep it local needs the publish step", async ({ page }) => {
  const name = await openNew(page);
  await name.fill("taken");
  // Without the publish step there is no Keep it local, and Create project has an icon.
  await expect(page.getByTestId("add-project-keep-local")).toHaveCount(0);
  await page.getByTestId("add-project-new-publish").check();
  await expect(page.getByTestId("publish-owner")).toHaveAttribute("data-owner", "dev");
  await page.getByTestId("add-project-create").click();
  await expect(page.getByTestId("publish-error")).toHaveText(GH_NAME_TAKEN);
  await expect(page.getByTestId("add-project-new")).toHaveAttribute("data-created", "repo-taken");
  await expect(page.getByTestId("add-project-keep-local")).toBeVisible();

  // Unchecking the publish step hides Keep it local; the primary becomes a bare Done.
  await page.getByTestId("add-project-new-publish").uncheck();
  await expect(page.getByTestId("add-project-keep-local")).toHaveCount(0);
  const done = page.getByTestId("add-project-create");
  await expect(done).toHaveText("Done");
  await expect(done.locator("svg")).toHaveCount(0);
  await page.getByTestId("add-project-new-publish").check();
  await expect(page.getByTestId("add-project-create")).toHaveText("Publish");
  await expect(page.getByTestId("add-project-create").locator("svg")).toHaveCount(1);

  // Cancelling (Escape) deletes the project again: repo.delete, confirmed, and it is gone.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(projectCalls).toEqual(["create taken", "publish repo-taken dev/taken public", "delete repo-taken"]);
  const del = await lastInvocation("repo.delete");
  expect(del).toMatchObject({ name: "repo.delete", args: { repo: "repo-taken" }, confirmed: true });
  const res = await fetch(`${mockUrl}/codefoundry.v1.RepoService/List`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: "{}",
  });
  const projects = (await res.json()) as { repos: { id: string }[] };
  expect(projects.repos.find((r) => r.id === "repo-taken")).toBeUndefined();
  await expect(page.getByText("Deleted taken")).toBeVisible();

  // The close button is the same cancel; nothing to delete this time.
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-new").click();
  await page.getByTestId("add-project-close").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await projectCalls()).filter((c) => c.startsWith("delete"))).toEqual(["delete repo-taken"]);
});

test("the overview's Publish to GitHub opens the publish dialog for sketches", async ({ page }) => {
  await openApp(page);
  await selectProject(page, "repo-sk");
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("sketches@main");
  await page.getByTestId("publish-github").click();
  const pub = page.getByTestId("publish-dialog");
  await expect(pub).toBeVisible();
  await expect(pub).toHaveAttribute("data-repo", "repo-sk");
  await expect(page.getByTestId("publish-name")).toHaveValue("sketches");
  await expect(page.getByTestId("publish-owner")).toHaveAttribute("data-owner", "dev");
  await expectVisibilities(page, ["Public", "Private"], "public");
  await expect(page.getByTestId("publish-slug")).toHaveText("dev/sketches");

  // A refusal (the name is taken on GitHub) shows gh's words and keeps the dialog.
  await page.getByTestId("publish-name").fill("taken");
  await page.getByTestId("publish-submit").click();
  await expect(page.getByTestId("publish-error")).toHaveText(GH_NAME_TAKEN);
  await expect(pub).toBeVisible();
  await expect(page.getByTestId("publish-submit")).toHaveText("Try again");

  await page.getByTestId("publish-name").fill("sketchbook");
  await pickOwner(page, "acme");
  await page.getByTestId("publish-visibility-private").click();
  await page.getByTestId("publish-submit").click();
  await expect(pub).toHaveCount(0);
  await expect(page.getByTestId("publish-github")).toHaveCount(0);
  expect((await lastInvocation("repo.github.publish"))?.args).toEqual({ repo: "repo-sk", owner: "acme", name: "sketchbook", visibility: "private" });
});

test("repo.github.publish in the palette opens the publish dialog; repo.create opens New", async ({ page }) => {
  await openApp(page);
  // A terminal in sketches gives the palette the project's context (the Projects page has none).
  await openProjects(page);
  const sk = page.locator('[data-nav-key="p:repo-sk"]');
  await sk.hover();
  await sk.getByTestId("project-new-terminal").click();
  await expect(page.getByTestId("terminal-host")).toBeVisible();
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await palette.locator('[data-command="repo.github.publish"]').click();
  await expect(page.getByTestId("publish-dialog")).toHaveAttribute("data-repo", "repo-sk");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("publish-dialog")).toHaveCount(0);

  // A project with origin does not offer it.
  await row(page, "s:s-1").click();
  await page.keyboard.press("Meta+k");
  await expect(palette.locator('[data-command="repo.github.publish"]')).toHaveCount(0);
  await palette.locator('[data-command="repo.create"]').click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "new");
});
