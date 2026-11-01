import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import {
  childIds,
  creatorOf,
  lineageStatus,
  noteCreator,
  parseCreatedByNote,
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

describe("children", () => {
  it.each([
    ["the creator's children, spawn order, archived included", "p", ["a", "b", "c", "d", "e", "f", "g"]],
    ["a child's children", "a", ["a1"]],
    ["none", "u", []],
    ["no thread", "", []],
  ])("%s", (_n, id, want) => {
    expect(childIds(D, id)).toEqual(want);
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
    ["crashed", { status: "error", statusReason: "crashed" }, "error"],
    ["archived wins", { status: "attention", statusReason: "finished", archivedAtMs: 1 }, "archived"],
    ["snoozed", { snoozedUntilMs: 9 }, "snoozed"],
    // A lead waiting on its own workers (or its background work) is working, not idle.
    ["waiting on child threads", { status: "idle", statusReason: "waiting on 2 child threads" }, "working"],
    ["waiting on children and a subagent", { status: "idle", statusReason: "waiting on 1 child thread and 1 subagent" }, "working"],
    ["waiting on a queued wake", { state: "disconnected", status: "idle", statusReason: "waiting" }, "working"],
    ["waiting, archived", { status: "idle", statusReason: "waiting on 2 child threads", archivedAtMs: 1 }, "archived"],
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
