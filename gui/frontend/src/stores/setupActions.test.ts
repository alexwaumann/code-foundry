import { act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { tagToken } from "@/lib/prompt";
import { encodeSetupDraft, SETUP_DRAFT_VERSION, type SetupDraft } from "@/lib/setupDraft";

const blobs = vi.hoisted(() => new Map<string, Blob>());
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("./attachments", async (orig) => ({ ...(await orig<typeof import("./attachments")>()), readAttachmentFile: (path: string) => Promise.resolve(blobs.get(path) ?? null) }));
vi.mock("sonner", async (orig) => {
  const real = await orig<typeof import("sonner")>();
  return { ...real, toast: Object.assign(real.toast, { info: toastInfo }) };
});

const { daemon, invocationsOf, refuse, resetDaemon } = await import("@/test/daemonFakes");
const { getDraft, updateDraft, useComposeStore } = await import("./compose");
const { useProjectsStore } = await import("./projects");
const { CANCEL_TOO_LATE, cancelSetup, EDIT_TOO_LATE, editSetup, noteSentFrom, plainDraftText, retrySetup, setupDraftJson } = await import("./setupActions");
const { threadDraftKey } = await import("./threadActions");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");
const { useWorkspacesStore } = await import("./workspaces");
const { Code } = await import("@connectrpc/connect");

/**
 * The ways out of a setup, over the daemon's commands (docs/notes/instant-threads-4-composer.md):
 * Try again's and Cancel's refusals, and Edit's restore in every fallback. Which button runs
 * which is SetupNote's test; the flow across the routes is e2e/instant-threads.spec.ts.
 */

const ID = "s-new";
const chip = (id: string) => tagToken({ tagKind: "image", id, name: "shot.png" });
const project = (id: string, worktrees: { path: string }[] = []) => ({ id, name: id, path: `/src/${id}`, git: true, defaultBranch: "main", githubSlug: "", remotes: [], worktrees }) as never;

const thread = (o: Partial<ThreadView> = {}) =>
  ({ id: ID, name: "t", projectId: "repo-a", projectIds: ["repo-a"], workspaceId: "", worktreePath: "", checkoutPaths: [], createdWorktree: false, branch: "", state: "disconnected", status: "error", statusReason: "setup failed", flags: [], setup: { phase: "failed", startedAtMs: 1, endedAtMs: 2, steps: [], error: "git says no", background: true }, ...o }) as ThreadView;

const snapshot = (o: Partial<SetupDraft> = {}): SetupDraft => ({
  v: SETUP_DRAFT_VERSION,
  target: { kind: "project", projectId: "repo-a" },
  text: `Fix ${chip("a1")} please`,
  attachments: [{ id: "a1", path: "/att/shot.png", name: "shot.png", kind: "image", pages: null }],
  citations: {},
  model: "sonnet",
  effort: "low",
  permission: "accept-edits",
  worktree: { kind: "new" },
  base: "origin/dev",
  projects: ["repo-a"],
  workspace: "",
  primary: "repo-a",
  ...o,
});

/** Discard answers with this, and the thread leaves as the daemon's Removed would say. */
function discards(o: { draftJson?: string; error?: string; first?: unknown; queued?: unknown[]; keptWorktrees?: string[] }): void {
  daemon.handlers.set("thread.setup.discard", () => ({ message: "", resultJson: JSON.stringify({ draftJson: "", error: "", first: { text: "first as sent", composerText: "", attachments: [] }, queued: [], keptWorktrees: [], ...o }) }));
}

beforeEach(() => {
  resetDaemon();
  blobs.clear();
  blobs.set("/att/shot.png", new Blob(["png"], { type: "image/png" }));
  toastInfo.mockClear();
  useProjectsStore.setState({ byId: { "repo-a": project("repo-a"), "repo-b": project("repo-b", [{ path: "/src/repo-b" }]) }, order: ["repo-a", "repo-b"] });
  useWorkspacesStore.setState({ byId: {}, order: [] });
  useThreadsStore.setState({ byId: { [ID]: thread() }, order: [ID] });
  useUiStore.setState({ selection: { kind: "thread", id: ID } });
  URL.createObjectURL = () => "blob:x";
  URL.revokeObjectURL = () => undefined;
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => {
    f(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  useComposeStore.setState({ drafts: {} });
  useThreadsStore.setState({ byId: {}, order: [] });
});

describe("Edit", () => {
  it("restores every field for the same target and shows that composer, focused", async () => {
    const seq = useUiStore.getState().composerFocusSeq;
    discards({ draftJson: encodeSetupDraft(snapshot()), error: "git says no" });
    expect(await editSetup(ID)).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-a" });
    expect(useUiStore.getState().composerFocusSeq).toBe(seq + 1);
    const d = getDraft("repo-a");
    expect(d).toMatchObject({ model: "sonnet", effort: "low", permission: "accept-edits", worktree: { kind: "new" }, base: "origin/dev", projects: ["repo-a"], workspace: "", primary: "repo-a", phase: "idle", error: "git says no", notice: null });
    // Read back, so nothing uploads again; the chip follows the attachment's new id.
    expect(d.attachments.map((a) => [a.file.name, a.stagedPath])).toEqual([["shot.png", "/att/shot.png"]]);
    expect(d.text).toBe(`Fix ${chip(d.attachments[0]?.id ?? "")} please`);
  });

  it("selects the composer and takes the row away before the daemon answers", async () => {
    let answer = (): void => undefined;
    daemon.handlers.set("thread.setup.discard", () => new Promise((resolve) => { answer = () => { resolve({ message: "", resultJson: "{}" }); }; }));
    const edit = editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-a" });
    expect(useThreadsStore.getState().order).toEqual([]);
    // It waits read-only, so nothing typed meets what is coming back.
    expect(getDraft("repo-a").phase).toBe("starting");
    // What the daemon says of the thread meanwhile does not bring it back.
    const { applyThreadListEvent } = await import("./threads");
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "updated", thread: thread() }));
    expect(useThreadsStore.getState().order).toEqual([]);
    act(() => {
      answer();
    });
    await edit;
    expect(getDraft("repo-a").phase).toBe("idle");
    useThreadsStore.setState((s) => applyThreadListEvent(s, { kind: "removed", id: ID }));
  });

  it("waits in the composer it was sent from, not the thread's primary's", async () => {
    useThreadsStore.setState({ byId: { [ID]: thread({ projectId: "repo-b", projectIds: ["repo-a", "repo-b"] }) }, order: [ID] });
    noteSentFrom(ID, { kind: "project", projectId: "repo-a" });
    let answer = (): void => undefined;
    daemon.handlers.set("thread.setup.discard", () => new Promise((resolve) => { answer = () => { resolve({ message: "", resultJson: JSON.stringify({ first: { text: "go" } }) }); }; }));
    const edit = editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-a" });
    answer();
    await edit;
    expect(getDraft("repo-a").text).toBe("go");
  });

  it("forgets the composer it was sent from once the setup is done (no Edit after that)", async () => {
    const set = { projectId: "repo-b", projectIds: ["repo-a", "repo-b"] };
    useThreadsStore.setState({ byId: { [ID]: thread(set) }, order: [ID] });
    noteSentFrom(ID, { kind: "project", projectId: "repo-a" });
    useThreadsStore.setState({ byId: { [ID]: thread({ ...set, setup: { phase: "done", startedAtMs: 1, endedAtMs: 2, steps: [], error: "", background: true } }) } });
    useThreadsStore.setState({ byId: { [ID]: thread(set) } });
    discards({});
    const edit = editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-b" });
    await edit;
  });

  it("a cancel leaves no error", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot()), error: "" });
    await editSetup(ID);
    expect(getDraft("repo-a").error).toBeNull();
  });

  it("says which worktree stayed for the work in it", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot()), keptWorktrees: ["/w/kept"] });
    await editSetup(ID);
    expect(getDraft("repo-a").notice).toBe("/w/kept stayed: it has work in it");
  });

  it("drops the chip of a file that is gone, and says so", async () => {
    blobs.clear();
    discards({ draftJson: encodeSetupDraft(snapshot()) });
    await editSetup(ID);
    expect(getDraft("repo-a").attachments).toEqual([]);
    expect(getDraft("repo-a").text).toBe("Fix  please");
    expect(getDraft("repo-a").notice).toBe("shot.png: no longer staged; attach it again");
  });

  it("appends the queued messages after a blank line", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot({ text: "first", attachments: [] })), queued: [{ text: "second" }, { text: "third" }] });
    await editSetup(ID);
    expect(getDraft("repo-a").text).toBe("first\n\nsecond\n\nthird");
  });

  it("goes after what a draft for that target holds, and what was typed in the thread's composer goes last", async () => {
    updateDraft("repo-a", { text: "already here" });
    updateDraft(threadDraftKey(ID), { text: "typed in the thread" });
    discards({ draftJson: encodeSetupDraft(snapshot({ text: "restored", attachments: [] })) });
    await editSetup(ID);
    expect(getDraft("repo-a").text).toBe("already here\n\nrestored\n\ntyped in the thread");
    expect(useComposeStore.getState().drafts[threadDraftKey(ID)]).toBeUndefined();
  });

  it("a snapshot that left the prompt out to fit takes it from the first message, with its options", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot({ text: null, attachments: [] })), first: { text: "long prompt", composerText: "", attachments: [] } });
    await editSetup(ID);
    expect(getDraft("repo-a")).toMatchObject({ text: "long prompt", model: "sonnet", permission: "accept-edits" });
  });

  it.each([
    ["missing (a CLI thread)", ""],
    ["unreadable", "{nope"],
    ["of another version", JSON.stringify({ v: 99 })],
  ])("with a draft %s builds it from the first message and says so", async (_n, draftJson) => {
    discards({ draftJson, first: { text: "go", composerText: `go ${chip("0")}`, attachments: ["/att/shot.png"] } });
    await editSetup(ID);
    const d = getDraft("repo-a");
    expect(d.text).toBe(`go ${chip(d.attachments[0]?.id ?? "")}`);
    expect(d.attachments[0]?.stagedPath).toBe("/att/shot.png");
    expect(d.notice).toBe("Only the message came back: this thread kept no draft to restore");
  });

  it("a project that was removed: the nearest one of the set, its place fields gone, the prompt and options kept", async () => {
    useThreadsStore.setState({ byId: { [ID]: thread({ projectId: "repo-gone", projectIds: ["repo-gone", "repo-b"] }) }, order: [ID] });
    discards({ draftJson: encodeSetupDraft(snapshot({ target: { kind: "project", projectId: "repo-gone" }, projects: ["repo-gone", "repo-b"], text: "go", attachments: [] })) });
    await editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-b" });
    expect(getDraft("repo-b")).toMatchObject({ text: "go", model: "sonnet", projects: null, base: null, worktree: null, primary: null });
    expect(getDraft("repo-b").notice).toBe("What this was for is gone, so the draft is in repo-b now");
  });

  it("a workspace that was removed, with no project left: the home composer", async () => {
    useProjectsStore.setState({ byId: {}, order: [] });
    useThreadsStore.setState({ byId: { [ID]: thread({ projectId: "", projectIds: [], workspaceId: "w-gone" }) }, order: [ID] });
    discards({ draftJson: encodeSetupDraft(snapshot({ target: { kind: "workspace", workspaceId: "w-gone" }, projects: null, text: "go", attachments: [] })) });
    await editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
    expect(getDraft("home:")).toMatchObject({ text: "go", notice: "What this was for is gone, so the draft is in No project now" });
  });

  it("a project of the set that went leaves the set, and the base it shared goes with it", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot({ projects: ["repo-a", "repo-gone"], text: "go", attachments: [] })) });
    await editSetup(ID);
    expect(getDraft("repo-a")).toMatchObject({ projects: ["repo-a"], base: null });
  });

  it("a worktree that went falls back to the default", async () => {
    discards({ draftJson: encodeSetupDraft(snapshot({ worktree: { kind: "existing", path: "/gone" }, text: "go", attachments: [] })) });
    await editSetup(ID);
    expect(getDraft("repo-a").worktree).toBeNull();
  });

  it("a like draft goes back to its thread's composer", async () => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-src": thread({ id: "s-src", setup: null }) }, order: [...s.order, "s-src"] }));
    discards({ draftJson: encodeSetupDraft(snapshot({ target: { kind: "like", threadId: "s-src" }, text: "go", attachments: [] })) });
    await editSetup(ID);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-a", likeThreadId: "s-src" });
    expect(getDraft("like:s-src").text).toBe("go");
    expect(useComposeStore.getState().drafts["repo-a"]).toBeUndefined();
  });

  it("refused: the thread and its row come back, with the reason on its error line", async () => {
    daemon.handlers.set("thread.setup.discard", () => {
      throw refuse("only a failed or cancelled setup can be discarded", Code.FailedPrecondition);
    });
    expect(await editSetup(ID)).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: ID });
    expect(useThreadsStore.getState().order).toEqual([ID]);
    expect(useThreadsStore.getState().byId[ID]?.setup?.phase).toBe("failed");
    expect(getDraft(threadDraftKey(ID)).error).toBe(EDIT_TOO_LATE);
    expect(useComposeStore.getState().drafts["repo-a"]).toBeUndefined();
  });

  it("refused for another reason: the daemon's word on the error line", async () => {
    daemon.handlers.set("thread.setup.discard", () => {
      throw refuse("the database is locked", Code.Internal);
    });
    expect(await editSetup(ID)).toBe(false);
    expect(getDraft(threadDraftKey(ID)).error).toContain("the database is locked");
  });

  it("does not take over a composer that is sending", async () => {
    updateDraft("repo-a", { phase: "starting", text: "going out" });
    expect(await editSetup(ID)).toBe(false);
    expect(invocationsOf("thread.setup.discard")).toEqual([]);
    expect(getDraft(threadDraftKey(ID)).error).toMatch(/being sent/);
  });

  it("leaves the selection alone if the user moved on while it went", async () => {
    let answer = (): void => undefined;
    daemon.handlers.set("thread.setup.discard", () => new Promise((resolve) => { answer = () => { resolve({ message: "", resultJson: JSON.stringify({ first: { text: "go" } }) }); }; }));
    const edit = editSetup(ID);
    useUiStore.setState({ selection: { kind: "thread", id: "s-other" } });
    answer();
    await edit;
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-other" });
    expect(getDraft("repo-a").text).toBe("go");
  });
});

describe("Try again", () => {
  it("runs thread.setup.retry on the thread", async () => {
    expect(await retrySetup(ID)).toBe(true);
    expect(invocationsOf("thread.setup.retry").map((i) => i.args)).toEqual([{ id: ID }]);
  });

  it("puts a refusal on the composer's error line", async () => {
    daemon.handlers.set("thread.setup.retry", () => {
      throw refuse("thread kept nothing to try its setup again with", Code.FailedPrecondition);
    });
    expect(await retrySetup(ID)).toBe(false);
    expect(getDraft(threadDraftKey(ID)).error).toContain("kept nothing");
  });
});

describe("Cancel", () => {
  it("runs thread.setup.cancel on the thread", async () => {
    expect(await cancelSetup(ID)).toBe(true);
    expect(invocationsOf("thread.setup.cancel").map((i) => i.args)).toEqual([{ id: ID }]);
  });

  it("says which worktree stayed", async () => {
    daemon.handlers.set("thread.setup.cancel", () => ({ message: "", resultJson: JSON.stringify({ keptWorktrees: ["/w/a", "/w/b"] }) }));
    await cancelSetup(ID);
    expect(getDraft(threadDraftKey(ID)).notice).toBe("/w/a, /w/b stayed: they have work in them");
  });

  it("too late says so without alarm, and without the daemon's thread id", async () => {
    daemon.handlers.set("thread.setup.cancel", () => {
      throw refuse("it was too late to cancel it, and Claude is starting", Code.FailedPrecondition);
    });
    expect(await cancelSetup(ID)).toBe(false);
    expect(toastInfo.mock.calls[0]?.[0]).toBe(CANCEL_TOO_LATE);
  });
});

describe("setupDraftJson", () => {
  it("writes what Edit reads", async () => {
    const { parseSetupDraft } = await import("@/lib/setupDraft");
    const { emptyDraft } = await import("./compose");
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const d = { ...emptyDraft, text: "go", model: "sonnet", base: "origin/dev", attachments: [{ id: "a1", file, kind: "image" as const, url: "", stagedPath: "/att/1", pages: null, thumb: null }] };
    expect(parseSetupDraft(setupDraftJson({ kind: "project", projectId: "repo-a" }, d))).toMatchObject({
      target: { kind: "project", projectId: "repo-a" },
      text: "go",
      model: "sonnet",
      base: "origin/dev",
      attachments: [{ id: "a1", path: "/att/1", name: "shot.png", kind: "image", pages: null }],
    });
  });
});

describe("plainDraftText", () => {
  const sent = (text: string, composerText = "") => ({ text, composerText, attachments: [] });
  it.each([
    ["the snapshot's text first, the queue and what was typed after it", "", { ...snapshot(), text: "first" }, sent("x"), [sent("second")], { text: "third" }, "first\n\nsecond\n\nthird"],
    ["no snapshot: the first message, as composed", "", null, sent("raw", "composed"), [], null, "composed"],
    ["after what the draft held", "kept", null, sent("raw"), [], null, "kept\n\nraw"],
    ["nothing at all", "kept", null, null, [], { text: "  " }, "kept"],
  ])("%s", (_name, draft, snap, first, queued, typed, want) => {
    expect(plainDraftText(draft, snap, { first, queued }, typed)).toBe(want);
  });
});
