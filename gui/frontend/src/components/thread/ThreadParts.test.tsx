import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { useWorkspacesStore } from "@/stores/workspaces";
import { tooltipText } from "@/test/tooltip";
import { HeaderActions } from "./HeaderActions";
import { ThreadTitle } from "./ThreadParts";

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: `Thread ${id}`, projectId: "web", worktreePath: "/src/web", workspaceId: "", projectIds: ["web"], pendingWorktreePath: "", createdBy: "", createdByName: "", parentId: "", checkoutPaths: [], flags: [], ...o }) as ThreadView;
const PROJECT = (id: string) => ({ id, name: id, git: true, githubSlug: "", remotes: [], worktrees: [{ path: `/src/${id}`, branch: "main", head: "a", isMain: true }] });

function show(o: Partial<ThreadView>, others: ThreadView[] = []): void {
  const all = [thread("s-1", o), ...others];
  useThreadsStore.setState({ byId: Object.fromEntries(all.map((t) => [t.id, t])), order: all.map((t) => t.id) });
  render(<ThreadTitle id="s-1" />);
}

const crumb = () => screen.getByTestId("thread-crumb");

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: PROJECT("web"), api: PROJECT("api") } as never, order: ["web", "api"] });
  useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "platform", members: [] } } as never, order: ["w-1"] });
  useUiStore.setState({ selection: { kind: "thread", id: "s-1" } });
});

afterEach(cleanup);

describe("the thread header's crumb", () => {
  it.each<[string, Partial<ThreadView>, string, string]>([
    ["one project", {}, "folder", "web"],
    ["a named workspace", { workspaceId: "w-1", projectIds: ["web", "api"] }, "layers", "platform"],
    ["an unnamed set", { projectIds: ["web", "api"] }, "folders", "web +1"],
    ["no project", { projectId: "", projectIds: [], worktreePath: "/Users/me" }, "house", "No project"],
  ])("%s: its icon and place, then the title", (_n, o, icon, label) => {
    show(o);
    expect(crumb().dataset.icon).toBe(icon);
    expect(screen.getByTestId("thread-crumb-place").textContent).toBe(label);
    expect(screen.queryByTestId("thread-crumb-parent")).toBeNull();
    expect(screen.getByTestId("thread-title-name").textContent).toBe("Thread s-1");
  });

  it("a child: the place, then its parent, which opens on a click", () => {
    show({ createdBy: "s-0" }, [thread("s-0", { name: "Auth rollout plan" })]);
    const parent = screen.getByTestId("thread-crumb-parent");
    expect(parent.textContent).toBe("Auth rollout plan");
    fireEvent.click(parent);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-0" });
  });

  it("the parent follows a rename, and a removed creator is plain text", () => {
    show({ createdBy: "s-0", createdByName: "At creation" }, [thread("s-0", { name: "Plan" })]);
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-0": thread("s-0", { name: "Plan v2" }) } }));
    });
    expect(screen.getByTestId("thread-crumb-parent").textContent).toBe("Plan v2");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { "s-1": s.byId["s-1"] as ThreadView }, order: ["s-1"] }));
    });
    const removed = screen.getByTestId("thread-crumb-parent");
    expect(removed.textContent).toBe("At creation");
    expect(removed.tagName).toBe("SPAN");
    expect(removed.dataset.removed).toBe("true");
  });

  it("a warning dot on the chevron while the plugin environment changed, its tooltip pointing at the menu", () => {
    show({});
    expect(screen.queryByTestId("thread-title-stale")).toBeNull();
    expect(tooltipText(screen.getByTestId("thread-title"))).toBeNull();
    act(() => {
      screen.getByTestId("thread-title").blur();
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-1": thread("s-1", { pluginEnvStale: true, pluginEnvChange: "Hello removed CF_HELLO" }) } }));
    });
    const dot = screen.getByTestId("thread-title-stale");
    expect(dot.className).toContain("bg-cf-warning");
    expect(dot.getAttribute("aria-label")).toBe("Plugin environment changed · Restart Claude from this menu");
    expect(tooltipText(screen.getByTestId("thread-title"))).toBe("Plugin environment changed · Restart Claude from this menu");
  });

  it("Transcript deleted sits in the bar right after the title", () => {
    show({ transcriptMissing: true });
    const chip = screen.getByTestId("thread-transcript-deleted");
    expect(chip.parentElement).toBe(screen.getByTestId("thread-title-bar"));
    expect(chip.previousElementSibling).toBe(screen.getByTestId("thread-title"));
  });

  it("a provisional name is muted and italic", () => {
    show({ nameProvisional: true });
    expect(screen.getByTestId("thread-title-name").className).toContain("italic");
  });

  it("the title is a menu button with its chevron; Enter opens the thread's menu", () => {
    show({});
    const title = screen.getByTestId("thread-title");
    expect(title.tagName).toBe("BUTTON");
    expect(title.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(title.getAttribute("aria-expanded")).toBe("false");
    fireEvent.keyDown(title, { key: "Enter" });
    expect(title.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("thread-title-menu")).toBeTruthy();
  });
});

describe("the thread header's right side", () => {
  it("is the three toggles only", () => {
    const cmd = (name: string) => ({ name, title: name, description: "", category: "", args: [], keybindings: [], available: true });
    useCommandsStore.setState({ commands: ["view.thread-info", "view.bottom.toggle", "view.panel.toggle", "thread.snooze", "thread.archive", "thread.sidebar"].map(cmd) });
    useThreadsStore.setState({ byId: { "s-1": thread("s-1") }, order: ["s-1"] });
    render(<HeaderActions />);
    expect([...screen.getByTestId("pane-actions").querySelectorAll("button")].map((b) => b.dataset.testid)).toEqual([
      "thread-info-toggle",
      "bottom-toggle",
      "panel-toggle",
    ]);
  });
});
