// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "@/components/palette/CommandPalette";
import { ThreadComposer } from "@/components/thread/ThreadComposer";
import { getDraft, updateDraft } from "@/stores/compose";
import { threadDraftKey } from "@/stores/threadActions";
import { useSettingsStore } from "@/stores/settings";
import { useUiStore } from "@/stores/ui";
import { composeIn, seedComposer, settle } from "@/test/composerWorld";
import { SelectedComposer } from "@/test/SelectedComposer";
import { addThreads, CF, thread } from "@/test/projectsWorld";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));
vi.mock("@/api/thread", async (orig) => ({ ...(await orig<typeof import("@/api/thread")>()), ...(await import("@/test/composerFakes")).promptFakes }));
vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

/**
 * The "Previous prompts" picker (docs/notes/prompt-history-2-picker.md) over the mock's
 * prompts (src/test/composerFakes.ts promptFakes): the thread is "Fix stale PR badge" (s-r1
 * in code-foundry, two prompts); Project adds s-1, s-3 and s-4; All adds s-6 (dotfiles).
 * The keys go to the real editor's keydown handler, which hands them to the picker.
 */

const FIRST = "The PR badge in the sidebar stays green after a force-push";
const SECOND = "Looks good. Run the full suite, then push the branch.";
const ID = "s-r1";

const card = () => screen.queryByTestId("prompt-history");
const items = () => screen.queryAllByTestId("prompt-history-item");
const scopeTab = (root: HTMLElement, s: "thread" | "project" | "all") => within(root).getByTestId(`prompt-history-scope-${s}`);
const threadNames = () => screen.queryAllByTestId("prompt-history-thread").map((t) => t.textContent);
const placeholder = () => screen.getByTestId("composer-input").getAttribute("aria-placeholder");

/** Lets ListPrompts answer: a new scope or opening asks on a 0 ms timer, a new filter after its debounce. */
async function answered(ms = 20): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await settle(10);
}

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  act(() => {
    fireEvent.keyDown(screen.getByTestId("composer-input"), { key: k, ...init });
  });
  await answered();
}

/** The composer's text, as typing it would leave the draft (the filter while open). */
async function typeDraft(draftKey: string, text: string): Promise<void> {
  act(() => {
    updateDraft(draftKey, { text });
  });
  // The filter asks the daemon after its debounce.
  await answered(200);
}

beforeEach(() => {
  seedComposer();
  useSettingsStore.setState((s) => ({ snapshot: s.snapshot ? { ...s.snapshot, values: { ...s.snapshot.values, "dictation.enabled": "false" } } : s.snapshot }));
  addThreads(thread(ID, { name: "Fix stale PR badge", state: "connected", worktreePath: CF, checkoutPaths: [{ projectId: "repo-cf", path: CF }] }));
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

describe("the thread composer's picker (prompt-history-picker.spec.ts)", () => {
  const mount = async () => {
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: ID });
    });
    render(<ThreadComposer threadId={ID} pending={[]} busy={false} />);
    await settle();
  };

  it("Up on the empty composer opens it in This thread, newest first; the arrows wrap; Escape closes", async () => {
    await mount();
    expect(card()).toBeNull();
    await key("ArrowUp");
    const c = card();
    if (!c) throw new Error("no card");
    expect(c.getAttribute("data-scope")).toBe("thread");
    expect(scopeTab(c, "thread").getAttribute("data-state")).toBe("active");
    expect(items()).toHaveLength(2);
    expect(items()[0]?.querySelector('[data-testid="prompt-history-text"]')?.textContent).toBe(SECOND);
    expect(items()[1]?.querySelector('[data-testid="prompt-history-text"]')?.textContent).toContain(FIRST);
    // This thread: the sent time, no thread name.
    expect(items()[0]?.querySelector('[data-testid="prompt-history-time"]')?.textContent).not.toBe("");
    expect(threadNames()).toEqual([]);
    expect(items()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("prompt-history-heading").textContent).toBe("Previous prompts");
    expect(screen.getByTestId("prompt-history-hints").textContent).toContain("Show in thread");
    // The composer is now the filter.
    expect(placeholder()).toBe("Type to filter previous prompts");

    await key("ArrowDown");
    expect(items()[1]?.getAttribute("aria-selected")).toBe("true");
    await key("ArrowDown");
    expect(items()[0]?.getAttribute("aria-selected")).toBe("true");
    await key("Escape");
    expect(card()).toBeNull();
    expect(placeholder()).toBe("Reply or ask anything. @ files and threads, / skills and commands");
  });

  it("not over a draft; the text filters with its hits marked; no matches; Escape keeps the typed draft", async () => {
    await mount();
    await typeDraft(threadDraftKey(ID), "x");
    await key("ArrowUp");
    expect(card()).toBeNull();
    await typeDraft(threadDraftKey(ID), "");
    await key("ArrowUp");
    expect(items()).toHaveLength(2);
    await typeDraft(threadDraftKey(ID), "BADGE");
    expect(items()).toHaveLength(1);
    expect(items()[0]?.querySelector('[data-testid="prompt-history-hit"]')?.textContent).toBe("badge");
    expect(screen.getByTestId("prompt-history-heading").textContent).toBe("Previous prompts · 1 match");
    await typeDraft(threadDraftKey(ID), "BADGEzzz");
    expect(screen.getByTestId("prompt-history-status").textContent).toBe("No matches");
    await key("Escape");
    expect(card()).toBeNull();
    expect(getDraft(threadDraftKey(ID)).text).toBe("BADGEzzz");
  });

  it("cmd+S cycles the scope: Project and All name each prompt's thread and age; the toggle switches too; Project filters", async () => {
    await mount();
    await key("ArrowUp");
    await key("s", { metaKey: true });
    const c = () => {
      const el = card();
      if (!el) throw new Error("no card");
      return el;
    };
    expect(c().getAttribute("data-scope")).toBe("project");
    expect(scopeTab(c(), "project").getAttribute("data-state")).toBe("active");
    expect(threadNames()).toContain("Fix resize race");
    expect(threadNames()).toContain("Fix stale PR badge");
    // dotfiles' thread is not in Project.
    expect(threadNames()).not.toContain("Tidy zshrc");
    expect(screen.getAllByTestId("prompt-history-age")[0]?.textContent).not.toBe("");
    await key("s", { metaKey: true });
    expect(c().getAttribute("data-scope")).toBe("all");
    expect(threadNames()).toContain("Tidy zshrc");
    await key("s", { metaKey: true });
    expect(c().getAttribute("data-scope")).toBe("thread");
    act(() => {
      fireEvent.mouseDown(scopeTab(c(), "project"), { button: 0 });
    });
    await answered();
    expect(c().getAttribute("data-scope")).toBe("project");
    await typeDraft(threadDraftKey(ID), "resize");
    expect(screen.getByTestId("prompt-history-heading").textContent).toMatch(/^Previous prompts · \d+ match/);
    expect(threadNames()).toContain("Fix resize race");
  });

  it("cmd+Enter in Project shows the prompt in its thread", async () => {
    await mount();
    await key("ArrowUp");
    await key("s", { metaKey: true });
    await typeDraft(threadDraftKey(ID), "useResize");
    expect(items()).toHaveLength(1);
    await key("Enter", { metaKey: true });
    expect(card()).toBeNull();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-3" });
  });
});

describe("the new-thread composer's picker (prompt-history-picker.spec.ts)", () => {
  it("opens in Project with This thread disabled; cmd+S skips This thread; Enter puts the prompt back with its tags", async () => {
    composeIn("repo-cf");
    render(<SelectedComposer />);
    await settle();
    await key("ArrowUp");
    const c = () => {
      const el = card();
      if (!el) throw new Error("no card");
      return el;
    };
    expect(c().getAttribute("data-scope")).toBe("project");
    expect(scopeTab(c(), "thread")).toHaveProperty("disabled", true);
    expect(threadNames()).toContain("Refactor sidebar tree");
    expect(placeholder()).toBe("Type to filter previous prompts");
    await key("s", { metaKey: true });
    expect(c().getAttribute("data-scope")).toBe("all");
    await key("s", { metaKey: true });
    expect(c().getAttribute("data-scope")).toBe("project");
    await typeDraft("repo-cf", "keyboard navigation");
    expect(items()).toHaveLength(1);
    await key("Enter");
    expect(card()).toBeNull();
    expect(getDraft("repo-cf").text).toBe("Keep the keyboard navigation from [Fix resize race](cf-thread://s-3)");
  });
});

describe("composer.history's palette page (prompt-history-picker.spec.ts)", () => {
  it("This thread first; cmd+S cycles; the input filters; Enter puts the prompt in the thread's draft", async () => {
    act(() => {
      useUiStore.getState().select({ kind: "thread", id: ID });
    });
    render(<CommandPalette />);
    act(() => {
      useUiStore.getState().openPromptsPalette();
    });
    await answered();
    const palette = screen.getByTestId("palette");
    expect(palette.getAttribute("data-mode")).toBe("prompts");
    const input = within(palette).getByPlaceholderText("Search previous prompts…");
    expect(scopeTab(palette, "thread").getAttribute("data-state")).toBe("active");
    expect(items()).toHaveLength(2);
    expect(screen.getByTestId("prompt-history-hints").textContent).toContain("Insert into composer");
    const cycle = async () => {
      act(() => {
        fireEvent.keyDown(input, { key: "s", metaKey: true });
      });
      await answered();
    };
    const search = async (q: string) => {
      act(() => {
        fireEvent.change(input, { target: { value: q } });
      });
      await answered(200);
    };
    await cycle();
    expect(scopeTab(palette, "project").getAttribute("data-state")).toBe("active");
    await search("suite");
    expect(items().length).toBeGreaterThan(0);
    expect(items()[0]?.querySelector('[data-testid="prompt-history-hit"]')).not.toBeNull();
    await cycle();
    await cycle();
    expect(scopeTab(palette, "thread").getAttribute("data-state")).toBe("active");
    expect(items()).toHaveLength(1);
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(getDraft(threadDraftKey(ID)).text).toBe(SECOND);
  });
});
