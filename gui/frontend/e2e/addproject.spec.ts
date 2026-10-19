import { expect, test, type Page } from "@playwright/test";
import { invocations, listProjects, mockUrl, openAddProjectDialog, openApp, openProjects, projectAt, resetMock } from "./fixtures";

// The Add Project dialog (project.add): its entry points, the tab order, the Local folder
// tab (ProjectService.Register with path completion; completion itself is e2e/paths.spec.ts),
// and the GitHub tab (lookup, search, clone with streamed progress) against the mock's
// GitHub (mock/clone.ts).

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

/** The mock's SearchGitHub / LookupGitHub / Clone calls, in order. */
async function githubCalls(): Promise<string[]> {
  const res = await fetch(`${mockUrl}/__mock/github/calls`);
  return (await res.json()) as string[];
}

async function openFromPalette(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette).toBeVisible();
  await palette.locator(`[data-command="${command}"]`).click();
  await expect(palette).toHaveCount(0);
}

async function openGitHub(page: Page) {
  await openApp(page);
  await openAddProjectDialog(page);
  await page.getByTestId("add-project-tab-github").click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  const input = page.getByTestId("add-project-github-input");
  await expect(input).toBeFocused();
  return input;
}

test("every entry point opens the dialog", async ({ page }) => {
  await openApp(page);

  // The palette has one "Add Project" (project.add), and no separate folder prompt.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await page.keyboard.type("add project");
  await expect(palette.locator('[data-command="project.add"]')).toContainText("Add Project");
  await expect(palette.getByText("Add Project (local folder)")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openFromPalette(page, "project.add");
  await expect(dialog(page)).toBeVisible();
  // Tabs are New, Local folder, GitHub; it opens on Local folder (New is e2e/create.spec.ts).
  await expect(page.getByTestId("add-project-tabs").getByRole("tab")).toHaveText(["New", "Local folder", "GitHub"]);
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // project.clone in the palette opens it on GitHub instead of prompting for a project.
  await openFromPalette(page, "project.clone");
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  await expect(page.getByTestId("add-project-github-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // The sidebar has no Add project button; New thread's project picker ends with
  // "Add a project…" under a border, which closes the picker and opens the dialog.
  await expect(page.getByTestId("sidebar-add-project")).toHaveCount(0);
  await page.getByTestId("sidebar-new-thread").click();
  const picker = page.getByTestId("palette");
  await expect(picker).toHaveAttribute("data-mode", "projects");
  const add = picker.locator("[cmdk-item]").last();
  await expect(add).toHaveAttribute("data-testid", "picker-add-project");
  await expect(add).toHaveText("Add a project…a folder on this Mac, or from GitHub");
  await expect(add).not.toHaveAttribute("data-selected", "true");
  await add.click();
  await expect(picker).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await page.keyboard.press("Escape");

  // The Projects page's Add project button.
  await openProjects(page);
  await page.getByTestId("projects-register").click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // None of them invoked anything: the dialog is the GUI presentation of project.add.
  expect((await invocations()).filter((i) => i.name.startsWith("project."))).toEqual([]);
});

test("Local folder: Tab completes, Enter adds, and the new project opens", async ({ page }) => {
  await openApp(page);
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  await expect(input).toBeFocused();

  // Nothing typed yet: Enter asks for a path and the dialog stays.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-local-message")).toContainText("Type a folder path");
  await expect(dialog(page)).toBeVisible();

  await input.fill("src/ne");
  await expect(page.getByTestId("path-entry")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("src/new-app/");
  await expect(page.getByTestId("path-entry").first()).toHaveAttribute("data-entry-name", "api");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  // ProjectService.Register, not a command: "~" expanded, the trailing slash dropped.
  expect(await projectAt("/Users/dev/src/new-app")).toMatchObject({ name: "new-app", git: true });
  expect((await invocations()).filter((i) => i.name.startsWith("project."))).toEqual([]);
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("new-app@main");
});

test("Local folder: a click opens a folder; only Enter and the button add", async ({ page }) => {
  await openApp(page);
  const before = (await listProjects()).length;
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  const message = page.getByTestId("add-project-local-message");
  const entry = (name: string) => page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));
  await expect(entry("src")).toBeVisible();
  await expect(message).toHaveText("Click or Tab opens a folder · Enter adds");

  // No "Add ~/..." row, and no folder highlighted until the keyboard or the mouse moves there.
  await expect(dialog(page).getByText(/^Add ~\//)).toHaveCount(0);
  await expect(page.getByTestId("add-project-local-typed")).toBeHidden();
  await expect(page.locator('[data-testid="path-entry"][data-selected="true"]')).toHaveCount(0);

  // A click opens the folder (clearing an error), and adds nothing.
  await page.keyboard.press("Enter");
  await expect(message).toContainText("Type a folder path");
  await entry("src").click();
  await expect(input).toHaveValue("src/");
  await expect(input).toHaveAttribute("data-path", "~/src/");
  await expect(input).toBeFocused();
  await expect(message).toHaveText("Click or Tab opens a folder · Enter adds");
  await expect(entry("new-app")).toBeVisible();

  // An already added folder opens the same way.
  await expect(entry("code-foundry")).toContainText("already added");
  await entry("code-foundry").click();
  await expect(input).toHaveAttribute("data-path", "~/src/code-foundry/");
  await expect(entry("docs")).toBeVisible();
  await expect(dialog(page)).toBeVisible();
  expect((await listProjects()).length).toBe(before);

  // The chevron shows on the highlighted (or hovered) row only.
  await page.mouse.move(0, 0);
  await page.keyboard.press("ArrowDown");
  const first = page.getByTestId("path-entry").first();
  await expect(first).toHaveAttribute("data-selected", "true");
  await expect(first.getByTestId("path-entry-open")).toHaveCSS("opacity", "1");
  await expect(page.getByTestId("path-entry").nth(1).getByTestId("path-entry-open")).toHaveCSS("opacity", "0");

  // Enter on a highlighted folder adds that folder.
  await input.fill("src/");
  await expect(entry("Website")).toBeVisible();
  await page.keyboard.press("End");
  await expect(entry("Website")).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/Website")).toMatchObject({ name: "Website", git: true });
});

test("Local folder: after a click, Enter adds the typed path, and so does the button", async ({ page }) => {
  await openApp(page);
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  const entry = (name: string) => page.getByTestId("path-entry").and(page.locator(`[data-entry-name="${name}"]`));

  // Enter with nothing highlighted: the typed path, not a folder in its listing.
  await entry("Documents").click();
  await expect(input).toHaveValue("Documents/");
  await expect(entry("Projects")).toBeVisible();
  await expect(page.locator('[data-testid="path-entry"][data-selected="true"]')).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/Documents")).toMatchObject({ name: "Documents", git: false });
  expect(await projectAt("/Users/dev/Documents/Projects")).toBeUndefined();

  // The button adds the typed path.
  await openAddProjectDialog(page);
  await entry("src").click();
  await entry("Notebook").click();
  await expect(input).toHaveAttribute("data-path", "~/src/Notebook/");
  await expect(dialog(page)).toBeVisible();
  await page.getByTestId("add-project-local-submit").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/Notebook")).toMatchObject({ name: "Notebook", git: false });
});

test("Local folder: a plain folder has no git, and a folder inside a project opens that project", async ({ page }) => {
  await openApp(page);
  const before = (await listProjects()).length;
  await openAddProjectDialog(page);
  const input = page.getByTestId("add-project-local-input");
  await input.fill("src/Notebook");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/src/Notebook")).toMatchObject({ name: "Notebook", git: false });

  // A folder that does not exist is refused in place.
  await openAddProjectDialog(page);
  await input.fill("src/nope");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-local-message")).toContainText("/Users/dev/src/nope: no such file or directory");

  // Inside an added repository: that repository, not a new project.
  await input.fill("src/code-foundry/src");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  expect((await listProjects()).length).toBe(before + 1);
});

test("GitHub: Enter looks up owner/repo and URLs; bad input is refused without a request", async ({ page }) => {
  const input = await openGitHub(page);

  // Typing sends nothing.
  await input.pressSequentially("alexwaumann/dotfiles");
  await expect(page.getByTestId("add-project-github-go")).toHaveText("Look up");
  await expect(page.getByTestId("add-project-github-selected")).toHaveCount(0);
  expect(await githubCalls()).toEqual([]);
  await page.keyboard.press("Enter");
  const card = page.getByTestId("add-project-github-selected");
  await expect(card).toHaveAttribute("data-slug", "alexwaumann/dotfiles");
  expect(await githubCalls()).toEqual(["lookup alexwaumann/dotfiles"]);
  await expect(card.getByTestId("add-project-clone-dest")).toHaveText("~/.code-foundry/projects/alexwaumann/dotfiles");
  await expect(card.getByTestId("add-project-clone")).toBeEnabled();
  await expect(card.getByTestId("add-project-github-back")).toHaveCount(0);

  // A URL in any case comes back in GitHub's spelling.
  await input.fill("https://github.com/OCTO-ORG/hello-world.git");
  await page.keyboard.press("Enter");
  await expect(card).toHaveAttribute("data-slug", "octo-org/Hello-World");

  await input.fill("octo-org/nope");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-github-message")).toHaveText("No repository octo-org/nope on GitHub, or you cannot see it.");

  for (const [text, msg] of [
    ["git@github.com:alexwaumann/dotfiles.git", "SSH URLs are not supported"],
    ["https://gitlab.com/a/b", "Only github.com repositories are supported"],
  ] as const) {
    await input.fill(text);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("add-project-github-error")).toContainText(msg);
  }
  expect(await githubCalls()).toEqual(["lookup alexwaumann/dotfiles", "lookup OCTO-ORG/hello-world", "lookup octo-org/nope"]);
});

test("GitHub: search, pick a result, clone with progress, and open the new project", async ({ page }) => {
  const input = await openGitHub(page);
  await input.fill("octo");
  await expect(page.getByTestId("add-project-github-go")).toHaveText("Search");
  await page.keyboard.press("Enter");
  await expect.poll(githubCalls).toEqual(["search octo"]);
  const results = page.getByTestId("add-project-github-results").getByTestId("add-project-github-result");
  await expect(results).toHaveCount(4);
  await expect(results.and(page.locator('[data-slug="octo-org/legacy-api"]'))).toContainText("archived");
  await expect(results.and(page.locator('[data-slug="octo-org/already-here"]'))).toContainText("already cloned");

  // A result's card, and back to the list.
  await results.and(page.locator('[data-slug="octo-org/legacy-api"]')).click();
  await expect(page.getByTestId("add-project-github-selected")).toHaveAttribute("data-slug", "octo-org/legacy-api");
  await page.getByTestId("add-project-github-back").click();
  await expect(results).toHaveCount(4);

  await results.and(page.locator('[data-slug="octo-org/Hello-World"]')).click();
  const card = page.getByTestId("add-project-github-selected");
  await expect(card.getByTestId("add-project-clone-dest")).toHaveText("~/.code-foundry/projects/octo-org/Hello-World");
  await card.getByTestId("add-project-clone").click();
  await expect(card.getByTestId("add-project-clone")).toHaveText("Cloning…");
  // A new lookup would cancel the clone: the input is locked while it runs.
  await expect(page.getByTestId("add-project-github-input")).toBeDisabled();
  await expect(card.getByTestId("add-project-clone-line").first()).toHaveText("Cloning into '/Users/dev/.code-foundry/projects/octo-org/Hello-World'...");
  await expect(dialog(page)).toHaveCount(0);
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("Hello-World@main");

  // Cloned once: the next lookup says so and offers the existing folder.
  await openAddProjectDialog(page);
  await page.getByTestId("add-project-tab-github").click();
  await page.getByTestId("add-project-github-input").fill("octo-org/hello-world");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-clone-exists")).toBeVisible();
  await expect(page.getByTestId("add-project-clone")).toHaveCount(0);
  await expect(page.getByTestId("add-project-add-existing")).toBeVisible();
});

test("GitHub: a failed clone shows its progress and gh's error, and can be retried", async ({ page }) => {
  const input = await openGitHub(page);
  await input.fill("octo-org/fail");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("add-project-github-selected");
  await card.getByTestId("add-project-clone").click();
  await expect(card.getByTestId("add-project-clone-error")).toContainText("fatal: early EOF");
  const lines = card.getByTestId("add-project-clone-progress").getByTestId("add-project-clone-line");
  await expect(lines).toHaveText(["Cloning into '/Users/dev/.code-foundry/projects/octo-org/fail'...", "remote: Enumerating objects: 128, done.", "Receiving objects:  46% (59/128)"]);
  await expect(lines.last()).toHaveAttribute("data-transient", "true");
  await expect(card.getByTestId("add-project-clone")).toHaveText("Retry clone");
  await expect(page.getByTestId("add-project-github-input")).toBeEnabled();
  await expect(dialog(page)).toBeVisible();
});

test("GitHub: an existing destination is added as a folder instead", async ({ page }) => {
  const input = await openGitHub(page);
  await input.fill("octo-org/already-here");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-clone-exists")).toBeVisible();
  await page.getByTestId("add-project-add-existing").click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await projectAt("/Users/dev/.code-foundry/projects/octo-org/already-here")).toMatchObject({ name: "already-here", git: true });
  await expect(page.getByTestId("worktree-surface-title")).toHaveText("already-here@main");
});
