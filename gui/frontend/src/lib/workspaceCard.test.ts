import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import {
  addableProjects,
  editInstructionsPrompt,
  instructionsName,
  instructionsTarget,
  instructionsStep,
  instructionsThread,
  membersByName,
  skillChips,
  workspaceFolder,
  workspaceNameError,
  workspaceSummary,
} from "./workspaceCard";

const synthetic = { id: "w-1", name: "shop", rootPath: "", managedDir: "/Users/me/.code-foundry/workspaces/w-1", instructions: "", skills: [] as string[] };
const rooted = { id: "w-2", name: "mono", rootPath: "/Users/me/mono", managedDir: "/Users/me/.code-foundry/workspaces/w-2", instructions: "/Users/me/mono/AGENTS.md", skills: ["demo"] };

describe("the workspace's folder and instructions", () => {
  it("the folder is the root, else the managed dir", () => {
    expect(workspaceFolder(rooted)).toBe("/Users/me/mono");
    expect(workspaceFolder(synthetic)).toBe("/Users/me/.code-foundry/workspaces/w-1");
    expect(workspaceFolder({ rootPath: "", managedDir: "" })).toBe("");
  });
  it.each<[string, string, string]>([
    ["CLAUDE.md", "/a/CLAUDE.md", "CLAUDE.md"],
    ["AGENTS.md", "/a/AGENTS.md", "AGENTS.md"],
    ["none yet", "", ""],
  ])("the file's name: %s", (_n, instructions, want) => {
    expect(instructionsName({ instructions })).toBe(want);
  });
  it("Edit instructions points at the file, else CLAUDE.md in the folder", () => {
    expect(instructionsTarget(rooted)).toBe("/Users/me/mono/AGENTS.md");
    expect(instructionsTarget(synthetic)).toBe("/Users/me/.code-foundry/workspaces/w-1/CLAUDE.md");
    expect(instructionsTarget({ ...synthetic, managedDir: "/x/" })).toBe("/x/CLAUDE.md");
  });
  it("the prompt names the file and the skills folder; without a file it asks what to write", () => {
    const withFile = editInstructionsPrompt(rooted);
    expect(withFile).toContain("Workspace mono's instructions are in /Users/me/mono/AGENTS.md. Read it, then ask me what to change.");
    expect(withFile).toContain("/Users/me/mono/.claude/skills/<name>/SKILL.md");
    const none = editInstructionsPrompt(synthetic);
    expect(none).toContain("Workspace shop has no instructions yet; they go in /Users/me/.code-foundry/workspaces/w-1/CLAUDE.md.");
    expect(none).toContain("Ask me what they should say");
  });
});

describe("instructionsThread (steer, else start)", () => {
  const t = (id: string, o: Partial<ThreadView> = {}) =>
    ({ id, workspaceId: "w-2", worktreePath: "/Users/me/mono", archivedAtMs: null, createdBy: "", lastActivityAtMs: null, createdAtMs: 1, ...o }) as ThreadView;
  const of = (...list: ThreadView[]) => ({ order: list.map((x) => x.id), byId: Object.fromEntries(list.map((x) => [x.id, x])) });
  it.each<[string, ThreadView[], string | null]>([
    ["none", [], null],
    ["a thread in the root", [t("a")], "a"],
    ["a thread in a member's checkout is not it", [t("a", { worktreePath: "/Users/me/src/web" })], null],
    ["another workspace's thread", [t("a", { workspaceId: "w-9" })], null],
    ["archived", [t("a", { archivedAtMs: 5 })], null],
    ["a thread another thread created", [t("a", { createdBy: "t-lead" })], null],
    ["the most recently active", [t("a", { lastActivityAtMs: 10 }), t("b", { lastActivityAtMs: 30 }), t("c", { lastActivityAtMs: 20 })], "b"],
    ["the newest when none has activity", [t("a", { createdAtMs: 5 }), t("b", { createdAtMs: 7 })], "b"],
    ["a trailing slash or /private on /tmp is the same folder", [t("a", { worktreePath: "/Users/me/mono/" })], "a"],
  ])("%s", (_n, list, want) => {
    expect(instructionsThread(of(...list), rooted)).toBe(want);
  });
  it("a synthetic workspace's folder is its managed dir; /private/tmp matches /tmp", () => {
    const ws = { ...synthetic, managedDir: "/tmp/cf/workspaces/w-1" };
    expect(instructionsThread(of(t("a", { workspaceId: "w-1", worktreePath: "/private/tmp/cf/workspaces/w-1" })), ws)).toBe("a");
  });
});

describe("instructionsStep (a press steers once; while that thread is live, presses only focus it)", () => {
  const t = (id: string, o: Partial<ThreadView> = {}) =>
    ({ id, workspaceId: "w-2", worktreePath: "/Users/me/mono", archivedAtMs: null, createdBy: "", lastActivityAtMs: null, createdAtMs: 1, status: "idle", state: "connected", ...o }) as ThreadView;
  const of = (...list: ThreadView[]) => ({ order: list.map((x) => x.id), byId: Object.fromEntries(list.map((x) => [x.id, x])) });
  it.each<[string, ThreadView[], string, ReturnType<typeof instructionsStep>]>([
    ["no thread there, no press yet: start", [], "", { kind: "start" }],
    ["a thread there, no press yet: steer it (busy or not, the steer queues)", [t("a", { status: "busy" })], "", { kind: "steer", id: "a" }],
    ["the last press sent to it and it is busy: focus only", [t("a", { status: "busy" })], "a", { kind: "focus", id: "a" }],
    ["the last press sent to it and it is starting: focus only", [t("a", { state: "starting" })], "a", { kind: "focus", id: "a" }],
    ["the last press sent to it and it is idle again: steer", [t("a", { status: "idle" })], "a", { kind: "steer", id: "a" }],
    ["the last press went to another thread: steer this one", [t("a", { status: "busy" })], "b", { kind: "steer", id: "a" }],
    ["the thread the last press started is not in the slice yet: focus it", [], "n", { kind: "focus", id: "n" }],
    ["the thread the last press started is idle and elsewhere now: start", [t("n", { worktreePath: "/elsewhere" })], "n", { kind: "start" }],
  ])("%s", (_n, list, last, want) => {
    expect(instructionsStep(of(...list), rooted, last)).toEqual(want);
  });
});

describe("membersByName", () => {
  const names: Record<string, string> = { "p-1": "web", "p-2": "Api", "p-3": "api", "p-4": "billing" };
  it("by name, case-insensitive, id as the tiebreak; an unregistered member by its id", () => {
    expect(membersByName(["p-4", "p-1", "p-3", "p-2", "a-gone"], (id) => names[id])).toEqual(["a-gone", "p-2", "p-3", "p-4", "p-1"]);
  });
  it("keeps the input untouched", () => {
    const ids = ["p-1", "p-2"];
    membersByName(ids, (id) => names[id]);
    expect(ids).toEqual(["p-1", "p-2"]);
  });
});

describe("skillChips", () => {
  const many = Array.from({ length: 11 }, (_, i) => `s${String(i).padStart(2, "0")}`);
  it.each<[string, string[], number, number]>([
    ["none", [], 0, 0],
    ["exactly the cap: all shown", many.slice(0, 8), 8, 0],
    ["over the cap: eight, then the rest", many, 8, 3],
  ])("%s", (_n, skills, shown, rest) => {
    const c = skillChips(skills);
    expect([c.shown.length, c.rest.length]).toEqual([shown, rest]);
    expect([...c.shown, ...c.rest]).toEqual(skills);
  });
});

describe("addableProjects", () => {
  const projects = { order: ["api", "notes", "web"], byId: { api: {}, notes: {}, web: {} } };
  it("registered projects that are not members, in the slice's order, plain folders too", () => {
    expect(addableProjects(["web"], projects)).toEqual(["api", "notes"]);
    expect(addableProjects([], projects)).toEqual(["api", "notes", "web"]);
    expect(addableProjects(["api", "notes", "web"], projects)).toEqual([]);
  });
});

describe("workspaceNameError", () => {
  it.each<[string, string, string[], string]>([
    ["fine", "shop", ["mono"], ""],
    ["empty", "  ", [], "Name it."],
    ["the primary keyword", "Workspace", [], "“workspace” is reserved."],
    ["taken, any case", "MONO", ["mono"], "A workspace named “MONO” exists."],
    ["too long", "x".repeat(101), [], "At most 100 bytes."],
  ])("%s", (_n, name, others, want) => {
    expect(workspaceNameError(name, others)).toBe(want);
  });
});

describe("workspaceSummary", () => {
  it.each<[string[], string[], string]>([
    [["a"], [], "1 project"],
    [["a", "b"], ["demo"], "2 projects · 1 skill"],
    [[], ["x", "y"], "0 projects · 2 skills"],
  ])("%j %j", (members, skills, want) => {
    expect(workspaceSummary({ members: members.map((projectId) => ({ projectId, worktreePath: "" })), skills })).toBe(want);
  });
});
