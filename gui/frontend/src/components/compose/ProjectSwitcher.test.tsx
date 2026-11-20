import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposeTarget } from "@/lib/compose";
import { addWorkspace, seedWorld } from "@/test/projectsWorld";

const retargetComposeTab = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const switchDraftTarget = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
const setDraftProject = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/compose", async (orig) => ({ ...(await orig<typeof import("@/stores/compose")>()), retargetComposeTab, switchDraftTarget, setDraftProject }));

const { ProjectSwitcher } = await import("./ProjectSwitcher");

/**
 * Which store call the heading's picker makes: in a shell compose tab, a pick of another target
 * moves the tab (retargetComposeTab, its params written); the classic window moves the selection.
 */

const cf: ComposeTarget = { kind: "project", projectId: "repo-cf", draft: "d-1" };

function mount(target: ComposeTarget, tabId?: string) {
  render(<ProjectSwitcher target={target} name="code-foundry" set={{ projectIds: ["repo-cf"], workspaceId: "" }} disabled={false} focusPrompt={() => undefined} tabId={tabId} />);
}

/** Opens the picker and clicks a row: a project's by id, or "No project". */
async function pick(row: string): Promise<void> {
  fireEvent.click(screen.getByTestId("composer-project-trigger"));
  const list = await screen.findByTestId("composer-project-list");
  const el = list.querySelector<HTMLElement>(row === "No project" ? '[data-testid="picker-no-project"]' : `[data-project="${row}"]`);
  if (!el) throw new Error(`no row ${row}`);
  fireEvent.click(el);
}

describe("ProjectSwitcher in a compose tab", () => {
  beforeEach(() => {
    seedWorld();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  it.each([
    ["another project", "repo-gp", { kind: "project", projectId: "repo-gp" }],
    ["No project", "No project", { kind: "home" }],
  ])("%s moves the tab itself", async (_what, row, to) => {
    mount(cf, "t-c");
    await pick(row);
    await waitFor(() => {
      expect(retargetComposeTab).toHaveBeenCalledWith("t-c", cf, to);
    });
    expect(switchDraftTarget).not.toHaveBeenCalled();
    expect(setDraftProject).not.toHaveBeenCalled();
  });

  it("its own project narrows the set in place", async () => {
    mount(cf, "t-c");
    await pick("repo-cf");
    await waitFor(() => {
      expect(setDraftProject).toHaveBeenCalledWith(cf, "repo-cf");
    });
    expect(retargetComposeTab).not.toHaveBeenCalled();
  });

  it("outside the shell, No project moves the selection as before", async () => {
    mount({ kind: "project", projectId: "repo-cf" });
    await pick("No project");
    await waitFor(() => {
      expect(switchDraftTarget).toHaveBeenCalledWith({ kind: "project", projectId: "repo-cf" }, { kind: "home" });
    });
    expect(retargetComposeTab).not.toHaveBeenCalled();
  });
});

describe("ProjectSwitcher with a query", () => {
  beforeEach(() => {
    seedWorld();
    vi.clearAllMocks();
  });
  afterEach(cleanup);

  /** Opens the picker and types into its filter; the rows shown, as "project:<id>" or "workspace:<id>". */
  async function type(query: string): Promise<string[]> {
    fireEvent.click(screen.getByTestId("composer-project-trigger"));
    const list = await screen.findByTestId("composer-project-list");
    fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: query } });
    return [...list.querySelectorAll<HTMLElement>("[data-project], [data-workspace]")].map((el) => (el.dataset.project ? `project:${el.dataset.project}` : `workspace:${el.dataset.workspace ?? ""}`));
  }

  it("lists the project named by the query above the workspace that contains it, with no group headings; Enter picks it", async () => {
    const ws = addWorkspace("everything", ["repo-cf", "repo-dot"]);
    mount(cf, "t-c");
    expect(await type("dotfiles")).toEqual(["project:repo-dot", `workspace:${ws.id}`]);
    expect(screen.queryByText("Workspaces")).toBeNull();
    expect(screen.queryByText("Projects")).toBeNull();
    fireEvent.keyDown(screen.getByLabelText("Filter projects"), { key: "Enter" });
    await waitFor(() => {
      expect(retargetComposeTab).toHaveBeenCalledWith("t-c", cf, { kind: "project", projectId: "repo-dot" });
    });
  });

  it("clearing the query brings the groups back", async () => {
    addWorkspace("everything", ["repo-cf", "repo-dot"]);
    mount(cf, "t-c");
    await type("dotfiles");
    fireEvent.change(screen.getByLabelText("Filter projects"), { target: { value: "" } });
    expect(screen.getByText("Workspaces")).toBeTruthy();
    expect(screen.getByText("Projects")).toBeTruthy();
    expect(screen.getByTestId("picker-no-project")).toBeTruthy();
  });

  it("says so when nothing matches", async () => {
    mount(cf, "t-c");
    expect(await type("zzzz")).toEqual([]);
    expect(screen.getByText("No matching projects.")).toBeTruthy();
  });
});

