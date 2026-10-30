// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { useAddProjectStore } from "@/stores/addProject";
import { useComposeStore } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { HOME, useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { ProjectPicker } from "./ProjectPicker";

const project = (id: string): ProjectView => ({ id, path: `/Users/dev/src/${id}`, name: id, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [] });

beforeAll(() => {
  // cmdk scrolls the highlighted row into view and measures the list; jsdom has neither.
  Element.prototype.scrollIntoView = () => undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe = () => undefined;
      unobserve = () => undefined;
      disconnect = () => undefined;
    },
  );
});

beforeEach(() => {
  useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login", branch: "cf/login", members: [{ projectId: "web", worktreePath: "/wt/web" }], createdAtMs: null } }, order: ["w-1"], loaded: true });
  useProjectsStore.setState({ byId: { web: project("web"), api: project("api") }, order: ["web", "api"], loaded: true });
  useUiStore.setState({ selection: HOME });
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

const items = () => Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]"));
/** The list's rows (not the pinned Add a project row), by workspace id, project id or test id. */
const listed = () =>
  Array.from(screen.getByTestId("picker-rows").querySelectorAll<HTMLElement>("[cmdk-item]")).map((r) => r.dataset.workspace ?? r.dataset.project ?? r.dataset.testid);
const highlighted = () => {
  const r = document.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
  return r?.dataset.workspace ?? r?.dataset.project ?? r?.dataset.testid;
};
const shortcutOf = (r: Element | undefined) => r?.querySelector("[data-slot=command-shortcut]")?.textContent;
const search = (q: string) => {
  fireEvent.change(screen.getByRole("combobox"), { target: { value: q } });
};
const key = (k: string, init: Partial<KeyboardEventInit> = {}) => {
  fireEvent.keyDown(screen.getByRole("combobox"), { key: k, ...init });
};

describe("ProjectPicker", () => {
  it("lists No project first, then workspaces, then projects, in one list without headings, each with its cmd+number", () => {
    render(<ProjectPicker close={() => undefined} />);
    expect(listed()).toEqual(["picker-no-project", "w-1", "web", "api"]);
    expect(document.querySelector("[cmdk-group-heading]")).toBeNull();
    expect(document.querySelector("[cmdk-separator]")).toBeNull();
    const rows = Array.from(screen.getByTestId("picker-rows").querySelectorAll("[cmdk-item]"));
    expect(rows.map(shortcutOf)).toEqual(["⌘1", "⌘2", "⌘3", "⌘4"]);
    expect(screen.getByTestId("picker-no-project").textContent).toBe("No project~⌘1");
  });

  it("highlights No project on open: Enter starts a no-project thread", () => {
    const close = vi.fn();
    render(<ProjectPicker close={close} />);
    expect(highlighted()).toBe("picker-no-project");
    key("Enter");
    expect(close).toHaveBeenCalledOnce();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
  });

  it("ranks a query across workspaces and projects in one list and highlights the top hit", () => {
    render(<ProjectPicker close={() => undefined} />);
    // web's name beats the workspace that only has web as a member, though workspaces come first by default.
    search("web");
    expect(listed()).toEqual(["web", "w-1"]);
    expect(highlighted()).toBe("web");
    search("log");
    expect(listed()).toEqual(["w-1"]);
    search("home");
    expect(listed()).toEqual(["picker-no-project"]);
    search("");
    expect(listed()).toEqual(["picker-no-project", "w-1", "web", "api"]);
    expect(highlighted()).toBe("picker-no-project");
  });

  it("cmd+number picks the nth row of the list on screen, and the hints follow it", () => {
    render(<ProjectPicker close={() => undefined} />);
    search("web");
    expect(shortcutOf(screen.getByTestId("picker-rows").querySelector('[data-project="web"]') ?? undefined)).toBe("⌘1");
    expect(shortcutOf(screen.getByTestId("picker-rows").querySelector('[data-workspace="w-1"]') ?? undefined)).toBe("⌘2");
    key("2", { metaKey: true });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "web", workspaceId: "w-1" });
  });

  it("cmd+number with an empty query: No project, a workspace and projects are ordinary rows", () => {
    render(<ProjectPicker close={() => undefined} />);
    key("4", { metaKey: true });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "api" });
  });

  it("clicking No project opens the no-project composer", () => {
    render(<ProjectPicker close={() => undefined} />);
    fireEvent.click(screen.getByTestId("picker-no-project"));
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
  });

  it("pins Add a project… below the list: last by the arrow keys, and it closes the picker and opens the Add Project dialog", async () => {
    useAddProjectStore.setState({ open: false });
    const close = vi.fn();
    render(<ProjectPicker close={close} />);
    const add = screen.getByTestId("picker-add-project");
    expect(screen.getByTestId("picker-rows").contains(add)).toBe(false);
    expect(add.textContent).toBe("Add a project…a folder on this Mac, or from GitHub");
    expect(add.getAttribute("aria-selected")).toBe("false");
    // Down through the rows to it; loop wraps from it back to the top, and Up from the top to it.
    for (const want of ["w-1", "web", "api", "picker-add-project", "picker-no-project", "picker-add-project"]) {
      key(want === "picker-add-project" && highlighted() === "picker-no-project" ? "ArrowUp" : "ArrowDown");
      expect(highlighted()).toBe(want);
    }
    key("Enter");
    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(useAddProjectStore.getState().open).toBe(true);
    });
  });

  it("keeps Add a project… when a query matches nothing, highlighted, with the empty text above it", () => {
    render(<ProjectPicker close={() => undefined} />);
    search("zzz-no-such-project");
    expect(listed()).toEqual([]);
    expect(items().map((r) => r.dataset.testid)).toEqual(["picker-add-project"]);
    expect(screen.getByText("No matching projects.")).toBeTruthy();
    expect(highlighted()).toBe("picker-add-project");
  });

  it("with no projects yet: No project listed, Add a project pinned and highlighted", () => {
    useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
    useProjectsStore.setState({ byId: {}, order: [], loaded: true });
    render(<ProjectPicker close={() => undefined} />);
    expect(listed()).toEqual(["picker-no-project"]);
    expect(highlighted()).toBe("picker-add-project");
  });

  it("before projects load: Loading projects… and Add a project highlighted; once they load, No project", () => {
    useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
    useProjectsStore.setState({ byId: {}, order: [], loaded: false });
    render(<ProjectPicker close={() => undefined} />);
    expect(listed()).toEqual([]);
    expect(screen.getByText("Loading projects…")).toBeTruthy();
    expect(highlighted()).toBe("picker-add-project");
    act(() => {
      useProjectsStore.setState({ byId: { web: project("web") }, order: ["web"], loaded: true });
    });
    expect(listed()).toEqual(["picker-no-project", "web"]);
    expect(highlighted()).toBe("picker-no-project");
  });
});
