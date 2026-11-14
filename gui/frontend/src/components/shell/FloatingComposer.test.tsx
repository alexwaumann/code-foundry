// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDraft, updateDraft } from "@/stores/compose";
import { useSettingsStore } from "@/stores/settings";
import { useThreadStore } from "@/stores/thread";
import { threadDraftKey } from "@/stores/threadActions";
import { seedComposer, settle } from "@/test/composerWorld";
import { invocationsOf } from "@/test/daemonFakes";
import { addThreads, CF, thread } from "@/test/projectsWorld";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));
vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));
// The Watch the expanded card holds: counted, never streamed.
const watching = new Map<string, number>();
vi.mock("@/stores/thread", async (orig) => ({
  ...(await orig<typeof import("@/stores/thread")>()),
  startThreadWatch: (id: string) => {
    watching.set(id, (watching.get(id) ?? 0) + 1);
    return () => {
      watching.set(id, (watching.get(id) ?? 0) - 1);
    };
  },
}));
// Bodies as markers.
vi.mock("@/components/thread/ThreadPane", () => ({ ThreadPane: ({ threadId }: { threadId: string }) => <div data-testid="body" data-body={`thread:${threadId}`} /> }));
vi.mock("@/components/diff/DiffView", () => ({ DiffView: ({ tabId }: { tabId: string }) => <div data-testid="body" data-body={`diff:${tabId}`} /> }));
vi.mock("@/components/compose/Composer", async (orig) => ({ ...(await orig<typeof import("@/components/compose/Composer")>()), Composer: () => <div data-testid="body" data-body="compose" /> }));

const { PaneView } = await import("./PaneView");
const { resetLayout } = await import("@/stores/layout");
const { resetShellView, useShellViewStore } = await import("@/stores/shellView");
const { enterFullscreen, leaveFullscreen } = await import("@/shell/fullscreen");

const RECT = { x: 0, y: 0, w: 1200, h: 800, rail: false };
let ID = "s-f1";
let seq = 0;

/** One pane holding the thread's tab, its diff, an empty composer and an unlinked terminal, `active` shown. */
async function showing(active: string): Promise<void> {
  const tabs = [tab("t-th", "thread", ID), tab("t-d", "diff", ID, { params: { project: "repo-cf", worktree: CF } }), tab("t-c", "compose"), tab("t-free", "terminal", "", { params: { terminal: "t-9" } })];
  await act(async () => {
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", tabs, active)]), "p-1")]));
  });
}

const floating = () => screen.queryByTestId("floating-composer");
const sends = () => invocationsOf("thread.send").map((i) => i.args);

beforeEach(() => {
  ID = `s-f${String(++seq)}`;
  watching.clear();
  seedComposer();
  useSettingsStore.setState((s) => ({ snapshot: s.snapshot ? { ...s.snapshot, values: { ...s.snapshot.values, "dictation.enabled": "false" } } : s.snapshot }));
  addThreads(thread(ID, { name: "Refactor sidebar tree", state: "connected", status: "idle", worktreePath: CF, checkoutPaths: [{ projectId: "repo-cf", path: CF }] }));
  act(() => {
    useThreadStore.setState({ logs: { [ID]: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: [] } } });
  });
  resetLayout();
  resetShellView();
});

afterEach(() => {
  cleanup();
  leaveFullscreen();
  resetLayout();
  resetShellView();
  useThreadStore.setState({ logs: {} });
});

describe("which full-screened tab gets the floating composer", () => {
  it("a linked surface does, only in full screen", async () => {
    await showing("t-d");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    expect(floating()).toBeNull();
    act(() => {
      enterFullscreen();
    });
    expect(floating()?.getAttribute("data-thread-id")).toBe(ID);
    expect(screen.getByTestId("floating-composer-pill").textContent).toContain("Refactor sidebar tree");
  });

  it.each(["t-th", "t-c", "t-free"])("%s (the thread itself, a composer, an unlinked tab) does not", async (active) => {
    await showing(active);
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    act(() => {
      enterFullscreen();
    });
    expect(floating()).toBeNull();
  });
});

describe("the floating composer", () => {
  async function fullscreenDiff(): Promise<void> {
    await showing("t-d");
    render(<PaneView paneId="p-1" rect={RECT} focused />);
    act(() => {
      enterFullscreen();
    });
  }

  it("is a pill that holds no stream; a click expands it into the thread's composer, which holds the thread's Watch", async () => {
    await fullscreenDiff();
    expect(watching.get(ID) ?? 0).toBe(0);
    expect(screen.queryByTestId("thread-composer")).toBeNull();
    fireEvent.click(screen.getByTestId("floating-composer-pill"));
    await settle();
    expect(floating()?.hasAttribute("data-expanded")).toBe(true);
    expect(screen.getByTestId("thread-composer")).toBeTruthy();
    expect(screen.getByTestId("floating-composer-chip").textContent).toContain("Refactor sidebar tree");
    expect(watching.get(ID)).toBe(1);
  });

  it("⌘L expands it", async () => {
    await fullscreenDiff();
    fireEvent.keyDown(window, { key: "l", metaKey: true });
    await settle();
    expect(useShellViewStore.getState().floating.expanded).toBe(true);
  });

  it("shows the thread's own draft: the same text as in the thread's pane", async () => {
    act(() => {
      updateDraft(threadDraftKey(ID), { text: "Drop the added line" });
    });
    await fullscreenDiff();
    fireEvent.click(screen.getByTestId("floating-composer-pill"));
    await settle();
    expect(screen.getByTestId("composer-input").textContent).toBe("Drop the added line");
  });

  it("sends to the thread from its draft, then collapses to the pill with the draft emptied", async () => {
    await fullscreenDiff();
    fireEvent.click(screen.getByTestId("floating-composer-pill"));
    await settle();
    act(() => {
      updateDraft(threadDraftKey(ID), { text: "Keep the rest of the hunk" });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("thread-send"));
    });
    await settle(20);
    expect(sends().map((s) => [s.id, s.text])).toEqual([[ID, "Keep the rest of the hunk"]]);
    expect(getDraft(threadDraftKey(ID)).text).toBe("");
    expect(useShellViewStore.getState().floating.expanded).toBe(false);
    expect(screen.getByTestId("floating-composer-pill")).toBeTruthy();
  });

  it("Escape in it collapses it and stays in full screen", async () => {
    await fullscreenDiff();
    fireEvent.click(screen.getByTestId("floating-composer-pill"));
    await settle();
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: "Escape" });
    expect(useShellViewStore.getState().floating.expanded).toBe(false);
    expect(useShellViewStore.getState().fullscreen).not.toBe("");
  });

  it("the pill and the chip are one button: a click toggles it both ways, and there is no other collapse control", async () => {
    await fullscreenDiff();
    const pill = screen.getByTestId("floating-composer-pill");
    expect(pill.tagName).toBe("BUTTON");
    expect(pill.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(pill);
    await settle();
    const chip = screen.getByTestId("floating-composer-chip");
    expect(chip.tagName).toBe("BUTTON");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(within(floating() as HTMLElement).getAllByRole("button", { expanded: true })).toEqual([chip]);
    expect(screen.queryByTestId("floating-composer-collapse")).toBeNull();
    fireEvent.click(chip);
    expect(useShellViewStore.getState().floating.expanded).toBe(false);
    expect(screen.getByTestId("floating-composer-pill")).toBeTruthy();
    expect(screen.queryByTestId("thread-composer")).toBeNull();
  });

  it("switching to the thread's own tab keeps full screen and drops the floating composer", async () => {
    await fullscreenDiff();
    await showing("t-th");
    expect(floating()).toBeNull();
    expect(screen.getByTestId("shell-pane").hasAttribute("data-fullscreen")).toBe(true);
  });
});
