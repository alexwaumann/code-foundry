import { expect, test, type Page } from "@playwright/test";
import { MOCK_TOKEN } from "../playwright.config";
import { invocations, mockUrl, openApp, openProjects, resetMock } from "./fixtures";

// The Add Project dialog (repo.add): its entry points, the tab order, the Local folder
// tab (repo.register with path completion), and the GitHub tab (lookup, search, clone
// with streamed progress) against the mock's GitHub (mock/clone.ts).

test.beforeEach(async () => {
  await resetMock();
});

const dialog = (page: Page) => page.getByTestId("add-project-dialog");

async function rpc(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${mockUrl}/codefoundry.v1.${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${MOCK_TOKEN}` },
    body: JSON.stringify(body),
  });
  expect(res.ok, path).toBe(true);
  return res.json();
}

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
  await page.getByTestId("sidebar-add-project").click();
  await page.getByTestId("add-project-tab-github").click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  const input = page.getByTestId("add-project-github-input");
  await expect(input).toBeFocused();
  return input;
}

test("every entry point opens the dialog", async ({ page }) => {
  await openApp(page);

  // The palette has one "Add Project" (repo.add); the folder prompt is its own entry.
  await page.keyboard.press("Meta+k");
  const palette = page.getByTestId("palette");
  await expect(palette.locator('[data-command="repo.add"]')).toContainText("Add Project");
  await expect(palette.locator('[data-command="repo.register"]')).toContainText("Add Project (local folder)");
  await page.keyboard.press("Escape");
  await openFromPalette(page, "repo.add");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page)).toHaveAttribute("data-tab", "local");
  await expect(page.getByTestId("add-project-local-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // repo.clone in the palette opens it on GitHub instead of prompting for a repo.
  await openFromPalette(page, "repo.clone");
  await expect(dialog(page)).toHaveAttribute("data-tab", "github");
  await expect(page.getByTestId("add-project-github-input")).toBeFocused();
  await page.keyboard.press("Escape");

  // The title band's button, next to New thread (New terminal left the band in #21).
  const band = page.getByTestId("sidebar-band-controls");
  await expect(band.getByTestId("sidebar-new-session")).toBeVisible();
  await band.getByTestId("sidebar-add-project").click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");

  // The Projects page's Add project button.
  await openProjects(page);
  await page.getByTestId("projects-register").click();
  await expect(dialog(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);

  // None of them invoked anything: the dialog is the GUI presentation of repo.add.
  expect((await invocations()).filter((i) => i.name.startsWith("repo."))).toEqual([]);
});

test("the project picker's empty state opens the dialog", async ({ page }) => {
  const { repos } = (await rpc("RepoService/List", {})) as { repos: { id: string }[] };
  for (const r of repos) {
    await rpc("CommandService/Invoke", { name: "repo.unregister", context: { activeRepoId: r.id }, confirmed: true });
  }
  await openApp(page);
  await page.getByTestId("sidebar-new-session").click();
  const picker = page.getByTestId("palette");
  await expect(picker).toHaveAttribute("data-mode", "projects");
  const add = picker.getByTestId("picker-add-project");
  await expect(add).toHaveAttribute("data-selected", "true");
  await page.keyboard.press("Enter");
  await expect(picker).toHaveCount(0);
  await expect(dialog(page)).toBeVisible();
  // No projects yet: it opens on New.
  await expect(dialog(page)).toHaveAttribute("data-tab", "new");
  await expect(page.getByTestId("add-project-new-name")).toBeFocused();
});

test("tabs are New, Local folder, GitHub; with projects it opens on Local folder", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("sidebar-add-project").click();
  const tabs = page.getByTestId("add-project-tabs").getByRole("tab");
  await expect(tabs).toHaveText(["New", "Local folder", "GitHub"]);
  await expect(page.getByTestId("add-project-tab-local")).toHaveAttribute("data-state", "active");
  await page.getByTestId("add-project-tab-new").click();
  await expect(dialog(page)).toHaveAttribute("data-tab", "new");
  await expect(page.getByTestId("add-project-new-name")).toBeFocused();
  // New lives in e2e/create.spec.ts.
});

test("Local folder: Tab completes, Enter adds, and the new project opens", async ({ page }) => {
  await openApp(page);
  await page.getByTestId("sidebar-add-project").click();
  const input = page.getByTestId("add-project-local-input");
  await expect(input).toBeFocused();

  // A refused path shows the daemon's reason in place.
  await input.fill("/tmp");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("add-project-local-message")).toContainText("/tmp is outside your home directory");
  await expect(dialog(page)).toBeVisible();

  await input.fill("~/src/ne");
  await expect(page.getByTestId("path-entry")).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue("~/src/new-app/");
  await expect(page.getByTestId("path-entry").first()).toHaveAttribute("data-entry-name", "api");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toHaveCount(0);
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("repo.register");
  expect(last?.args).toEqual({ path: "~/src/new-app" });
  await expect(page.getByTestId("overview-title")).toHaveText("new-app@main");
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
  await expect(page.getByTestId("overview-title")).toHaveText("Hello-World@main");

  // Cloned once: the next lookup says so and offers the existing folder.
  await page.getByTestId("sidebar-add-project").click();
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
  const last = (await invocations()).at(-1);
  expect(last?.name).toBe("repo.register");
  expect(last?.args).toEqual({ path: "/Users/dev/.code-foundry/projects/octo-org/already-here" });
});
