import { expect, test, type Page } from "@playwright/test";
import { expectProjectRevealed, invocations, listProjects, mockPost, mockUrl, openAddProjectDialog, openApp, projectAt, resetMock } from "./fixtures";

// The Add Project dialog's folder-of-repos scan (docs/notes/workspaces-v2-6-scan.md): a
// folder that is not a git repository but has git repositories directly inside it asks
// how to add it, as a workspace (project.add-workspace) or as one plain project. The mock's
// ~/product holds web, api and docs-site (git) and notes (plain).

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

interface WorkspaceRow {
  id: string;
  name: string;
  rootPath?: string;
  members?: string[];
  defaultPrimary?: string;
}

/** The mock's workspaces (GET /__mock/workspaces), members as sorted project ids. */
async function listWorkspaces(): Promise<WorkspaceRow[]> {
  const res = await fetch(`${mockUrl}/__mock/workspaces`);
  expect(res.ok).toBe(true);
  // Members are project ids since the v2 workspace model (docs/notes/workspaces-v2-4-projects-page.md).
  const list = (await res.json()) as WorkspaceRow[];
  return list.map((w) => ({ id: w.id, name: w.name, rootPath: w.rootPath, defaultPrimary: w.defaultPrimary, members: [...(w.members ?? [])].sort() }));
}

async function askAbout(page: Page, path: string) {
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  await input.fill(path);
  await page.keyboard.press("Enter");
  const choice = page.getByTestId("add-project-choice");
  await expect(choice).toBeVisible();
  return choice;
}

test("a folder of repos asks how to add it; Add as workspace is the default", async ({ page }) => {
  await openApp(page);
  const before = await listProjects();
  const choice = await askAbout(page, "product");

  // Two short buttons, one line beside each; the workspace one has the focus.
  await expect(page.getByTestId("add-project-choice-heading")).toHaveText("~/product has 3 git repositories inside.");
  const asWorkspace = page.getByTestId("add-project-as-workspace");
  const asProject = page.getByTestId("add-project-as-project");
  await expect(asWorkspace).toHaveText("Add as workspace");
  await expect(asProject).toHaveText("Add as project");
  await expect(page.getByTestId("add-project-as-workspace-line")).toHaveText(
    "The 3 repos inside become projects; this folder is their shared root for instructions and skills.",
  );
  await expect(page.getByTestId("add-project-as-project-line")).toHaveText("One folder. No git features for the repos inside.");
  await expect(asWorkspace).toBeFocused();
  // The folder list and the plain Add project button make way; nothing is added yet.
  await expect(page.getByTestId("add-project-local-submit")).toHaveCount(0);
  await expect(page.getByTestId("path-entry")).toBeHidden();
  await expect(choice).toHaveAttribute("data-repos", "3");
  expect(await listProjects()).toHaveLength(before.length);

  // Enter takes the default.
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  const added = (await invocations()).filter((i) => i.name === "project.add-workspace");
  expect(added.map((i) => i.args)).toEqual([{ folder: "~/product" }]);

  // The three repos are projects (git), the plain child is not, nor the folder itself.
  for (const name of ["web", "api", "docs-site"]) expect(await projectAt(`/Users/dev/product/${name}`)).toMatchObject({ name, git: true });
  expect(await projectAt("/Users/dev/product/notes")).toBeUndefined();
  expect(await projectAt("/Users/dev/product")).toBeUndefined();
  const ids = (await listProjects()).filter((p) => p.path.startsWith("/Users/dev/product/")).map((p) => p.id).sort();
  const ws = (await listWorkspaces()).find((w) => w.name === "product");
  expect(ws).toMatchObject({ rootPath: "/Users/dev/product", defaultPrimary: "workspace", members: ids });

  // The Projects page shows it.
  await expect(page.getByTestId("projects-page")).toBeVisible();
  await expect(page.locator(`[data-testid="workspace"][data-workspace="${ws?.id ?? ""}"]`).getByTestId("workspace-name")).toHaveText("product");

  // Again: the projects are reused and the name is taken, so "product 2".
  await askAbout(page, "product/");
  await page.getByTestId("add-project-as-workspace").click();
  await expect(dialog(page)).toHaveCount(0);
  expect((await listWorkspaces()).map((w) => w.name).sort()).toEqual(["product", "product 2"]);
  expect((await listProjects()).filter((p) => p.path.startsWith("/Users/dev/product/"))).toHaveLength(3);
});

test("Add as project adds the folder as one plain project", async ({ page }) => {
  await openApp(page);
  await askAbout(page, "product");
  await page.getByTestId("add-project-as-project").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/product")).toMatchObject({ name: "product", git: false });
  expect(await projectAt("/Users/dev/product/web")).toBeUndefined();
  expect(await listWorkspaces()).toEqual([]);
  expect((await invocations()).filter((i) => i.name === "project.add-workspace")).toEqual([]);
  await expectProjectRevealed(page, "product");
});

test("editing the path drops the question; repos and plain folders add at once", async ({ page }) => {
  await openApp(page);
  await askAbout(page, "product");
  const input = page.getByTestId("add-project-local-input");
  await input.fill("product/notes");
  await expect(page.getByTestId("add-project-choice")).toHaveCount(0);
  await expect(page.getByTestId("add-project-local-submit")).toBeVisible();

  // A plain folder without repos inside: added as before, no question.
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/product/notes")).toMatchObject({ name: "notes", git: false });

  // A repository (with plain folders inside): added as before.
  await openAddProjectDialog(page);
  await input.fill("src/new-app");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/new-app")).toMatchObject({ name: "new-app", git: true });
  expect(await listWorkspaces()).toEqual([]);
});

test("a repository that cannot be added shows the daemon's error in place", async ({ page }) => {
  await openApp(page);
  await askAbout(page, "mixed");
  await expect(page.getByTestId("add-project-choice-heading")).toHaveText("~/mixed has 2 git repositories inside.");
  await page.getByTestId("add-project-as-workspace").click();
  await expect(page.getByTestId("add-project-choice-error")).toContainText("could not add 1 of 2 repositories in /Users/dev/mixed (broken: permission denied)");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("add-project-as-workspace")).toBeEnabled();
  expect(await listWorkspaces()).toEqual([]);
});

test("Escape on the two choices goes back to the path as typed; Escape again closes the dialog", async ({ page }) => {
  await openApp(page);
  await askAbout(page, "product");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByTestId("add-project-choice")).toHaveCount(0);
  const input = page.getByTestId("add-project-local-input");
  await expect(input).toHaveValue("product");
  await expect(input).toBeFocused();
  await expect(page.getByTestId("add-project-local-submit")).toBeVisible();
  // Enter asks again.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-choice")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await listWorkspaces()).toEqual([]);
});

test("after Add as workspace the new card is the Projects page's cursor row, scrolled into view", async ({ page }) => {
  // Enough workspaces before it that it would sit below the fold.
  for (const name of ["a1", "a2", "a3", "a4", "a5", "a6"]) await mockPost(`workspace?name=${name}&projects=repo-cf,repo-gp,repo-dot`);
  await page.setViewportSize({ width: 1100, height: 640 });
  await openApp(page);
  await askAbout(page, "product");
  await page.getByTestId("add-project-as-workspace").click();
  await expect(dialog(page)).toHaveCount(0);
  const ws = (await listWorkspaces()).find((w) => w.name === "product");
  const header = page.locator(`[data-nav-key="ws:${ws?.id ?? ""}"]`);
  await expect(header).toHaveAttribute("aria-selected", "true");
  await expect(header).toBeInViewport();
});
