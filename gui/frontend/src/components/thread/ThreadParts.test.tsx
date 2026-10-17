import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { ThreadTitle } from "./ThreadParts";

const startCommandNamed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/keys/bindings", async (orig) => ({ ...(await orig<typeof import("@/keys/bindings")>()), startCommandNamed }));

const cmd = (name: string): CommandView => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });

const thread = (o: Partial<ThreadView>) =>
  ({ id: "s-1", name: "Fix the stale PR badge", projectId: "cf", worktreePath: "/src/cf.worktrees/pr-badge", workspaceId: "", pendingWorktreePath: "", state: "connected", status: "idle", model: "opus", effort: "high", linkedPullRequests: [], ...o }) as ThreadView;

type Worktree = { path: string; branch: string; head: string; isMain?: boolean };
function repo(name: string, worktrees: Worktree[], git = true) {
  return { id: name, name, git, worktrees } as unknown as ReturnType<typeof useProjectsStore.getState>["byId"][string];
}

beforeEach(() => {
  useCommandsStore.setState({ commands: [cmd("thread.rename"), cmd("view.panel.worktree")] });
  useProjectsStore.setState({
    byId: {
      cf: repo("code-foundry", [
        { path: "/src/cf", branch: "main", head: "abc", isMain: true },
        { path: "/src/cf.worktrees/pr-badge", branch: "cf/pr-badge-stale", head: "def", isMain: false },
      ]),
      notes: repo("scratch notes", [{ path: "/src/notes", branch: "", head: "", isMain: true }], false),
    },
    order: ["cf", "notes"],
  });
  useThreadsStore.setState({ byId: { "s-1": thread({}) }, order: ["s-1"] });
});

afterEach(() => {
  cleanup();
  startCommandNamed.mockClear();
});

const title = () => screen.getByTestId("thread-title");
const location = () => screen.getByTestId("thread-location");

describe("ThreadTitle", () => {
  it("names the thread; a click renames it through thread.rename", () => {
    render(<ThreadTitle id="s-1" />);
    expect(title().tagName).toBe("BUTTON");
    expect(title().textContent).toBe("Fix the stale PR badge");
    expect(title().getAttribute("title")).toBeNull();
    fireEvent.click(title());
    expect(startCommandNamed).toHaveBeenCalledWith("thread.rename");
  });

  it("shows no status, badge text, model or path", () => {
    render(<ThreadTitle id="s-1" />);
    const text = document.body.textContent;
    expect(text).not.toContain("opus");
    expect(text).not.toContain("Connected");
    expect(text).not.toContain("/src/cf");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it.each([
    ["a linked worktree: project @ branch and the worktree chip", "/src/cf.worktrees/pr-badge", "cf", "code-foundry@cf/pr-badge-staleworktree", true],
    ["the main checkout: no chip", "/src/cf", "cf", "code-foundry@main", false],
    ["no git: the folder and No git, no branch", "/src/notes", "notes", "scratch notesNo git", false],
  ])("%s", (_name, worktreePath, projectId, text, chip) => {
    useThreadsStore.setState({ byId: { "s-1": thread({ worktreePath, projectId }) } });
    render(<ThreadTitle id="s-1" />);
    expect(location().textContent).toBe(text);
    expect(screen.queryByTestId("thread-worktree-chip") !== null).toBe(chip);
    expect(screen.queryByTestId("thread-branch") === null).toBe(projectId === "notes");
    expect(screen.queryByTestId("no-git-badge") !== null).toBe(projectId === "notes");
  });

  it("opens the worktree surface through view.panel.worktree; plain text where it is unavailable", () => {
    render(<ThreadTitle id="s-1" />);
    expect(location().tagName).toBe("BUTTON");
    expect(location().getAttribute("title")).toBeNull();
    fireEvent.click(location());
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.worktree");
    cleanup();

    useCommandsStore.setState({ commands: [] });
    render(<ThreadTitle id="s-1" />);
    expect(location().tagName).toBe("SPAN");
    expect(location().textContent).toBe("code-foundry@cf/pr-badge-staleworktree");
    expect(title().tagName).toBe("SPAN");
    expect(title().textContent).toBe("Fix the stale PR badge");
  });

  it("no project: the House icon and No project, no branch or chip, plain text without view.panel.worktree", () => {
    useCommandsStore.setState({ commands: [cmd("thread.rename")] });
    useThreadsStore.setState({ byId: { "s-1": thread({ projectId: "", worktreePath: "/Users/dev" }) } });
    render(<ThreadTitle id="s-1" />);
    expect(location().tagName).toBe("SPAN");
    expect(location().textContent).toBe("No project");
    expect(location().querySelector("svg.lucide-house")).not.toBeNull();
    expect(screen.queryByTestId("thread-branch")).toBeNull();
    expect(screen.queryByTestId("thread-worktree-chip")).toBeNull();
  });

  it("an unnamed thread shows its id", () => {
    useThreadsStore.setState({ byId: { "s-1": thread({ name: "" }) } });
    render(<ThreadTitle id="s-1" />);
    expect(title().textContent).toBe("s-1");
  });
});

describe("ThreadTitle created-by chip", () => {
  const chip = () => screen.queryByTestId("thread-created-by");
  const child = { createdBy: "s-p", createdByName: "Fix login redirect" };

  it("is absent for the user's thread", () => {
    render(<ThreadTitle id="s-1" />);
    expect(chip()).toBeNull();
  });

  it("names the creator after the thread's name, before the location; a click opens the Threads surface", () => {
    useCommandsStore.setState({ commands: [cmd("thread.rename"), cmd("view.panel.worktree"), cmd("view.panel.threads")] });
    useThreadsStore.setState({ byId: { "s-1": thread(child), "s-p": thread({ id: "s-p", name: "Fix login redirect", archivedAtMs: 5 }) }, order: ["s-p", "s-1"] });
    const { container } = render(<ThreadTitle id="s-1" />);
    const c = chip() as HTMLElement;
    expect(c.tagName).toBe("BUTTON");
    expect(c.textContent).toBe("from Fix login redirect");
    expect(c.querySelector("svg.lucide-corner-down-right")).not.toBeNull();
    expect(c.getAttribute("data-removed")).toBeNull();
    // Name, chip, location in that order.
    expect([...container.children].map((e) => e.getAttribute("data-testid"))).toEqual(["thread-title", "thread-created-by", "thread-location"]);
    fireEvent.click(c);
    expect(startCommandNamed).toHaveBeenCalledWith("view.panel.threads");
  });

  it("is inert and muted once the creator was removed, keeping its recorded name", () => {
    useCommandsStore.setState({ commands: [cmd("thread.rename"), cmd("view.panel.threads")] });
    useThreadsStore.setState({ byId: { "s-1": thread(child) }, order: ["s-1"] });
    render(<ThreadTitle id="s-1" />);
    const c = chip() as HTMLElement;
    expect(c.tagName).toBe("SPAN");
    expect(c.getAttribute("data-removed")).toBe("true");
    expect(c.className).toContain("opacity-60");
    expect(c.className).not.toContain("hover:");
    expect(c.textContent).toBe("from Fix login redirect");
    fireEvent.click(c);
    expect(startCommandNamed).not.toHaveBeenCalled();
  });
});
