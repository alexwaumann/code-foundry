import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
// No daemon: refs and skills never load (the composer shows them loading).
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => new Promise(() => undefined) }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));

const { Composer } = await import("./Composer");
const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { seedWorld, WR } = await import("@/test/projectsWorld");
const { sendDraft, updateDraft, useComposeStore } = await import("@/stores/compose");
const { useUiStore } = await import("@/stores/ui");

/**
 * The composer in a project without git (the mock's "writing", docs/notes/add-project-2-nogit.md):
 * only its current checkout, the No git badge where a branch would be, no base or branch, and a
 * thread.new without a new worktree. The thread's row (No git, no branch) is SidebarRow.test.tsx's,
 * its header crumb (the folder) ThreadParts.test.tsx's; typing into the real editor is e2e's.
 */

const target = { kind: "project", projectId: "repo-wr" } as const;

beforeEach(() => {
  // cmdk scrolls the highlighted row into view.
  Element.prototype.scrollIntoView = () => undefined;
  resetDaemon();
  seedWorld();
  act(() => {
    useUiStore.getState().select({ kind: "compose", projectId: "repo-wr" });
  });
});
afterEach(() => {
  cleanup();
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

describe("the composer in a project without git", () => {
  it("offers only its current checkout, with the No git badge and no base or branch; the thread starts there without a new worktree", async () => {
    render(<Composer projectId="repo-wr" />);
    expect(screen.getByTestId("composer-heading").textContent).toBe("What should we build in writing?");
    expect(screen.getByTestId("composer-worktree").textContent).toBe("Project folder");
    // A lone project: no chip, only Add project (a plain folder can be part of a set).
    expect(screen.queryByTestId("composer-member")).toBeNull();
    expect(screen.getByTestId("composer-add-project")).toBeTruthy();
    // The No git badge beside the worktree picker, where a branch would be.
    expect(within(screen.getByTestId("composer-card")).getByTestId("no-git-badge")).toBeTruthy();
    for (const id of ["composer-base", "composer-checkout-branch"]) expect(screen.queryByTestId(id)).toBeNull();

    fireEvent.click(screen.getByTestId("composer-worktree"));
    const options = within(screen.getByTestId("composer-worktree-list")).getAllByRole("option");
    expect(options.map((o) => o.textContent.replace(/\s+/g, " ").trim())).toHaveLength(1);
    expect(options[0]?.textContent).toMatch(/^Project folder\s*Edits land in the project's checkout directly/);
    fireEvent.keyDown(screen.getByTestId("composer-worktree-list"), { key: "Escape" });

    // What Enter sends (the editor's text is set here: typing into it is e2e's).
    act(() => {
      updateDraft("repo-wr", { text: "Outline chapter two" });
    });
    await act(async () => {
      await sendDraft(target, { model: "", effort: "" });
    });
    const args = invocationsOf("thread.new").at(-1)?.args;
    expect(args).toMatchObject({ project: "repo-wr", worktree: WR });
    expect(args).not.toHaveProperty("new-worktree");
  });
});
