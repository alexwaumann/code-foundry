import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoView } from "@/api/repo";
import {
  addAlsoIn,
  emptyDraft,
  emptyWorkspaceDraft,
  getDraft,
  removeAlsoIn,
  setPrimary,
  switchDraftTarget,
  updateDraft,
  useComposeStore,
  type DraftAttachment,
} from "./compose";
import { answerConfirm, useConfirmStore } from "./confirm";
import { useReposStore } from "./repos";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

afterEach(() => {
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  useConfirmStore.setState({ pending: null });
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

  it("a new primary resets the base (its refs differ)", () => {
    updateDraft("ws:w-1", { base: "origin/feat" });
    setPrimary("ws:w-1", "repo-gp");
    expect(getDraft("ws:w-1")).toMatchObject({ primary: "repo-gp", base: null });
    updateDraft("ws:w-1", { base: "origin/feat" });
    setPrimary("ws:w-1", "repo-gp"); // same primary: the base stays
    expect(getDraft("ws:w-1").base).toBe("origin/feat");
  });
});

describe("switchDraftTarget", () => {
  const repo = (id: string, git = true): RepoView => ({ id, path: `/src/${id}`, name: id.replace("repo-", ""), defaultBranch: "main", githubSlug: "", remotes: [], git, worktrees: [] });
  const cf = { kind: "project", repoId: "repo-cf" } as const;
  const gp = { kind: "project", repoId: "repo-gp" } as const;
  const login = { kind: "workspace", workspaceId: "w-1" } as const;
  const image = (id: string): DraftAttachment => ({ id, file: new File(["x"], `${id}.png`, { type: "image/png" }), url: `blob:${id}`, stagedPath: null });
  const revoke = vi.fn();

  beforeEach(() => {
    revoke.mockClear();
    URL.revokeObjectURL = revoke;
    useReposStore.setState({ byId: { "repo-cf": repo("repo-cf"), "repo-gp": repo("repo-gp"), "repo-sk": repo("repo-sk") }, order: ["repo-cf", "repo-gp", "repo-sk"] });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login", branch: "cf/login", members: [{ repoId: "repo-gp", worktreePath: "/wt/gp" }], createdAtMs: null } }, order: ["w-1"], loaded: true });
    useUiStore.setState({ selection: { kind: "compose", repoId: "repo-cf" } });
  });

  it("moves the draft (images kept, not revoked), deletes the old key, shows the new composer focused", async () => {
    updateDraft("repo-cf", { text: "hi", attachments: [image("a1")], model: "haiku", alsoIn: ["repo-gp", "repo-sk"], base: "origin/dev" });
    const seq = useUiStore.getState().composerFocusSeq;
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(true);
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
    expect(getDraft("repo-gp")).toMatchObject({ text: "hi", model: "haiku", alsoIn: ["repo-sk"], base: null, worktree: { kind: "new" } });
    expect(getDraft("repo-gp").attachments.map((a) => a.url)).toEqual(["blob:a1"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-gp" });
    expect(useUiStore.getState().composerFocusSeq).toBe(seq + 1);
  });

  it("to a workspace: selects it with its first member for the context", async () => {
    updateDraft("repo-cf", { text: "hi", alsoIn: ["repo-sk"] });
    await switchDraftTarget(cf, login);
    expect(getDraft("ws:w-1")).toMatchObject({ text: "hi", alsoIn: [], worktree: { kind: "members" } });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-gp", workspaceId: "w-1" });
  });

  it("the same target, or a busy draft: nothing happens", async () => {
    updateDraft("repo-cf", { text: "hi" });
    await expect(switchDraftTarget(cf, cf)).resolves.toBe(false);
    updateDraft("repo-cf", { phase: "starting" });
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe("hi");
    expect(useComposeStore.getState().drafts["repo-gp"]).toBeUndefined();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-cf" });
  });

  it("a non-empty draft at the target: replaced only after the confirm", async () => {
    updateDraft("repo-cf", { text: "new idea" });
    updateDraft("repo-gp", { text: "older idea", attachments: [image("a2")] });
    const cancelled = switchDraftTarget(cf, gp);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Replace the draft in gp?", message: "It has unsent text or images.", confirmLabel: "Replace" });
    answerConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe("new idea");
    expect(getDraft("repo-gp").text).toBe("older idea");
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-cf" });

    const replaced = switchDraftTarget(cf, gp);
    answerConfirm(true);
    await expect(replaced).resolves.toBe(true);
    expect(getDraft("repo-gp")).toMatchObject({ text: "new idea", attachments: [] });
    expect(revoke).toHaveBeenCalledWith("blob:a2");
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
  });

  it("an empty draft moves nothing: the target's own draft shows as it is, no confirm", async () => {
    updateDraft("repo-cf", { model: "haiku" });
    updateDraft("repo-gp", { text: "older idea" });
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(getDraft("repo-gp")).toMatchObject({ text: "older idea", model: null });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-gp" });
  });
});
