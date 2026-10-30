// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import { draftKey } from "@/lib/compose";
import { updateDraft, useComposeStore } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { HOME, useUiStore } from "@/stores/ui";
import { HOME_DRAFT, startWelcomeSync, useWelcomeStore, welcomePrompt } from "@/stores/welcome";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Composer } from "./Composer";

// No daemon: refs and skills never load (the composer shows them loading).
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => new Promise(() => undefined) }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));
// The daemon's placed welcome page (HealthService.Version).
const PAGE = "/Users/me/.code-foundry/pages/welcome.html";
vi.mock("@/api/health", async (orig) => ({ ...(await orig<typeof import("@/api/health")>()), welcomePage: () => Promise.resolve(PAGE) }));

const project = (id: string): ProjectView => ({
  id,
  path: `/src/${id}`,
  name: id,
  defaultBranch: "main",
  githubSlug: "",
  remotes: [],
  git: true,
  worktrees: [{ projectId: id, path: `/src/${id}`, branch: "main", head: "abc", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
});

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"], loaded: true });
  useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  useWelcomeStore.setState({ page: "", decided: false });
});

describe("Composer without a project", () => {
  it("names No project and hides the worktree, base, branch and member chips", () => {
    render(<Composer projectId="" noProject />);
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build with No project?");
    expect(screen.queryByTestId("composer-worktree")).toBeNull();
    expect(screen.queryByTestId("composer-base")).toBeNull();
    expect(screen.queryByTestId("composer-members")).toBeNull();
    expect(screen.getByTestId("composer-model")).not.toBeNull();
    expect(screen.getByTestId("composer-permission").textContent).toContain("Auto");
  });

  it("a project's composer still has them", () => {
    render(<Composer projectId="web" />);
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build in web?");
    // By default a project's thread works in the project folder itself: no base picker,
    // the checkout's branch instead.
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Project folder");
    expect(screen.queryByTestId("composer-base")).toBeNull();
    expect(screen.getByTestId("composer-checkout-branch").textContent).toBe("On main");
    expect(screen.getByTestId("composer-members")).not.toBeNull();
  });
});

describe("the first-run welcome (docs/notes/welcome-composer.md)", () => {
  const noProjects = () => {
    useProjectsStore.setState({ byId: {}, order: [], loaded: true });
  };
  const addProject = () => {
    act(() => {
      useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"], loaded: true });
    });
  };
  const heading = () => screen.getByTestId("composer-heading").textContent;
  const homeText = () => useComposeStore.getState().drafts[HOME_DRAFT]?.text ?? "";
  const mountHome = async () => {
    render(<Composer projectId="" noProject />);
    // The page's path arrives from the daemon a tick later.
    await act(async () => {
      await Promise.resolve();
    });
  };
  let stop: () => void = () => undefined;
  beforeEach(() => {
    stop = startWelcomeSync();
  });
  afterEach(() => {
    stop();
  });

  it("the exact prompt, naming the placed page", () => {
    expect(welcomePrompt(PAGE)).toBe(
      "I just installed Code Foundry and have no projects yet. This is the welcome tutorial: open the page /Users/me/.code-foundry/pages/welcome.html in the side panel and walk me through it.",
    );
  });

  it.each<[string, () => void, string, string]>([
    ["zero projects and an empty draft: Welcome heading, prompt prefilled", noProjects, "Welcome to Code Foundry", welcomePrompt(PAGE)],
    ["with a project: the normal heading, nothing prefilled", () => undefined, "What should we build with No project?", ""],
    [
      "projects not loaded yet: no welcome",
      () => {
        useProjectsStore.setState({ byId: {}, order: [], loaded: false });
      },
      "What should we build with No project?",
      "",
    ],
    [
      "a typed draft is never replaced",
      () => {
        noProjects();
        updateDraft(HOME_DRAFT, { text: "my own words" });
      },
      "Welcome to Code Foundry",
      "my own words",
    ],
  ])("%s", async (_name, arrange, wantHeading, wantText) => {
    arrange();
    await mountHome();
    expect(heading()).toBe(wantHeading);
    expect(homeText()).toBe(wantText);
  });

  it("keeps the project switcher out of the welcome heading", async () => {
    noProjects();
    await mountHome();
    expect(screen.queryByTestId("composer-project-trigger")).toBeNull();
  });

  it("prefills once: a prompt the user cleared stays clear", async () => {
    noProjects();
    await mountHome();
    expect(homeText()).toBe(welcomePrompt(PAGE));
    act(() => {
      updateDraft(HOME_DRAFT, { text: "" });
    });
    cleanup();
    await mountHome();
    expect(homeText()).toBe("");
  });

  it.each<[string, (prefilled: string) => string, string]>([
    ["the first project clears an untouched prefill", (p) => p, ""],
    ["an edited prompt stays", (p) => `${p} Slowly, please.`, `${welcomePrompt(PAGE)} Slowly, please.`],
  ])("%s, and the heading reverts", async (_name, edit, want) => {
    noProjects();
    await mountHome();
    act(() => {
      updateDraft(HOME_DRAFT, { text: edit(homeText()) });
    });
    addProject();
    expect(heading()).toBe("What should we build with No project?");
    expect(homeText()).toBe(want);
  });
});

describe("Escape with nothing typed (docs/notes/remove-dashboard.md)", () => {
  const escape = () => {
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Escape" });
  };

  it.each<[string, () => void, unknown]>([
    ["a project's composer goes to the Projects page", () => render(<Composer projectId="web" />), { kind: "view", name: "projects" }],
    ["the No project composer stays home", () => render(<Composer projectId="" noProject />), HOME],
  ])("%s", (_name, mount, want) => {
    useUiStore.setState({ selection: { kind: "thread", id: "elsewhere" } });
    mount();
    escape();
    expect(useUiStore.getState().selection).toEqual(want);
    expect(useUiStore.getState().palette.open).toBe(false);
  });
});

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({
    id,
    name: id,
    projectId: "web",
    projectIds: ["web"],
    worktreePath: "/src/web",
    createdWorktree: false,
    branch: "",
    checkoutPaths: [{ projectId: "web", path: "/src/web" }],
    state: "connected",
    status: "busy",
    statusReason: "",
    archivedAtMs: null,
    snoozedUntilMs: null,
    ...o,
  }) as ThreadView;

function setThreads(threads: ThreadView[]) {
  useThreadsStore.setState({ byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id), loaded: true });
}

describe("Composer collision banner", () => {
  afterEach(() => {
    setThreads([]);
  });

  it("one project: the banner, the new-branch button and the warning on the Work in pill", () => {
    setThreads([thread("Fix login")]);
    render(<Composer projectId="web" />);
    expect(screen.getByTestId("composer-collision-text").textContent).toBe(
      "This project is already being edited on main by another running thread. Multiple agents changing the same file at the same time can overwrite each other's work.",
    );
    expect(screen.getByTestId("composer-worktree").hasAttribute("data-warning")).toBe(true);
    expect(screen.getByTestId("composer-worktree-warning")).not.toBeNull();
    // A new branch shares nothing: the banner and the pill's warning go.
    fireEvent.click(screen.getByTestId("composer-collision-new-branch"));
    expect(screen.getByTestId("composer-worktree").textContent).toContain("Fresh copy");
    expect(screen.queryByTestId("composer-collision")).toBeNull();
    expect(screen.getByTestId("composer-worktree").hasAttribute("data-warning")).toBe(false);
  });

  it.each<[string, Partial<ThreadView>]>([
    ["stopped", { state: "disconnected" }],
    ["closing", { state: "closing" }],
    ["archived", { archivedAtMs: 1 }],
    ["snoozed", { snoozedUntilMs: Date.now() + 3_600_000 }],
  ])("a %s thread does not count", (_name, over) => {
    setThreads([thread("Fix login", over)]);
    render(<Composer projectId="web" />);
    expect(screen.queryByTestId("composer-collision")).toBeNull();
    expect(screen.getByTestId("composer-worktree").hasAttribute("data-warning")).toBe(false);
  });

  it("follows the thread: shown once it starts, gone once it stops", () => {
    setThreads([thread("Fix login", { state: "disconnected" })]);
    render(<Composer projectId="web" />);
    expect(screen.queryByTestId("composer-collision")).toBeNull();
    act(() => {
      setThreads([thread("Fix login", { state: "starting" })]);
    });
    expect(screen.getByTestId("composer-collision")).not.toBeNull();
    act(() => {
      setThreads([thread("Fix login", { state: "disconnected" })]);
    });
    expect(screen.queryByTestId("composer-collision")).toBeNull();
  });

  it("a set: x of y projects, and the colliding project's chip carries the icon", () => {
    useProjectsStore.setState({ byId: { web: project("web"), api: project("api") }, order: ["web", "api"], loaded: true });
    updateDraft(draftKey({ kind: "project", projectId: "web" }), { projects: ["web", "api"], worktree: { kind: "current" } });
    setThreads([thread("Fix login")]);
    render(<Composer projectId="web" />);
    expect(screen.getByTestId("composer-collision-text").textContent).toMatch(/^1 of 2 projects is already being edited on main by another running thread\. /);
    const chips = screen.getAllByTestId("composer-member");
    expect(chips.map((c) => [c.dataset.project, c.hasAttribute("data-warning")])).toEqual([
      ["api", false],
      ["web", true],
    ]);
    expect(screen.getAllByTestId("composer-member-warning")).toHaveLength(1);
    expect(screen.getAllByTestId("composer-collision")).toHaveLength(1);
  });
});
