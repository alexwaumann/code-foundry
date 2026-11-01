import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Code, ConnectError } from "@connectrpc/connect";
import { Toaster } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/daemonFakes")).ghFakes }));
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));
vi.mock("@/api/addProject", async (orig) => ({ ...(await orig<typeof import("@/api/addProject")>()), ...(await import("@/test/addProjectFakes")).addProjectApiFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/addProjectFakes")).filesystemFakes }));
vi.mock("@/api/publish", async (orig) => ({ ...(await orig<typeof import("@/api/publish")>()), ...(await import("@/test/addProjectFakes")).publishFakes }));

const { AddProjectDialog } = await import("./AddProjectDialog");
const { PublishDialog } = await import("@/components/publish/PublishDialog");
const { resetPublishOwnersCache } = await import("@/components/publish/usePublishOwners");
const { ProjectsPage } = await import("@/components/projects/ProjectsPage");
const { daemon, invocationsOf, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { fakeDaemon, GH_NAME_TAKEN, PROJECTS, resetAddProjectFakes } = await import("@/test/addProjectFakes");
const { addWorkspace, removeProject, seedWorld, texts, updateProject } = await import("@/test/projectsWorld");
const { openAddProject, useAddProjectStore } = await import("@/stores/addProject");
const { openPublishDialog } = await import("@/stores/publish");
const { useProjectsStore } = await import("@/stores/projects");
const { useUiStore } = await import("@/stores/ui");
const { useWorkspacesStore } = await import("@/stores/workspaces");

/**
 * The Add Project dialog (project.add's presenter: New, Local folder with the folder-of-repos
 * choice, GitHub) and the Publish to GitHub dialog, against fakes of the mock daemon's folder
 * tree, GitHub and owners (src/test/addProjectFakes.ts). docs/notes/add-project-4-create.md,
 * docs/notes/workspaces-v2-6-scan.md. e2e keeps the palette entry points, the path completion
 * (e2e/paths.spec.ts) and the chevron's hover CSS.
 */

const dialog = () => screen.getByTestId("add-project-dialog");
const localInput = () => screen.getByTestId<HTMLInputElement>("add-project-local-input");
const message = () => screen.getByTestId("add-project-local-message");
const entry = (name: string) => document.querySelector<HTMLElement>(`[data-testid="path-entry"][data-entry-name="${name}"]`);
const page = () => screen.getByTestId("projects-page");
const register = () => fakeDaemon.calls.filter((c) => c.startsWith("register "));
const github = () => fakeDaemon.calls.filter((c) => /^(search|lookup|clone) /.test(c));

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function nextFrame() {
  await act(async () => {
    await new Promise((r) => requestAnimationFrame(() => { r(null); }));
  });
}

/** The page behind (to see what a new project opens) and the dialog, opened on a tab. */
async function open(tab: "new" | "local" | "github" = "local") {
  render(
    <>
      <ProjectsPage />
      <AddProjectDialog />
      <PublishDialog />
    </>,
  );
  act(() => {
    openAddProject(tab);
  });
  await settle();
  await nextFrame();
}

/** Types into the Local folder input (what follows "~/") and waits for its listing. */
async function typePath(text: string) {
  fireEvent.change(localInput(), { target: { value: text } });
  await settle(200);
}

/** Clicks a folder in the listing once it shows (the listing is debounced). */
async function clickEntry(name: string) {
  await waitFor(() => {
    expect(entry(name)).not.toBeNull();
  });
  fireEvent.click(entry(name) as HTMLElement);
  await settle(200);
}

function enter(el: HTMLElement) {
  fireEvent.keyDown(el, { key: "Enter" });
}

/** The page shows the project just added, by name (e2e's expectProjectRevealed). */
async function expectRevealed(name: string) {
  await waitFor(() => {
    expect(page().getAttribute("data-page")).toBe("project");
  });
  expect(screen.getByTestId("page-name").textContent).toBe(name);
}

/** Opens the publish picker's owner menu and picks one. */
async function pickOwner(login: string) {
  fireEvent.pointerDown(screen.getByTestId("publish-owner"), { button: 0, ctrlKey: false, pointerType: "mouse" });
  fireEvent.click(document.querySelector(`[data-testid="publish-owner-option"][data-login="${login}"]`) as HTMLElement);
  await settle();
  expect(screen.getByTestId("publish-owner").getAttribute("data-owner")).toBe(login);
}

/** The offered visibilities, in order, and the selected one. */
function expectVisibilities(offered: string[], selected: string) {
  const group = screen.getByTestId("publish-visibility");
  expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(offered);
  expect(group.getAttribute("data-value")).toBe(selected);
  expect(screen.getByTestId(`publish-visibility-${selected}`).getAttribute("aria-checked")).toBe("true");
}

/** The daemon's project.create, project.github.publish, project.delete and project.add-workspace (mock/create.ts, mock/world.ts). */
function fakeProjectCommands() {
  daemon.handlers.set("project.create", (inv) => {
    const name = inv.args.name ?? "";
    const id = `repo-${name}`;
    if (useProjectsStore.getState().byId[id]) throw new ConnectError(`${PROJECTS}/${name} already exists`, Code.AlreadyExists);
    fakeDaemon.onAdded({ id, path: `${PROJECTS}/${name}`, name, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [] });
    return { message: "", resultJson: JSON.stringify({ id, name, path: `${PROJECTS}/${name}` }) };
  });
  daemon.handlers.set("project.github.publish", (inv) => {
    if ((inv.args.name ?? "").toLowerCase() === "taken") throw new ConnectError(GH_NAME_TAKEN, Code.Unknown);
    updateProject(inv.args.project ?? "", (p) => ({ ...p, remotes: ["origin"], githubSlug: `${inv.args.owner ?? ""}/${inv.args.name ?? ""}` }));
    return { message: `Published to ${inv.args.owner ?? ""}/${inv.args.name ?? ""}`, resultJson: "" };
  });
  daemon.handlers.set("project.delete", (inv) => {
    removeProject(inv.args.project ?? "");
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("project.add-workspace", (inv) => {
    if (inv.args.folder === "~/mixed") throw new ConnectError("could not add 1 of 2 repositories in /Users/dev/mixed (broken: permission denied)", Code.FailedPrecondition);
    // The repositories inside become projects; a name taken gets " 2" (the daemon's rules).
    for (const n of ["api", "docs-site", "web"]) fakeDaemon.onAdded({ id: `repo-${n}`, path: `/Users/dev/product/${n}`, name: n, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [] });
    const taken = Object.values(useWorkspacesStore.getState().byId).some((w) => w.name === "product");
    const w = addWorkspace(taken ? "product 2" : "product", ["repo-api", "repo-docs-site", "repo-web"], { root: "/Users/dev/product" });
    return { message: "", resultJson: JSON.stringify({ id: w.id, name: w.name }) };
  });
}

beforeEach(() => {
  resetDaemon();
  resetAddProjectFakes();
  resetPublishOwnersCache();
  seedWorld();
  fakeProjectCommands();
  // A project the daemon adds arrives in the store (its project event).
  fakeDaemon.onAdded = (p) => {
    act(() => {
      useProjectsStore.setState((s) => ({ byId: { ...s.byId, [p.id]: p }, order: [...s.order, p.id] }));
    });
  };
  useAddProjectStore.setState({ open: false, created: null, busy: false, stay: false });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the Add Project dialog", () => {
  it("its tabs are New, Local folder, GitHub; it opens on Local folder with the path focused; Escape closes it", async () => {
    await open();
    expect(within(screen.getByTestId("add-project-tabs")).getAllByRole("tab").map((t) => t.textContent)).toEqual(["New", "Local folder", "GitHub"]);
    expect(dialog().getAttribute("data-tab")).toBe("local");
    expect(within(dialog()).getByRole("tab", { selected: true }).textContent).toContain("Local");
    expect(document.activeElement).toBe(localInput());
    // No Wails host: no folder picker.
    expect(screen.queryByTestId("pick-directory")).toBeNull();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    // Nothing was invoked: the dialog is the GUI presentation of project.add.
    expect(daemon.invocations.filter((i) => i.name.startsWith("project."))).toEqual([]);
  });

  it("opened on GitHub or New, that tab is selected and its input focused", async () => {
    await open("github");
    expect(within(dialog()).getByRole("tab", { selected: true }).textContent).toContain("GitHub");
    expect(document.activeElement).toBe(screen.getByTestId("add-project-github-input"));
    act(() => {
      useAddProjectStore.setState({ open: false });
      openAddProject("new");
    });
    await settle();
    await nextFrame();
    expect(dialog().getAttribute("data-tab")).toBe("new");
    expect(document.activeElement).toBe(screen.getByTestId("add-project-new-name"));
  });
});

describe("the Local folder tab", () => {
  it("Enter with nothing typed asks for a path; Tab completes; Enter adds over Register, and the new project opens", async () => {
    await open();
    enter(localInput());
    await settle();
    expect(message().textContent).toContain("Type a folder path");
    expect(dialog()).toBeTruthy();

    await typePath("src/ne");
    expect(screen.getAllByTestId("path-entry")).toHaveLength(1);
    fireEvent.keyDown(localInput(), { key: "Tab" });
    await settle(200);
    expect(localInput().value).toBe("src/new-app/");
    expect(screen.getAllByTestId("path-entry")[0]?.getAttribute("data-entry-name")).toBe("api");
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    // ProjectService.Register, not a command, the trailing slash dropped.
    expect(register()).toEqual(["register ~/src/new-app"]);
    expect(daemon.invocations.filter((i) => i.name.startsWith("project."))).toEqual([]);
    await expectRevealed("new-app");
  });

  it("a click opens a folder and adds nothing; a highlighted folder is what Enter adds", async () => {
    await open();
    await settle(200);
    expect(entry("src")).not.toBeNull();
    expect(message().textContent).toBe("Click or Tab opens a folder · Enter adds");
    // No "Add ~/..." row, and no folder highlighted until the keyboard or the mouse moves there.
    expect(within(dialog()).queryByText(/^Add ~\//)).toBeNull();
    expect(screen.getByTestId("add-project-local-typed").className).toContain("hidden");
    expect(document.querySelector('[data-testid="path-entry"][data-selected="true"]')).toBeNull();

    // A click opens the folder (clearing an error), and adds nothing.
    enter(localInput());
    await settle();
    expect(message().textContent).toContain("Type a folder path");
    await clickEntry("src");
    expect(localInput().value).toBe("src/");
    expect(localInput().getAttribute("data-path")).toBe("~/src/");
    expect(document.activeElement).toBe(localInput());
    expect(message().textContent).toBe("Click or Tab opens a folder · Enter adds");
    expect(entry("new-app")).not.toBeNull();

    // An already added folder opens the same way.
    expect(entry("code-foundry")?.textContent).toContain("already added");
    await clickEntry("code-foundry");
    expect(localInput().getAttribute("data-path")).toBe("~/src/code-foundry/");
    expect(entry("docs")).not.toBeNull();
    expect(dialog()).toBeTruthy();
    expect(register()).toEqual([]);

    // Enter on a highlighted folder adds that folder.
    await typePath("src/");
    expect(entry("Website")).not.toBeNull();
    fireEvent.keyDown(localInput(), { key: "End" });
    expect(entry("Website")?.getAttribute("data-selected")).toBe("true");
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/src/Website"]);
  });

  it("after a click, Enter adds the typed path (not a folder in its listing), and so does the button", async () => {
    await open();
    await settle(200);
    await clickEntry("Documents");
    expect(localInput().value).toBe("Documents/");
    expect(entry("Projects")).not.toBeNull();
    expect(document.querySelector('[data-testid="path-entry"][data-selected="true"]')).toBeNull();
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/Documents"]);

    act(() => {
      openAddProject();
    });
    await settle(200);
    await clickEntry("src");
    await clickEntry("Notebook");
    expect(localInput().getAttribute("data-path")).toBe("~/src/Notebook/");
    expect(dialog()).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-project-local-submit"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/Documents", "register ~/src/Notebook"]);
  });

  it("a folder that does not exist is refused in place; a folder inside a project opens that project", async () => {
    await open();
    await typePath("src/Notebook");
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    await expectRevealed("Notebook");

    act(() => {
      openAddProject();
    });
    await settle();
    await typePath("src/nope");
    enter(localInput());
    await settle();
    expect(message().textContent).toContain("/Users/dev/src/nope: no such file or directory");
    expect(dialog()).toBeTruthy();

    // Inside an added repository: the daemon answers that repository.
    await typePath("src/code-foundry/src");
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register().at(-1)).toBe("register ~/src/code-foundry/src");
    await expectRevealed("code-foundry");
  });
});

describe("the Local folder tab: a folder of repos", () => {
  async function askAbout(path: string) {
    await open();
    await typePath(path);
    enter(localInput());
    await settle();
    await nextFrame();
    return screen.getByTestId("add-project-choice");
  }

  it("asks how to add it; Add as workspace is the default and has the focus; Enter takes it and the workspace's page shows", async () => {
    const choice = await askAbout("product");
    expect(screen.getByTestId("add-project-choice-heading").textContent).toBe("~/product has 3 git repositories inside.");
    const asWorkspace = screen.getByTestId("add-project-as-workspace");
    const asProject = screen.getByTestId("add-project-as-project");
    expect(asWorkspace.textContent).toBe("Add as workspace");
    expect(asProject.textContent).toBe("Add as project");
    expect(screen.getByTestId("add-project-as-workspace-line").textContent).toBe("The 3 repos inside become projects; this folder is their shared root for instructions and skills.");
    expect(screen.getByTestId("add-project-as-project-line").textContent).toBe("One folder. No git features for the repos inside.");
    expect(document.activeElement).toBe(asWorkspace);
    // The folder list and the plain Add project button make way; nothing is added yet.
    expect(screen.queryByTestId("add-project-local-submit")).toBeNull();
    expect(screen.queryAllByTestId("path-entry").every((e) => e.closest(".hidden") !== null)).toBe(true);
    expect(choice.getAttribute("data-repos")).toBe("3");
    expect(register()).toEqual([]);

    // Enter takes the default (the focused button).
    fireEvent.click(asWorkspace);
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(invocationsOf("project.add-workspace").map((i) => i.args)).toEqual([{ folder: "~/product" }]);
    await waitFor(() => {
      expect(page().getAttribute("data-page")).toBe("workspace");
    });
    expect(screen.getByTestId("page-name").textContent).toBe("product");
    expect(screen.getByTestId("workspace").getAttribute("data-rooted")).toBe("true");
    expect(screen.getByTestId("workspace-folder").getAttribute("data-default")).toBe("true");
    expect(texts(document, "member-name")).toEqual(["api", "docs-site", "web"]);
    expect(document.activeElement).toBe(screen.getByTestId("projects-list"));
    // Back on the index, its row is there with the others.
    const id = page().getAttribute("data-workspace") ?? "";
    fireEvent.click(screen.getByTestId("projects-crumb"));
    expect(document.querySelector(`[data-nav-key="ws:${id}"]`)).not.toBeNull();

    // Again: the dialog adds it the same way (the daemon names it "product 2").
    act(() => {
      openAddProject();
    });
    await settle();
    await typePath("product/");
    enter(localInput());
    await settle();
    fireEvent.click(screen.getByTestId("add-project-as-workspace"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(invocationsOf("project.add-workspace").map((i) => i.args)).toEqual([{ folder: "~/product" }, { folder: "~/product" }]);
    await waitFor(() => {
      expect(screen.getByTestId("page-name").textContent).toBe("product 2");
    });
  });

  it("Add as project adds the folder as one plain project", async () => {
    await askAbout("product");
    fireEvent.click(screen.getByTestId("add-project-as-project"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/product"]);
    expect(invocationsOf("project.add-workspace")).toEqual([]);
    await expectRevealed("product");
  });

  it("editing the path drops the question; a plain folder and a repository add at once", async () => {
    await askAbout("product");
    await typePath("product/notes");
    expect(screen.queryByTestId("add-project-choice")).toBeNull();
    expect(screen.getByTestId("add-project-local-submit")).toBeTruthy();
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/product/notes"]);

    act(() => {
      openAddProject();
    });
    await settle();
    await typePath("src/new-app");
    enter(localInput());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual(["register ~/product/notes", "register ~/src/new-app"]);
    expect(invocationsOf("project.add-workspace")).toEqual([]);
  });

  it("a repository that cannot be added shows the daemon's error in place", async () => {
    await askAbout("mixed");
    expect(screen.getByTestId("add-project-choice-heading").textContent).toBe("~/mixed has 2 git repositories inside.");
    fireEvent.click(screen.getByTestId("add-project-as-workspace"));
    await settle();
    expect(screen.getByTestId("add-project-choice-error").textContent).toContain("could not add 1 of 2 repositories in /Users/dev/mixed (broken: permission denied)");
    expect(dialog()).toBeTruthy();
    expect(screen.getByTestId<HTMLButtonElement>("add-project-as-workspace").disabled).toBe(false);
  });

  it("Escape on the two choices goes back to the path as typed; Enter asks again; Escape twice closes the dialog", async () => {
    await askAbout("product");
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(dialog()).toBeTruthy();
    expect(screen.queryByTestId("add-project-choice")).toBeNull();
    expect(localInput().value).toBe("product");
    expect(document.activeElement).toBe(localInput());
    expect(screen.getByTestId("add-project-local-submit")).toBeTruthy();
    enter(localInput());
    await settle();
    await nextFrame();
    expect(screen.getByTestId("add-project-choice")).toBeTruthy();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(invocationsOf("project.add-workspace")).toEqual([]);
  });
});

describe("the GitHub tab", () => {
  const input = () => screen.getByTestId<HTMLInputElement>("add-project-github-input");
  const go = (text: string) => {
    fireEvent.change(input(), { target: { value: text } });
    fireEvent.submit(input().form as HTMLFormElement);
  };
  const card = () => screen.getByTestId("add-project-github-selected");

  it("Enter looks up owner/repo and URLs; bad input is refused without a request", async () => {
    await open("github");
    // Typing sends nothing.
    fireEvent.change(input(), { target: { value: "alexwaumann/dotfiles" } });
    expect(screen.getByTestId("add-project-github-go").textContent).toBe("Look up");
    expect(screen.queryByTestId("add-project-github-selected")).toBeNull();
    expect(github()).toEqual([]);
    fireEvent.submit(input().form as HTMLFormElement);
    await settle();
    expect(card().getAttribute("data-slug")).toBe("alexwaumann/dotfiles");
    expect(github()).toEqual(["lookup alexwaumann/dotfiles"]);
    expect(within(card()).getByTestId("add-project-clone-dest").textContent).toBe("~/.code-foundry/projects/alexwaumann/dotfiles");
    expect(within(card()).getByTestId<HTMLButtonElement>("add-project-clone").disabled).toBe(false);
    expect(within(card()).queryByTestId("add-project-github-back")).toBeNull();

    // A URL in any case comes back in GitHub's spelling.
    go("https://github.com/OCTO-ORG/hello-world.git");
    await settle();
    expect(card().getAttribute("data-slug")).toBe("octo-org/Hello-World");

    go("octo-org/nope");
    await settle();
    expect(screen.getByTestId("add-project-github-message").textContent).toBe("No repository octo-org/nope on GitHub, or you cannot see it.");

    for (const [text, msg] of [
      ["git@github.com:alexwaumann/dotfiles.git", "SSH URLs are not supported"],
      ["https://gitlab.com/a/b", "Only github.com repositories are supported"],
    ] as const) {
      go(text);
      await settle();
      expect(screen.getByTestId("add-project-github-error").textContent).toContain(msg);
    }
    expect(github()).toEqual(["lookup alexwaumann/dotfiles", "lookup OCTO-ORG/hello-world", "lookup octo-org/nope"]);
  });

  it("search, pick a result and back, clone with progress (the input locked meanwhile), and open the new project; cloned once, a lookup offers the folder", async () => {
    await open("github");
    fireEvent.change(input(), { target: { value: "octo" } });
    expect(screen.getByTestId("add-project-github-go").textContent).toBe("Search");
    fireEvent.submit(input().form as HTMLFormElement);
    await settle();
    expect(github()).toEqual(["search octo"]);
    const results = () => within(screen.getByTestId("add-project-github-results")).getAllByTestId("add-project-github-result");
    const result = (slug: string) => results().find((r) => r.getAttribute("data-slug") === slug) as HTMLElement;
    expect(results()).toHaveLength(4);
    expect(result("octo-org/legacy-api").textContent).toContain("archived");
    expect(result("octo-org/already-here").textContent).toContain("already cloned");

    // A result's card, and back to the list.
    fireEvent.click(result("octo-org/legacy-api"));
    expect(card().getAttribute("data-slug")).toBe("octo-org/legacy-api");
    fireEvent.click(screen.getByTestId("add-project-github-back"));
    expect(results()).toHaveLength(4);

    fireEvent.click(result("octo-org/Hello-World"));
    expect(within(card()).getByTestId("add-project-clone-dest").textContent).toBe("~/.code-foundry/projects/octo-org/Hello-World");
    fireEvent.click(within(card()).getByTestId("add-project-clone"));
    await settle();
    expect(within(card()).getByTestId("add-project-clone").textContent).toBe("Cloning…");
    // A new lookup would cancel the clone: the input is locked while it runs.
    expect(input().disabled).toBe(true);
    expect(within(card()).getAllByTestId("add-project-clone-line")[0]?.textContent).toBe("Cloning into '/Users/dev/.code-foundry/projects/octo-org/Hello-World'...");
    await waitFor(() => {
      expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    });
    await expectRevealed("Hello-World");

    // Cloned once: the next lookup says so and offers the existing folder.
    act(() => {
      openAddProject("github");
    });
    await settle();
    go("octo-org/hello-world");
    await settle();
    expect(screen.getByTestId("add-project-clone-exists")).toBeTruthy();
    expect(screen.queryByTestId("add-project-clone")).toBeNull();
    expect(screen.getByTestId("add-project-add-existing")).toBeTruthy();
  });

  it("a failed clone shows its progress and gh's error, and can be retried", async () => {
    await open("github");
    go("octo-org/fail");
    await settle();
    fireEvent.click(within(card()).getByTestId("add-project-clone"));
    await waitFor(() => {
      expect(within(card()).getByTestId("add-project-clone-error").textContent).toContain("fatal: early EOF");
    });
    const lines = within(within(card()).getByTestId("add-project-clone-progress")).getAllByTestId("add-project-clone-line");
    expect(lines.map((l) => l.textContent)).toEqual(["Cloning into '/Users/dev/.code-foundry/projects/octo-org/fail'...", "remote: Enumerating objects: 128, done.", "Receiving objects:  46% (59/128)"]);
    expect(lines.at(-1)?.getAttribute("data-transient")).toBe("true");
    await waitFor(() => {
      expect(within(card()).getByTestId("add-project-clone").textContent).toBe("Retry clone");
    });
    expect(input().disabled).toBe(false);
    expect(dialog()).toBeTruthy();
  });

  it("an existing destination is added as a folder instead", async () => {
    await open("github");
    go("octo-org/already-here");
    await settle();
    expect(screen.getByTestId("add-project-clone-exists")).toBeTruthy();
    fireEvent.click(screen.getByTestId("add-project-add-existing"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(register()).toEqual([`register ${PROJECTS}/octo-org/already-here`]);
    await expectRevealed("already-here");
  });
});

describe("the New tab", () => {
  const name = () => screen.getByTestId<HTMLInputElement>("add-project-new-name");
  const create = () => screen.getByTestId<HTMLButtonElement>("add-project-create");
  const publishBox = () => screen.getByTestId("add-project-new-publish");

  async function openNew() {
    await open("new");
    expect(dialog().getAttribute("data-tab")).toBe("new");
    expect(document.activeElement).toBe(name());
  }

  it("the name is checked as typed, a refused one never reaches the daemon; Create makes the project and opens it; the same name again is refused under it", async () => {
    await openNew();
    expect(create().disabled).toBe(true);
    expect(screen.getByTestId("add-project-new-dest").textContent).toBe("~/.code-foundry/projects/<name>");
    const refused: [string, string][] = [
      [".hidden", "cannot start with"],
      ["a/b", "letters, digits"],
      ["two words", "letters, digits"],
    ];
    for (const [bad, why] of refused) {
      fireEvent.change(name(), { target: { value: bad } });
      expect(screen.getByTestId("add-project-new-error").textContent).toContain(why);
    }
    fireEvent.submit(name().form as HTMLFormElement);
    await settle();
    expect(screen.getByTestId("add-project-new-error")).toBeTruthy();
    expect(invocationsOf("project.create")).toEqual([]);

    fireEvent.change(name(), { target: { value: "my-app" } });
    expect(screen.queryByTestId("add-project-new-error")).toBeNull();
    expect(screen.getByTestId("add-project-new-dest").textContent).toBe("~/.code-foundry/projects/my-app");
    expect(create().textContent).toBe("Create project");
    fireEvent.click(create());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    await expectRevealed("my-app");
    expect(lastInvocation("project.create")?.args).toEqual({ name: "my-app" });
    expect(lastInvocation("project.github.publish")).toBeUndefined();

    act(() => {
      openAddProject("new");
    });
    await settle();
    fireEvent.change(name(), { target: { value: "my-app" } });
    fireEvent.submit(name().form as HTMLFormElement);
    await settle();
    expect(screen.getByTestId("add-project-new-error").textContent).toContain(`${PROJECTS}/my-app already exists`);
    expect(dialog()).toBeTruthy();
  });

  it("with publish to octo-org: the viewer's account first with Public and Private; octo-org offers Public and Internal", async () => {
    await openNew();
    fireEvent.change(name(), { target: { value: "octo-app" } });
    fireEvent.click(publishBox());
    await settle();
    expect(screen.getByTestId("publish-owner").getAttribute("data-owner")).toBe("dev");
    expectVisibilities(["Public", "Private"], "public");
    expect(screen.queryByTestId("publish-visibility-hint")).toBeNull();
    await pickOwner("octo-org");
    expectVisibilities(["Public", "Internal"], "public");
    expect(screen.queryByTestId("publish-visibility-private")).toBeNull();
    expect(screen.queryByTestId("publish-visibility-hint")).toBeNull();
    expect(create().textContent).toBe("Create and publish");
    fireEvent.click(create());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    await expectRevealed("octo-app");
    expect(lastInvocation("project.github.publish")?.args).toEqual({ project: "repo-octo-app", owner: "octo-org", name: "octo-app", visibility: "public" });
    expect(daemon.invocations.map((i) => i.name).filter((n) => n.startsWith("project."))).toEqual(["project.create", "project.github.publish"]);
  });

  it("an organization whose policy is unknown offers all three; a choice the next owner allows survives, one it does not falls back", async () => {
    await openNew();
    fireEvent.change(name(), { target: { value: "acme-tool" } });
    fireEvent.click(publishBox());
    await settle();
    await pickOwner("acme");
    expectVisibilities(["Public", "Internal", "Private"], "public");
    expect(screen.getByTestId("publish-visibility-hint").textContent).toContain("does not show acme's repository policy");
    fireEvent.click(screen.getByTestId("publish-visibility-private"));
    expectVisibilities(["Public", "Internal", "Private"], "private");
    await pickOwner("octo-org");
    expectVisibilities(["Public", "Internal"], "public");
    await pickOwner("acme");
    fireEvent.click(screen.getByTestId("publish-visibility-internal"));
    fireEvent.click(create());
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(lastInvocation("project.github.publish")?.args).toMatchObject({ owner: "acme", visibility: "internal" });
  });

  it("a refused publish shows gh's error and keeps the picker; the project exists, its name locked; retry publishes again; Keep it local closes on it", async () => {
    await openNew();
    fireEvent.change(name(), { target: { value: "taken" } });
    fireEvent.click(publishBox());
    await settle();
    expect(screen.getByTestId("publish-owner").getAttribute("data-owner")).toBe("dev");
    fireEvent.click(create());
    await settle();
    expect(screen.getByTestId("publish-error").textContent).toBe(GH_NAME_TAKEN);
    expect(dialog()).toBeTruthy();
    expect(screen.getByTestId("publish-picker")).toBeTruthy();
    expect(screen.getByTestId("add-project-new").getAttribute("data-created")).toBe("repo-taken");
    expect(screen.getByTestId("add-project-new-created").textContent).toContain("Created taken");
    expect(name().disabled).toBe(true);
    expect(create().textContent).toBe("Publish");

    fireEvent.click(create());
    await settle();
    expect(screen.getByTestId("publish-error").textContent).toBe(GH_NAME_TAKEN);
    expect(invocationsOf("project.create")).toHaveLength(1);
    expect(invocationsOf("project.github.publish")).toHaveLength(2);
    fireEvent.click(screen.getByTestId("add-project-keep-local"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(invocationsOf("project.delete")).toEqual([]);
    await expectRevealed("taken");
  });

  it("cancelling after a refused publish deletes the new project; Keep it local needs the publish step; the close button is the same cancel", async () => {
    render(<Toaster />);
    await openNew();
    fireEvent.change(name(), { target: { value: "taken" } });
    // Without the publish step there is no Keep it local, and Create project has an icon.
    expect(screen.queryByTestId("add-project-keep-local")).toBeNull();
    expect(create().querySelectorAll("svg")).toHaveLength(1);
    fireEvent.click(publishBox());
    await settle();
    fireEvent.click(create());
    await settle();
    expect(screen.getByTestId("publish-error").textContent).toBe(GH_NAME_TAKEN);
    expect(screen.getByTestId("add-project-new").getAttribute("data-created")).toBe("repo-taken");
    expect(screen.getByTestId("add-project-keep-local")).toBeTruthy();

    // Unchecking the publish step hides Keep it local; the primary becomes a bare Done.
    fireEvent.click(publishBox());
    expect(screen.queryByTestId("add-project-keep-local")).toBeNull();
    expect(create().textContent).toBe("Done");
    expect(create().querySelectorAll("svg")).toHaveLength(0);
    fireEvent.click(publishBox());
    await settle();
    expect(create().textContent).toBe("Publish");
    expect(create().querySelectorAll("svg")).toHaveLength(1);

    // Cancelling (Escape) deletes the project again: project.delete, confirmed.
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(daemon.invocations.map((i) => i.name).filter((n) => n.startsWith("project."))).toEqual(["project.create", "project.github.publish", "project.delete"]);
    expect(lastInvocation("project.delete")).toMatchObject({ args: { project: "repo-taken" }, confirmed: true });
    expect(useProjectsStore.getState().byId["repo-taken"]).toBeUndefined();
    expect(await screen.findByText("Deleted taken")).toBeTruthy();

    // The close button is the same cancel; nothing to delete this time.
    act(() => {
      openAddProject("new");
    });
    await settle();
    fireEvent.click(screen.getByTestId("add-project-close"));
    await settle();
    expect(screen.queryByTestId("add-project-dialog")).toBeNull();
    expect(invocationsOf("project.delete")).toHaveLength(1);
  });
});

describe("the Publish to GitHub dialog", () => {
  it("opens for sketches from the index row: its name, the viewer's account, Public; a refusal keeps it; published, the row no longer offers it", async () => {
    render(
      <>
        <ProjectsPage />
        <PublishDialog />
      </>,
    );
    await settle();
    fireEvent.click(within(document.querySelector('[data-nav-key="p:repo-sk"]') as HTMLElement).getByTestId("index-publish"));
    await settle();
    const pub = screen.getByTestId("publish-dialog");
    expect(pub.getAttribute("data-project")).toBe("repo-sk");
    expect(screen.getByTestId<HTMLInputElement>("publish-name").value).toBe("sketches");
    expect(screen.getByTestId("publish-owner").getAttribute("data-owner")).toBe("dev");
    expectVisibilities(["Public", "Private"], "public");
    expect(screen.getByTestId("publish-slug").textContent).toBe("dev/sketches");

    // A refusal (the name is taken on GitHub) shows gh's words and keeps the dialog.
    fireEvent.change(screen.getByTestId("publish-name"), { target: { value: "taken" } });
    fireEvent.click(screen.getByTestId("publish-submit"));
    await settle();
    expect(screen.getByTestId("publish-error").textContent).toBe(GH_NAME_TAKEN);
    expect(screen.getByTestId("publish-dialog")).toBeTruthy();
    expect(screen.getByTestId("publish-submit").textContent).toBe("Try again");

    fireEvent.change(screen.getByTestId("publish-name"), { target: { value: "sketchbook" } });
    await pickOwner("acme");
    fireEvent.click(screen.getByTestId("publish-visibility-private"));
    fireEvent.click(screen.getByTestId("publish-submit"));
    await settle();
    expect(screen.queryByTestId("publish-dialog")).toBeNull();
    expect(lastInvocation("project.github.publish")?.args).toEqual({ project: "repo-sk", owner: "acme", name: "sketchbook", visibility: "private" });
    // Published: origin on GitHub, so the row no longer offers it.
    expect(within(document.querySelector('[data-nav-key="p:repo-sk"]') as HTMLElement).queryByTestId("index-publish")).toBeNull();
  });

  it("opens for a project only; Escape closes it", async () => {
    render(<PublishDialog />);
    expect(openPublishDialog("repo-nope")).toBe(false);
    act(() => {
      openPublishDialog("repo-sk");
    });
    await settle();
    expect(screen.getByTestId("publish-dialog").getAttribute("data-project")).toBe("repo-sk");
    expect(texts(document, "publish-slug")).toEqual(["dev/sketches"]);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
    await settle();
    expect(screen.queryByTestId("publish-dialog")).toBeNull();
  });
});

// Keep the selection a test starts from out of the next one.
afterEach(() => {
  useUiStore.setState({ selection: { kind: "view", name: "projects" } } as never);
});
