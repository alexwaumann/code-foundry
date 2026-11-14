import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalView } from "@/api/terminal";
import { CHAT_MIN, focusQuick, QUICK_DEFAULT, QUICK_MIN, QUICK_TOP_ROOM, quickHasFocus, quickHeight, quickKeyAction, quickMode, quickTerminalOf, registerQuickHost, resetQuickHosts } from "./quickTerminal";

afterEach(() => {
  resetQuickHosts();
  document.body.innerHTML = "";
});

describe("cmd+j (quickKeyAction)", () => {
  const thread = { kind: "thread", thread: "s-1" };
  it.each([
    ["closed, on the thread's tab: open and focus it", thread, false, false, "open"],
    ["open, the keyboard elsewhere: focus it", thread, true, false, "focus"],
    ["open, with the keyboard: close it", thread, true, true, "close"],
    ["on a linked surface: go to its thread and open it", { kind: "diff", thread: "s-1" }, false, false, "goto"],
    ["on a linked terminal tab, open or not: the same", { kind: "terminal", thread: "s-1" }, true, false, "goto"],
    ["on a tab of no thread: nothing", { kind: "prs", thread: "" }, false, false, "none"],
    ["with no tab: nothing", null, false, false, "none"],
  ] as const)("%s", (_name, tab, open, focused, want) => {
    expect(quickKeyAction(tab, open, focused)).toBe(want);
  });
});

describe("push or overlay", () => {
  const chrome = 44 + 160;
  it("pushes while the chrome and CHAT_MIN of conversation fit above it, overlays when they do not", () => {
    expect(quickMode(800, 260, chrome)).toBe("push");
    expect(quickMode(chrome + CHAT_MIN + 260, 260, chrome)).toBe("push");
    expect(quickMode(chrome + CHAT_MIN + 259, 260, chrome)).toBe("overlay");
    expect(quickMode(400, 260, chrome)).toBe("overlay");
  });

  it("keeps its height inside the pane: the default before a drag, never under its minimum, the header's room above", () => {
    expect(quickHeight(0, 900)).toBe(QUICK_DEFAULT);
    expect(quickHeight(320, 900)).toBe(320);
    expect(quickHeight(20, 900)).toBe(QUICK_MIN);
    expect(quickHeight(800, 500)).toBe(500 - QUICK_TOP_ROOM);
    expect(quickHeight(300, 100)).toBe(QUICK_MIN);
  });
});

describe("quickTerminalOf", () => {
  const t = (id: string, labels: Record<string, string>, state: TerminalView["state"] = "running") => ({ id, labels, state }) as TerminalView;
  it("is the thread's running shell in the quick slot", () => {
    const byId = {
      a: t("a", { kind: "shell", thread: "s-1" }),
      b: t("b", { kind: "shell", thread: "s-1", slot: "quick" }, "exited"),
      c: t("c", { kind: "shell", thread: "s-2", slot: "quick" }),
      d: t("d", { kind: "shell", thread: "s-1", slot: "quick" }),
    };
    expect(quickTerminalOf(byId, ["a", "b", "c", "d"], "s-1")?.id).toBe("d");
    expect(quickTerminalOf(byId, ["a", "b"], "s-1")).toBeNull();
  });
});

describe("the quick terminal's keyboard", () => {
  it("focuses a mounted host, or the next one to mount for that thread", () => {
    const now = vi.fn();
    const stop = registerQuickHost("s-1", now);
    focusQuick("s-1");
    expect(now).toHaveBeenCalledTimes(1);
    stop();
    focusQuick("s-2");
    const later = vi.fn();
    registerQuickHost("s-2", later);
    expect(later).toHaveBeenCalledTimes(1);
    // Asked once: a remount does not take it again.
    const again = vi.fn();
    registerQuickHost("s-2", again);
    expect(again).not.toHaveBeenCalled();
  });

  it("knows whether the keyboard is inside a thread's quick terminal", () => {
    document.body.innerHTML = '<section data-quick-terminal="s-1"><textarea id="in"></textarea></section><input id="out" />';
    document.getElementById("in")?.focus();
    expect(quickHasFocus("s-1")).toBe(true);
    expect(quickHasFocus("s-2")).toBe(false);
    document.getElementById("out")?.focus();
    expect(quickHasFocus("s-1")).toBe(false);
  });
});
