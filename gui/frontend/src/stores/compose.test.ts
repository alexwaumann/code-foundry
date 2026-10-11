import { afterEach, describe, expect, it } from "vitest";
import { tagToken } from "@/lib/prompt";
import { addAlsoIn, emptyDraft, emptyWorkspaceDraft, getDraft, removeAlsoIn, setPrimary, updateDraft, useComposeStore } from "./compose";

afterEach(() => {
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

describe("compose drafts", () => {
  it("a project draft starts with a new worktree, a workspace draft in its worktrees", () => {
    expect(getDraft("repo-cf")).toBe(emptyDraft);
    expect(getDraft("ws:w-1")).toBe(emptyWorkspaceDraft);
    expect(getDraft("ws:w-1").worktree).toEqual({ kind: "members" });
    updateDraft("ws:w-1", { text: "hi" });
    expect(getDraft("ws:w-1")).toMatchObject({ text: "hi", worktree: { kind: "members" } });
  });

  it("Also in: added once, removed again; removing the primary hands it back to the project", () => {
    addAlsoIn("repo-cf", "repo-gp");
    addAlsoIn("repo-cf", "repo-gp");
    addAlsoIn("repo-cf", "repo-sk");
    expect(getDraft("repo-cf").alsoIn).toEqual(["repo-gp", "repo-sk"]);
    setPrimary("repo-cf", "repo-gp");
    updateDraft("repo-cf", { base: "origin/dev" });
    removeAlsoIn("repo-cf", "repo-sk");
    expect(getDraft("repo-cf")).toMatchObject({ alsoIn: ["repo-gp"], primary: "repo-gp", base: "origin/dev" });
    removeAlsoIn("repo-cf", "repo-gp");
    expect(getDraft("repo-cf")).toMatchObject({ alsoIn: [], primary: null, base: null });
  });

  it("removing an Also in project removes its skill and file tags, nothing else", () => {
    const sk = (repoId: string) => tagToken({ tagKind: "skill", name: "deploy", repoId });
    const file = tagToken({ tagKind: "file", repoId: "repo-gp", path: "src/a.ts" });
    addAlsoIn("repo-cf", "repo-gp");
    updateDraft("repo-cf", { text: `Use ${sk("repo-gp")} and ${sk("repo-cf")} on ${file} then ${sk("")} ` });
    removeAlsoIn("repo-cf", "repo-gp");
    expect(getDraft("repo-cf")).toMatchObject({ alsoIn: [], text: `Use and ${sk("repo-cf")} on then ${sk("")}` });
  });

  it("a new primary resets the base (its refs differ)", () => {
    updateDraft("ws:w-1", { base: "origin/feat" });
    setPrimary("ws:w-1", "repo-gp");
    expect(getDraft("ws:w-1")).toMatchObject({ primary: "repo-gp", base: null });
    updateDraft("ws:w-1", { base: "origin/feat" });
    setPrimary("ws:w-1", "repo-gp"); // same primary: the base stays
    expect(getDraft("ws:w-1").base).toBe("origin/feat");
  });
});
