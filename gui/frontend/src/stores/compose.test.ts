import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoView } from "@/api/repo";
import { HOME_KEY } from "@/lib/compose";
import { tagToken } from "@/lib/prompt";
import {
  addAlsoIn,
  composeNoProject,
  composeSelection,
  composeTarget,
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

describe("the no-project composer", () => {
  it("its selection has no repo and maps to the home target and back", () => {
    composeNoProject();
    const sel = useUiStore.getState().selection;
    expect(sel).toEqual({ kind: "compose", repoId: "", noProject: true });
    if (sel.kind !== "compose") throw new Error("not a composer");
    expect(composeTarget(sel)).toEqual({ kind: "home" });
    expect(composeSelection({ kind: "home" }, { kind: "home" })).toEqual(sel);
    expect(composeTarget({ kind: "compose", repoId: "repo-cf" })).toEqual({ kind: "project", repoId: "repo-cf" });
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

  it("tags of projects that leave the draft: removed only after the confirm", async () => {
    const sk = (repoId: string) => tagToken({ tagKind: "skill", name: "deploy", repoId });
    const text = `${sk("repo-cf")} and ${sk("repo-cf")} with ${sk("repo-gp")} ${sk("")}`;
    updateDraft("repo-cf", { text });
    const cancelled = switchDraftTarget(cf, gp);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Switch to gp?", message: "2 references to cf in your text will be removed.", confirmLabel: "Switch" });
    answerConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe(text);
    expect(useComposeStore.getState().drafts["repo-gp"]).toBeUndefined();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-cf" });

    const switched = switchDraftTarget(cf, gp);
    answerConfirm(true);
    await expect(switched).resolves.toBe(true);
    expect(getDraft("repo-gp").text).toBe(`and with ${sk("repo-gp")} ${sk("")}`);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "repo-gp" });
  });

  it("to a workspace: Also in tags go too; its members' tags stay", async () => {
    const sk = (repoId: string) => tagToken({ tagKind: "skill", name: "deploy", repoId });
    updateDraft("repo-cf", { text: `${sk("repo-sk")} ${sk("repo-cf")} ${sk("repo-gp")}`, alsoIn: ["repo-sk", "repo-gp"] });
    const p = switchDraftTarget(cf, login);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Switch to login?", message: "2 references to sk and cf in your text will be removed." });
    answerConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(getDraft("ws:w-1").text).toBe(sk("repo-gp"));
  });

  it("to no project: the home draft, selected without a repo; and back to a project", async () => {
    updateDraft("repo-cf", { text: "hi", alsoIn: ["repo-gp"], model: "haiku" });
    await expect(switchDraftTarget(cf, { kind: "home" })).resolves.toBe(true);
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
    expect(getDraft(HOME_KEY)).toMatchObject({ text: "hi", alsoIn: [], model: "haiku" });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", repoId: "", noProject: true });
    await expect(switchDraftTarget({ kind: "home" }, gp)).resolves.toBe(true);
    expect(useComposeStore.getState().drafts[HOME_KEY]).toBeUndefined();
    expect(getDraft("repo-gp")).toMatchObject({ text: "hi", worktree: { kind: "new" } });
  });

  it("to no project with project tags: removed only after the confirm, which names No project", async () => {
    const sk = tagToken({ tagKind: "skill", name: "deploy", repoId: "repo-cf" });
    updateDraft("repo-cf", { text: `${sk} now` });
    const moving = switchDraftTarget(cf, { kind: "home" });
    await vi.waitFor(() => {
      expect(useConfirmStore.getState().pending?.title).toBe("Switch to No project?");
    });
    answerConfirm(true);
    await expect(moving).resolves.toBe(true);
    expect(getDraft(HOME_KEY).text).toBe("now");
  });

  it("no dropped tags: no tag confirm", async () => {
    const sk = tagToken({ tagKind: "skill", name: "deploy", repoId: "repo-sk" });
    updateDraft("repo-cf", { text: `${sk} now`, alsoIn: ["repo-sk"] });
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(getDraft("repo-gp").text).toBe(`${sk} now`);
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
