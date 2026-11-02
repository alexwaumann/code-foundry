import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileTab } from "@/surfaces/fileTarget";
import { openFileInPanel } from "./filePanel";
import { closePanelTab, usePanelStore } from "./panel";
import { RECENT_FILES_MAX, newlyShownFiles, startRecentFiles, useRecentFilesStore, withRecent, type RecentFile } from "./recentFiles";

const CF = "/Users/dev/src/code-foundry";
const KEY = "thread:s-1";
const file = (path: string): RecentFile => ({ project: "cf", base: CF, path: `${CF}/${path}` });

describe("withRecent", () => {
  it("moves a file to the front once and keeps RECENT_FILES_MAX", () => {
    const list = Array.from({ length: RECENT_FILES_MAX }, (_, i) => file(`f${String(i)}.ts`));
    const next = withRecent(list, file("f3.ts"));
    expect(next[0]?.path).toBe(`${CF}/f3.ts`);
    expect(next.filter((f) => f.path === `${CF}/f3.ts`)).toHaveLength(1);
    expect(withRecent(list, file("new.ts"))).toHaveLength(RECENT_FILES_MAX);
  });
});

describe("newlyShownFiles", () => {
  const a = fileTab({ project: "cf", base: CF, path: "a.ts" });
  const b = fileTab({ project: "cf", base: CF, path: "b.ts" });
  const page = fileTab({ project: "cf", base: CF, path: "page.html", page: { title: "Page" } });

  it("is a group's newly active File tab, not one still active or a thread's page", () => {
    const before = { open: true, groups: [{ tabs: [a, b, page], activeTabId: a.id }] };
    expect(newlyShownFiles(before, { ...before, groups: [{ tabs: [a, b, page], activeTabId: b.id }] })).toEqual([file("b.ts")]);
    expect(newlyShownFiles(before, { ...before, open: false })).toEqual([]);
    expect(newlyShownFiles(before, { ...before, groups: [{ tabs: [a, b, page], activeTabId: page.id }] })).toEqual([]);
    expect(newlyShownFiles(undefined, before)).toEqual([file("a.ts")]);
  });
});

describe("startRecentFiles", () => {
  let stop: () => void = () => undefined;
  beforeEach(() => {
    usePanelStore.setState({ byKey: {} });
    useRecentFilesStore.setState({ byKey: {} });
    stop = startRecentFiles();
  });
  afterEach(() => {
    stop();
  });

  it("keeps the panel's files most recent first, including ones whose tab closed", () => {
    openFileInPanel(KEY, { project: "cf", base: CF, path: "a.ts" });
    openFileInPanel(KEY, { project: "cf", base: CF, path: "b.ts" });
    openFileInPanel(KEY, { project: "cf", base: CF, path: "a.ts", line: 3 });
    expect(useRecentFilesStore.getState().byKey[KEY]?.map((f) => f.path)).toEqual([`${CF}/a.ts`, `${CF}/b.ts`]);
    // Closing a.ts shows b.ts again (its neighbour becomes active); a.ts stays listed.
    closePanelTab(KEY, fileTab({ project: "cf", base: CF, path: "a.ts" }).id);
    expect(useRecentFilesStore.getState().byKey[KEY]?.map((f) => f.path)).toEqual([`${CF}/b.ts`, `${CF}/a.ts`]);
    expect(useRecentFilesStore.getState().byKey["thread:s-2"]).toBeUndefined();
  });
});

describe("the persisted recent files", () => {
  it("keeps only well-formed absolute files on rehydrate", async () => {
    localStorage.setItem("code-foundry.recent-files", JSON.stringify({ state: { byKey: { [KEY]: [{ path: `${CF}/a.ts`, base: CF, project: "cf" }, { path: "relative.ts" }, null], bad: "x" } }, version: 1 }));
    await useRecentFilesStore.persist.rehydrate();
    expect(useRecentFilesStore.getState().byKey).toEqual({ [KEY]: [file("a.ts")] });
  });
});
