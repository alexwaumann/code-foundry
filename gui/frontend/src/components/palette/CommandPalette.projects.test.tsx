import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/addProjectFakes")).filesystemFakes }));

const { CommandPalette } = await import("./CommandPalette");
const { daemon, lastInvocation, resetDaemon } = await import("@/test/daemonFakes");
const { resetAddProjectFakes } = await import("@/test/addProjectFakes");
const { seedWorld } = await import("@/test/projectsWorld");
const { useAddProjectStore } = await import("@/stores/addProject");
const { usePublishDialogStore } = await import("@/stores/publish");
const { useCommandsStore } = await import("@/stores/commands");
const { useUiStore } = await import("@/stores/ui");

/**
 * The command palette's project commands (docs/notes/add-project-4-create.md): the ones with
 * their own dialog open it instead of prompting, and a path prompt completes folders as the
 * Add Project dialog does but takes a clicked one (no chevron). Which commands the daemon lists
 * where is internal/command's (commands_project_create_test.go); e2e keeps cmd+k itself.
 */

const command = (name: string, title: string, o: Partial<CommandView> = {}): CommandView => ({ name, title, description: "", category: "Project", args: [], keybindings: [], available: true, ...o });

const COMMANDS: CommandView[] = [
  command("project.add", "Add Project", { args: [{ name: "path", type: "path", required: true, description: "Folder", enumValues: [], defaultValue: "" }] }),
  command("project.create", "New Project", { args: [{ name: "name", type: "string", required: true, description: "Name", enumValues: [], defaultValue: "" }] }),
  command("project.github.publish", "Publish to GitHub", { args: [{ name: "name", type: "string", required: false, description: "Name", enumValues: [], defaultValue: "" }] }),
  command("dev.path", "Echo Path", { category: "Developer", description: "Report a folder (the palette's path prompt)", args: [{ name: "path", type: "path", required: true, description: "Folder", enumValues: [], defaultValue: "" }] }),
];

const palette = () => screen.getByTestId("palette");
const row = (name: string) => document.querySelector<HTMLElement>(`[cmdk-item][data-command="${name}"]`);
const entry = (name: string) => document.querySelector<HTMLElement>(`[data-testid="path-entry"][data-entry-name="${name}"]`);

async function settle(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** Opens the palette (cmd+k's openPalette) over the current selection, its list loaded. */
async function openPalette() {
  render(<CommandPalette />);
  act(() => {
    useUiStore.getState().openPalette();
  });
  await waitFor(() => {
    expect(row("dev.path")).not.toBeNull();
  });
}

beforeEach(() => {
  // cmdk scrolls its highlighted row into view.
  Element.prototype.scrollIntoView = () => undefined;
  resetDaemon();
  resetAddProjectFakes();
  seedWorld();
  daemon.commands = COMMANDS;
  useCommandsStore.setState({ commands: [], contextKey: "", loading: false, error: null });
  useAddProjectStore.setState({ open: false });
  usePublishDialogStore.setState({ open: false, projectId: "" });
});
afterEach(() => {
  act(() => {
    useUiStore.getState().closePalette();
  });
  cleanup();
});

describe("the palette's project commands", () => {
  it("project.github.publish opens the publish dialog for the composer's project; project.create opens New; neither invokes", async () => {
    // The composer for sketches (its page's New thread) gives the palette the project's context.
    act(() => {
      useUiStore.getState().select({ kind: "compose", projectId: "repo-sk" });
    });
    await openPalette();
    fireEvent.click(row("project.github.publish") as HTMLElement);
    await settle();
    expect(screen.queryByTestId("palette")).toBeNull();
    expect(usePublishDialogStore.getState()).toMatchObject({ open: true, projectId: "repo-sk" });
    cleanup();

    // A project with origin: the daemon lists publish as unavailable there, so the palette leaves it out.
    daemon.commands = COMMANDS.map((c) => (c.name === "project.github.publish" ? { ...c, available: false } : c));
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: "s-1" });
    });
    await openPalette();
    expect(row("project.github.publish")).toBeNull();
    fireEvent.click(row("project.create") as HTMLElement);
    await settle();
    expect(useAddProjectStore.getState()).toMatchObject({ open: true, tab: "new" });
    expect(daemon.invocations.filter((i) => i.name.startsWith("project."))).toEqual([]);
  });

  it("a path prompt lists folders with no chevron; Use ~/ is offered; a clicked folder is the answer", async () => {
    await openPalette();
    fireEvent.click(row("dev.path") as HTMLElement);
    await settle();
    expect(palette().getAttribute("data-mode")).toBe("args");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "~/" } });
    await settle(200);
    await waitFor(() => {
      expect(entry("src")).not.toBeNull();
    });
    expect(screen.getByText("Use").parentElement?.textContent).toBe("Use ~/");
    expect(document.querySelector('[data-testid="path-entry-open"]')).toBeNull();
    fireEvent.click(entry("src") as HTMLElement);
    await settle();
    expect(screen.queryByTestId("palette")).toBeNull();
    expect(daemon.invocations.at(-1)?.name).toBe("dev.path");
    expect(lastInvocation("dev.path")?.args).toEqual({ path: "~/src" });
  });
});
