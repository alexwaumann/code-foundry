// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { useAddProjectStore } from "@/stores/addProject";
import { useComposeStore } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useUiStore } from "@/stores/ui";
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
  useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
});

afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]"));

describe("ProjectPicker and No project", () => {
  it("lists No project after the projects, with ~ and no cmd+number shortcut; the first project stays highlighted", () => {
    render(<ProjectPicker close={() => undefined} />);
    const all = rows();
    const last = all.at(-2);
    expect(all.map((r) => r.dataset.workspace ?? r.dataset.project ?? r.dataset.testid)).toEqual(["w-1", "web", "api", "picker-no-project", "picker-add-project"]);
    expect(last?.textContent).toBe("No project~");
    expect(last?.querySelector("[data-slot=command-shortcut]")).toBeNull();
    expect(all[1]?.querySelector("[data-slot=command-shortcut]")).not.toBeNull();
    expect(all[0]?.getAttribute("aria-selected")).toBe("true");
    expect(last?.getAttribute("aria-selected")).toBe("false");
  });

  it("picking it opens the no-project composer", () => {
    render(<ProjectPicker close={() => undefined} />);
    fireEvent.click(screen.getByTestId("picker-no-project"));
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
  });

  it("ends with Add a project…, which closes the picker and opens the Add Project dialog", async () => {
    useAddProjectStore.setState({ open: false });
    const close = vi.fn();
    render(<ProjectPicker close={close} />);
    const add = screen.getByTestId("picker-add-project");
    expect(add.textContent).toBe("Add a project…a folder on this Mac, or from GitHub");
    expect(add.getAttribute("aria-selected")).toBe("false");
    fireEvent.click(add);
    expect(close).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(useAddProjectStore.getState().open).toBe(true);
    });
  });

  it("keeps Add a project… when a search matches nothing", () => {
    render(<ProjectPicker close={() => undefined} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzz-no-such-project" } });
    expect(rows().map((r) => r.dataset.testid)).toEqual(["picker-add-project"]);
  });

  it("with no projects yet: Add a project first, then No project", () => {
    useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
    useProjectsStore.setState({ byId: {}, order: [], loaded: true });
    render(<ProjectPicker close={() => undefined} />);
    expect(rows().map((r) => r.dataset.testid)).toEqual(["picker-add-project", "picker-no-project"]);
    expect(rows()[0]?.getAttribute("aria-selected")).toBe("true");
  });
});
