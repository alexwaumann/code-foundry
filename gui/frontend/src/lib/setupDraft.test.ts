import { describe, expect, it } from "vitest";
import { tagToken } from "./prompt";
import { encodeSetupDraft, MAX_DRAFT_JSON_BYTES, parseDiscardedSetup, parseSetupDraft, remapAttachmentChips, SETUP_DRAFT_VERSION, type SetupDraft } from "./setupDraft";

const chip = (id: string) => tagToken({ tagKind: "image", id, name: "shot.png" });

const draft: SetupDraft = {
  v: SETUP_DRAFT_VERSION,
  target: { kind: "workspace", workspaceId: "w-1" },
  text: `Look at ${chip("a3")} and fix it`,
  attachments: [{ id: "a3", path: "/att/1-shot.png", name: "shot.png", kind: "image", pages: null }],
  citations: { c1: { id: "c1", threadId: "s-1", itemId: "i-1", text: "quoted", start: 0, end: 6, prefix: "", suffix: "", comment: "" } },
  model: "claude-opus-4-8[1m]",
  effort: "high",
  permission: "accept-edits",
  worktree: { kind: "branch", name: "dev" },
  base: "origin/main",
  projects: ["repo-a", "repo-b"],
  workspace: "w-1",
  primary: "repo-b",
};

describe("the draft snapshot", () => {
  it("comes back as it went", () => {
    expect(parseSetupDraft(encodeSetupDraft(draft))).toEqual(draft);
  });

  it.each([
    ["a project", { kind: "project", projectId: "p" }],
    ["a like draft", { kind: "like", threadId: "s-1" }],
    ["no project", { kind: "home" }],
  ] as const)("keeps %s as its target", (_n, target) => {
    expect(parseSetupDraft(encodeSetupDraft({ ...draft, target }))?.target).toEqual(target);
  });

  it("over the cap drops the prompt and the citations, keeping the options: Discard's first has the prompt", () => {
    const big = { ...draft, text: "x".repeat(2000) };
    const json = encodeSetupDraft(big, 1000);
    expect(new TextEncoder().encode(json).length).toBeLessThanOrEqual(1000);
    const back = parseSetupDraft(json);
    expect(back?.text).toBeNull();
    expect(back?.citations).toEqual({});
    expect(back?.attachments).toEqual(draft.attachments);
    expect(back?.projects).toEqual(draft.projects);
  });

  it("measures bytes as the daemon does, not characters", () => {
    const text = "é".repeat(MAX_DRAFT_JSON_BYTES / 2 + 10);
    expect(parseSetupDraft(encodeSetupDraft({ ...draft, text }))?.text).toBeNull();
  });

  it("sends nothing rather than fail the send when even the options do not fit", () => {
    expect(encodeSetupDraft(draft, 10)).toBe("");
  });

  it.each([
    ["nothing", ""],
    ["not JSON", "{nope"],
    ["not an object", "[1]"],
    ["another version", JSON.stringify({ ...draft, v: 2 })],
    ["no target", JSON.stringify({ ...draft, target: undefined })],
    ["a target of no kind", JSON.stringify({ ...draft, target: { kind: "other" } })],
    ["a project target with no project", JSON.stringify({ ...draft, target: { kind: "project" } })],
  ])("is unreadable with %s", (_n, json) => {
    expect(parseSetupDraft(json)).toBeNull();
  });

  it("reads a field that makes no sense as not set, and keeps the rest", () => {
    const back = parseSetupDraft(
      JSON.stringify({ ...draft, model: 7, permission: "root", worktree: { kind: "branch" }, projects: "repo-a", attachments: [{ id: "a1" }, 4, draft.attachments[0]], citations: { c1: { id: "other", text: "x" } } }),
    );
    expect(back).toMatchObject({ model: null, permission: null, worktree: null, projects: null, attachments: draft.attachments, citations: {}, effort: "high", text: draft.text });
  });
});

describe("remapAttachmentChips", () => {
  it("points a chip at its attachment's new id, and drops one that did not come back", () => {
    expect(remapAttachmentChips(`a ${chip("a1")} b ${chip("a2")}`, (id) => (id === "a1" ? "a9" : undefined))).toBe(`a ${chip("a9")} b `);
  });

  it("leaves other tags and the lines alone", () => {
    const skill = tagToken({ tagKind: "skill", name: "deploy", projectId: "p" });
    expect(remapAttachmentChips(`${skill}\n\nnext`, () => undefined)).toBe(`${skill}\n\nnext`);
  });
});

describe("parseDiscardedSetup", () => {
  it("reads what Discard gives back", () => {
    const json = JSON.stringify({ draftJson: "{}", error: "no", first: { text: "go", composerText: "go!", attachments: ["/a"] }, queued: [{ text: "and" }], keptWorktrees: ["/w"] });
    expect(parseDiscardedSetup(json)).toEqual({
      draftJson: "{}",
      error: "no",
      first: { text: "go", composerText: "go!", attachments: ["/a"] },
      queued: [{ text: "and", composerText: "", attachments: [] }],
      keptWorktrees: ["/w"],
    });
  });

  it.each(["", "nope", "null", "[]"])("gives nothing back for %j", (json) => {
    expect(parseDiscardedSetup(json)).toEqual({ draftJson: "", error: "", first: null, queued: [], keptWorktrees: [] });
  });
});
