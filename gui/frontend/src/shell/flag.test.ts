import { afterEach, describe, expect, it } from "vitest";
import type { LayoutView } from "@/api/layout";
import { dispatchEvent } from "@/stores/events";
import { resetLayout, useLayoutStore } from "@/stores/layout";
import { readShellFlag, resetShellFlag, SHELL_FLAG_KEY, shellOn } from "./flag";

afterEach(() => {
  localStorage.removeItem(SHELL_FLAG_KEY);
  window.history.replaceState(null, "", "/");
  resetShellFlag();
  resetLayout();
});

describe("the shell flag", () => {
  // On by default since the cutover; "0" turns it off, and the URL wins over the stored value.
  it.each([
    ["", null, true],
    ["?shell=1", null, true],
    ["?x=2&shell=1", null, true],
    ["?shell=0", null, false],
    ["?x=2&shell=0", null, false],
    ["?shell=true", null, true],
    ["", "1", true],
    ["", "0", false],
    ["", "true", true],
    ["?shell=0", "1", false],
    ["?shell=1", "0", true],
  ])("search %j, stored %j: %s", (search, stored, on) => {
    expect(readShellFlag(search, stored)).toBe(on);
  });

  it("reads localStorage and the page's URL once per load", () => {
    expect(shellOn()).toBe(true);
    localStorage.setItem(SHELL_FLAG_KEY, "0");
    // Read once: turning it off takes a reload.
    expect(shellOn()).toBe(true);
    resetShellFlag();
    expect(shellOn()).toBe(false);
    localStorage.removeItem(SHELL_FLAG_KEY);
    window.history.replaceState(null, "", "/?shell=0");
    resetShellFlag();
    expect(shellOn()).toBe(false);
  });
});

describe("the layout source with the flag", () => {
  const layout: LayoutView = { rev: 3, spaces: [{ id: "sp-a", name: "Main", root: null, focus: "", mru: [], drafts: [] }], currentSpaceId: "sp-a", defaultSpaceId: "sp-a", threads: [] };
  const snapshot = { source: "layout", event: { kind: "snapshot", rev: 3, layout, clientId: "" } } as const;

  it("is ignored with the flag off: the classic window holds no layout", () => {
    localStorage.setItem(SHELL_FLAG_KEY, "0");
    resetShellFlag();
    dispatchEvent(snapshot);
    expect(useLayoutStore.getState().loaded).toBe(false);
  });

  it("feeds the layout slice with the flag on (the default)", () => {
    resetShellFlag();
    dispatchEvent(snapshot);
    expect(useLayoutStore.getState()).toMatchObject({ loaded: true, rev: 3, spaceOrder: ["sp-a"] });
  });
});
