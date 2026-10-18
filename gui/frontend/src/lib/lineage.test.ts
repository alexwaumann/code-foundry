import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import {
  capIds,
  childIds,
  creatorOf,
  hasLineage,
  lineageStatus,
  lineageTail,
  noteCreator,
  parseCreatedByNote,
  projectCount,
  relatedCount,
  siblingIds,
  type LineageCounts,
  type LineageData,
} from "./lineage";

function t(id: string, o: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    name: `name ${id}`,
    projectId: "web",
    state: "disconnected",
    status: "idle",
    statusReason: "",
    statusChangedAtMs: null,
    archivedAtMs: null,
    snoozedUntilMs: null,
    createdBy: "",
    createdByName: "",
    brief: "",
    ...o,
  } as ThreadView;
}

/** Spawn order is the list's order: p (the creator), then its children a..g, then a's child g1. */
function data(threads: ThreadView[]): LineageData {
  return { byId: Object.fromEntries(threads.map((x) => [x.id, x])), order: threads.map((x) => x.id) };
}

const kid = (id: string, by = "p", o: Partial<ThreadView> = {}) => t(id, { createdBy: by, createdByName: `name ${by}`, ...o });

const D = data([
  t("p"),
  t("u"),
  kid("a"),
  kid("b", "p", { projectId: "auth" }),
  kid("c", "p", { archivedAtMs: 1 }),
  kid("d"),
  kid("e"),
  kid("f"),
  kid("g", "p", { projectId: "" }),
  kid("a1", "a"),
  kid("orphan", "gone", { createdByName: "Removed one" }),
  kid("orphan2", "gone", { createdByName: "Removed one" }),
  t("r", { name: "Renamed parent" }),
  kid("r1", "r", { createdByName: "Old parent" }),
  t("anon", { name: "" }),
  kid("anon1", "anon", { createdByName: "Named once" }),
]);

describe("creatorOf", () => {
  it.each([
    ["the user's thread", "p", null],
    ["an agent's thread", "a", { id: "p", name: "name p", exists: true }],
    ["a renamed creator: its current name, not the recorded one", "r1", { id: "r", name: "Renamed parent", exists: true }],
    ["an unnamed creator: its id, not the recorded name", "anon1", { id: "anon", name: "anon", exists: true }],
    ["a removed creator keeps its recorded name", "orphan", { id: "gone", name: "Removed one", exists: false }],
    ["an unknown thread", "zz", null],
  ])("%s", (_n, id, want) => {
    expect(creatorOf(D, id)).toEqual(want);
  });

  it("falls back to the creator's id when no name was recorded", () => {
    expect(creatorOf(data([t("x", { createdBy: "p" })]), "x")).toEqual({ id: "p", name: "p", exists: false });
  });

  it("an archived creator still exists", () => {
    expect(creatorOf(data([t("p", { archivedAtMs: 5 }), kid("a")]), "a")?.exists).toBe(true);
  });
});

describe("siblings and children", () => {
  it.each([
    ["a child's siblings, spawn order, archived included", "a", siblingIds, ["b", "c", "d", "e", "f", "g"]],
    ["the last child's siblings", "g", siblingIds, ["a", "b", "c", "d", "e", "f"]],
    ["a removed creator's threads are still siblings", "orphan", siblingIds, ["orphan2"]],
    ["the user's thread has no siblings", "p", siblingIds, []],
    ["the creator's children", "p", childIds, ["a", "b", "c", "d", "e", "f", "g"]],
    ["a child's children", "a", childIds, ["a1"]],
    ["none", "u", childIds, []],
    ["no thread", "", childIds, []],
  ])("%s", (_n, id, fn, want) => {
    expect(fn(D, id)).toEqual(want);
  });

  it("counts the projects children run in (no project is one place)", () => {
    expect(projectCount(D, childIds(D, "p"))).toBe(3);
    expect(projectCount(D, ["a", "d"])).toBe(1);
    expect(projectCount(D, [])).toBe(0);
  });
});

describe("hasLineage", () => {
  it.each([
    ["a creator with children", "p", true],
    ["an agent's thread (a creator and siblings)", "a", true],
    ["an only child: a creator, no siblings", "a1", true],
    ["a removed creator still counts (its row stays)", "orphan", true],
    ["a renamed creator's only child", "r1", true],
    ["the user's thread with nothing related", "u", false],
    ["an unknown thread", "zz", false],
    ["no thread", "", false],
  ])("%s", (_n, id, want) => {
    expect(hasLineage(D, id)).toBe(want);
  });
});

describe("capIds", () => {
  const six = ["1", "2", "3", "4", "5", "6"];
  it.each([
    ["under the cap", ["1", "2"], false, { shown: ["1", "2"], more: 0 }],
    ["at the cap", six.slice(0, 5), false, { shown: six.slice(0, 5), more: 0 }],
    ["over the cap", six, false, { shown: six.slice(0, 5), more: 1 }],
    ["expanded", six, true, { shown: six, more: 0 }],
  ])("%s", (_n, ids, expanded, want) => {
    expect(capIds(ids, expanded)).toEqual(want);
  });

  it("takes another cap", () => {
    expect(capIds(["1", "2", "3"], false, 1)).toEqual({ shown: ["1"], more: 2 });
  });
});

describe("header figures", () => {
  const c = (o: Partial<LineageCounts>): LineageCounts => ({ creator: "", creatorName: "", siblings: 0, children: 0, childProjects: 0, ...o });
  it.each([
    ["an agent's thread with siblings and a child", c({ creator: "created", siblings: 3, children: 1 }), "3 siblings · 1 child", 5],
    ["one sibling, two children", c({ creator: "created", siblings: 1, children: 2 }), "1 sibling · 2 children", 4],
    ["an agent's thread alone", c({ creator: "created" }), "", 1],
    ["a removed creator", c({ creator: "removed", siblings: 2 }), "2 siblings", 3],
    ["a foreman", c({ children: 6, childProjects: 3 }), "6 threads created from here, in 3 projects", 6],
    ["one child", c({ children: 1, childProjects: 1 }), "1 thread created from here, in 1 project", 1],
    ["nothing", c({}), "", 0],
  ])("%s", (_n, counts, tail, related) => {
    expect(lineageTail(counts)).toBe(tail);
    expect(relatedCount(counts)).toBe(related);
  });
});

describe("lineageStatus", () => {
  it.each([
    ["busy", { state: "connected", status: "busy" }, "working"],
    ["idle", { status: "idle" }, "idle"],
    ["finished", { status: "attention", statusReason: "finished" }, "finished"],
    ["a permission", { status: "attention", statusReason: "permission: Bash" }, "input"],
    ["a question", { status: "attention", statusReason: "question: Which?" }, "input"],
    ["a Claude error", { status: "attention", statusReason: "error: overloaded" }, "error"],
    ["interrupted", { status: "error", statusReason: "interrupted" }, "error"],
    ["archived wins", { status: "attention", statusReason: "finished", archivedAtMs: 1 }, "archived"],
    ["snoozed", { snoozedUntilMs: 9 }, "snoozed"],
  ] as const)("%s", (_n, o, want) => {
    expect(lineageStatus(t("x", o as Partial<ThreadView>))).toBe(want);
  });

  it("an unknown thread is idle", () => {
    expect(lineageStatus(undefined)).toBe("idle");
  });
});

describe("parseCreatedByNote", () => {
  it.each([
    ["with a brief", "Created by Fix login · brief: Add retry, keep it small", { name: "Fix login", brief: "Add retry, keep it small" }],
    ["without a brief", "Created by Fix login", { name: "Fix login", brief: "" }],
    ["a brief with the separator", "Created by A · brief: x · brief: y", { name: "A", brief: "x · brief: y" }],
    ["a name with the separator splits at the first", "Created by A · brief: B · brief: c", { name: "A", brief: "B · brief: c" }],
    ["no name", "Created by ", { name: "", brief: "" }],
  ])("%s", (_n, text, want) => {
    expect(parseCreatedByNote(text)).toEqual(want);
  });
});

describe("noteCreator", () => {
  const N = data([t("p", { name: "Fix login, renamed" }), t("twin", { name: "Fix login" }), t("anon", { name: "" }), t("fork", { name: "Fork of a" })]);
  it.each([
    ["an existing creator: its current name, linked", "p", "Fix login", { id: "p", name: "Fix login, renamed", exists: true }],
    ["by id, never by name: a namesake does not matter", "p", "Fix login", { id: "p", name: "Fix login, renamed", exists: true }],
    ["an unnamed creator: its id", "anon", "Named once", { id: "anon", name: "anon", exists: true }],
    ["a removed creator: the recorded name, no link", "gone", "Fix login", { id: "gone", name: "Fix login", exists: false }],
    ["a removed creator without a recorded name: its id", "gone", "", { id: "gone", name: "gone", exists: false }],
  ])("%s", (_n, createdBy, recorded, want) => {
    expect(noteCreator(N, createdBy, recorded)).toEqual(want);
  });
});
