// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { ActionRunMode, ActionRunState } from "../src/gen/codefoundry/v1/action_pb";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { PermissionMode, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { panes } from "./layout";
import { World } from "./world";

const ctx = (c: Partial<UiContext>) => c as UiContext;

/** Runs a command and returns its message. */
async function run(w: World, name: string, c: Partial<UiContext>, args: Record<string, string>, confirmed = false): Promise<string> {
  const out = await w.invoke(name, ctx(c), args, confirmed);
  return typeof out === "string" ? out : out.message;
}

/** The thread a thread.new's message names ("created thread s-new-3 in …"). */
function created(w: World, message: string) {
  const id = /thread (s-[\w-]+)/.exec(message)?.[1] ?? "";
  const s = w.threads.get(id);
  if (!s) throw new Error(`no thread in "${message}"`);
  return s;
}

describe("the mock world", () => {
  it("never reuses a removed workspace's id", () => {
    const w = new World();
    const a = w.addWorkspace("a", ["repo-cf"]);
    const b = w.addWorkspace("b", ["repo-gp"]);
    w.removeWorkspace(a.id);
    const c = w.addWorkspace("c", ["repo-cf"]);
    expect(c.id).not.toBe(b.id);
    expect(w.workspaces.get(b.id)?.name).toBe("b");
  });

  it.each(["archive", "snooze", "save"] as const)("%s stops the thread's background action runs", (how) => {
    const w = new World();
    const r = w.actions.run({ action: "a-debug0000000", threadId: "s-1", mode: ActionRunMode.BACKGROUND });
    expect(w.actions.getRun(r.id ?? "").state).toBe(ActionRunState.RUNNING);
    if (how === "archive") w.archiveThread("s-1", true);
    else if (how === "snooze") w.snoozeThread("s-1", new Date(Date.now() + 3_600_000));
    else w.saveThread("s-1");
    expect(w.actions.getRun(r.id ?? "").state).toBe(ActionRunState.EXITED);
  });

  it("thread.snooze.clear: a woken thread is idle at its prompt; a re-snooze or archive clears a wake too; elsewhere it says so", async () => {
    const w = new World();
    const woken = () => {
      w.snoozeThread("s-1", new Date(Date.now() + 3_600_000));
      w.wakeThread("s-1");
      expect(w.threads.get("s-1")?.statusReason).toBe("snooze ended");
    };
    woken();
    expect(await run(w, "thread.snooze.clear", { activeThreadId: "s-1", activeView: "thread" }, {})).toMatch(/^cleared snooze ended on thread /);
    expect(w.threads.get("s-1")).toMatchObject({ statusReason: "at prompt", snoozedUntil: null });
    // Not woken any more: the window has no clear.
    await expect(run(w, "thread.snooze.clear", { activeThreadId: "s-1", activeView: "thread" }, {})).rejects.toThrow(/not available/);
    expect(w.clearSnoozeEnded("s-1")).toMatch(/was not woken from a snooze; nothing to clear$/);
    woken();
    w.archiveThread("s-1", true);
    expect(w.threads.get("s-1")?.statusReason).toBe("at prompt");
  });

  it("thread.unread: an idle thread is Done again; any other is refused as the daemon refuses it", async () => {
    const w = new World();
    const ctx = { activeThreadId: "s-1", activeView: "thread" };
    w.setThreadStatus("s-1", ThreadStatus.IDLE, "at prompt");
    expect(await run(w, "thread.unread", ctx, {})).toMatch(/^marked thread .* unread$/);
    expect(w.threads.get("s-1")).toMatchObject({ status: ThreadStatus.NEEDS_ATTENTION, statusReason: "finished" });
    await expect(run(w, "thread.unread", ctx, {})).rejects.toThrow(/only an idle thread at its prompt can be marked unread/);
    w.setThreadStatus("s-1", ThreadStatus.BUSY, "working");
    await expect(run(w, "thread.unread", ctx, {})).rejects.toThrow(/only an idle thread at its prompt can be marked unread/);
  });

  it("thread.new without a model, effort or permission takes the settings' defaults and auto", async () => {
    const w = new World();
    const s = created(w, await run(w, "thread.new", { activeProjectId: "repo-cf" }, { prompt: "hi" }));
    expect(s).toMatchObject({ model: "claude-sonnet-5[1m]", effort: "medium", permissionMode: PermissionMode.AUTO });
    const home = created(w, await run(w, "thread.new", { activeView: "compose" }, { "no-project": "true", prompt: "hi" }));
    expect(home).toMatchObject({ model: "claude-sonnet-5[1m]", effort: "medium" });
  });

  it("thread.new keeps its creator wherever it places the thread", async () => {
    const w = new World();
    const home = created(w, await run(w, "thread.new", { activeView: "compose" }, { "no-project": "true", "created-by": "s-1", prompt: "hi" }));
    expect(home.createdBy).toBe("s-1");
    const like = created(w, await run(w, "thread.new", { activeView: "compose" }, { like: "s-3", "created-by": "s-1", prompt: "hi" }));
    expect(like.createdBy).toBe("s-1");
    const set = created(w, await run(w, "thread.new", { activeView: "compose" }, { projects: "repo-cf,repo-gp", "created-by": "s-1", prompt: "hi" }));
    expect(set.createdBy).toBe("s-1");
  });

  it("project.unregister forgets the project's actions", async () => {
    const w = new World();
    expect(w.actions.list("repo-cf").actions.length).toBeGreaterThan(0);
    await run(w, "project.unregister", { activeProjectId: "repo-cf" }, {}, true);
    expect(w.projects.has("repo-cf")).toBe(false);
    expect(w.actions.list("repo-cf").actions).toEqual([]);
  });

  it("a pull request Claude links twice, in another case, is one row", () => {
    const w = new World();
    expect(w.linkPullRequest("s-1", "owner/repo", 12)).toBe(true);
    expect(w.linkPullRequest("s-1", "Owner/Repo", 12)).toBe(false);
    expect(w.threads.get("s-1")?.linkedPullRequests).toHaveLength(1);
  });

  it("thread.fork takes the name it is given, and the thread by id", async () => {
    const w = new World();
    await run(w, "thread.fork", { activeThreadId: "s-1" }, { id: "s-3", name: "My fork" });
    const f = [...w.threads.values()].find((t) => t.parentId === "s-3");
    expect(f).toMatchObject({ name: "My fork", autoNamed: false });
  });

  it("project.worktree.new refuses a path a worktree has", async () => {
    const w = new World();
    const c = { activeProjectId: "repo-cf" };
    await run(w, "project.worktree.new", c, { branch: "feat/dup" });
    await expect(run(w, "project.worktree.new", c, { branch: "feat/dup" })).rejects.toThrow(/already exists/);
  });
});

describe("the mock's layout glue (internal/daemon/layout.go): what keeps a preview", () => {
  /** s-7 (archived) and s-8 (snoozed) opened as previews in turn: the last one is the preview. */
  async function previewOf(id: string) {
    const w = new World();
    await w.invoke("thread.open", ctx({}), { id, preview: "true", focus: "true" }, false);
    const tab = () => w.layout.state().spaces.flatMap((sp) => panes(sp.root)).flatMap((p) => p.tabs ?? []).find((t) => t.thread === id);
    expect(tab()?.preview).toBe(true);
    return { w, tab };
  }

  it.each([
    ["unarchived", "s-7", (w: World) => w.archiveThread("s-7", false)],
    ["woken", "s-8", (w: World) => { w.wakeThread("s-8"); }],
    ["renamed", "s-7", (w: World) => w.invoke("thread.rename", ctx({ activeThreadId: "s-7" }), { name: "Kept" }, false)],
    ["pinned", "s-8", (w: World) => w.invoke("thread.pin", ctx({ activeThreadId: "s-8" }), { pinned: "true" }, false)],
  ] as const)("%s keeps it", async (_how, id, act) => {
    const { w, tab } = await previewOf(id);
    await act(w);
    expect(tab()?.preview).toBeUndefined();
  });

  it("a wake clears the layout's snoozed mark, so the next --preview of it opens a kept tab", async () => {
    const { w } = await previewOf("s-8");
    expect(w.layout.state().threads?.["s-8"]?.snoozed).toBe(true);
    w.wakeThread("s-8");
    expect(w.layout.state().threads?.["s-8"]?.snoozed).toBeUndefined();
  });

  it("an unrelated change (a status) leaves it a preview", async () => {
    const { w, tab } = await previewOf("s-7");
    w.stopThread("s-7", "closed", 0);
    expect(tab()?.preview).toBe(true);
  });
});

describe("pr.create in the mock", () => {
  const PR = "https://github.com/alexwaumann/code-foundry/pull/128";
  const ghWorktree = (w: World) => {
    for (const p of w.projects.values()) {
      const wt = p.githubSlug && p.remotes.length > 0 ? p.worktrees[0] : undefined;
      if (wt) return wt.path;
    }
    throw new Error("no GitHub worktree in the mock");
  };

  it("links the pull request to the context's thread, once", async () => {
    vi.useFakeTimers();
    try {
      const w = new World();
      const path = ghWorktree(w);
      const id = [...w.threads.keys()].find((k) => !w.threads.get(k)?.linkedPullRequests.some((l) => l.url === PR)) ?? "";
      const create = async () => {
        const out = w.invoke("pr.create", ctx({ activeThreadId: id, activeWorktreePath: path }), {}, false);
        await vi.advanceTimersByTimeAsync(1000);
        return out;
      };
      const first = await create();
      if (typeof first === "string") throw new Error("want a structured result");
      expect(first.message).toMatch(/\nlinked alexwaumann\/code-foundry#128 to thread /);
      expect((JSON.parse(first.resultJson) as { url: string; threadLink: { threadId: string; linked: boolean } })).toMatchObject({ url: PR, threadLink: { threadId: id, linked: true } });
      expect(w.threads.get(id)?.linkedPullRequests.filter((l) => l.url === PR)).toHaveLength(1);
      const again = await create();
      expect(typeof again === "string" ? again : again.message).toMatch(/already has alexwaumann\/code-foundry#128 linked$/);
      expect(w.threads.get(id)?.linkedPullRequests.filter((l) => l.url === PR)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("links nothing without a thread", async () => {
    vi.useFakeTimers();
    try {
      const w = new World();
      const out = w.invoke("pr.create", ctx({ activeWorktreePath: ghWorktree(w) }), {}, false);
      await vi.advanceTimersByTimeAsync(1000);
      const res = await out;
      expect(typeof res === "string" ? res : res.message).toBe(`created pull request #128: ${PR}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a GitHub card's Open PR in the mock (internal/command verbSources)", () => {
  const prTabs = (w: World) => w.layout.state().spaces.flatMap((sp) => panes(sp.root)).flatMap((p) => p.tabs ?? []).filter((t) => t.kind === "pullrequest");
  const cardOf = (w: World, key: string) => w.notifications.json().notifications.find((n) => n.key === key && n.status === "shown");

  it("runs view.open.pr --repo-slug: one tab of no thread, focused, however often it is pressed; the card stays", async () => {
    const w = new World();
    w.notifications.control("github", new URLSearchParams("quiet=1"));
    const card = cardOf(w, "pr/alexwaumann/code-foundry#139/review-requested");
    expect(card?.actions[0]).toMatchObject({ label: "Open PR", kind: "command", arg: "view.open.pr", args: { "repo-slug": "alexwaumann/code-foundry", number: "139", focus: "true" }, resolves: false });
    for (let i = 0; i < 2; i++) await run(w, "notification.act", { activeView: "thread", activeThreadId: "s-1" }, { id: card?.id ?? "" });
    const tabs = prTabs(w);
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ params: { slug: "alexwaumann/code-foundry", number: "139" } });
    expect(tabs[0]?.thread).toBeUndefined();
    const st = w.layout.state();
    const focused = panes(st.spaces.find((sp) => sp.id === st.current_space)?.root).find((p) => p.tabs?.some((t) => t.id === tabs[0]?.id));
    expect(focused?.active).toBe(tabs[0]?.id);
    expect(cardOf(w, "pr/alexwaumann/code-foundry#139/review-requested")).toBeDefined();
    // The verb ran with the caller's view only, as the daemon's act runs it.
    expect(w.invocations.filter((i) => i.name === "view.open.pr").map((i) => i.context?.activeThreadId ?? "")).toEqual(["", ""]);
  });

  it("a refused verb fails the act and leaves the card", async () => {
    const w = new World();
    w.notifications.post({ source: "github", key: "pr/acme/web#1/conflict", title: "Merge conflict on your PR", actions: [{ label: "Open PR", kind: "command", arg: "view.open.pr", args: { "repo-slug": "not-a-slug", number: "1" }, resolves: false }] });
    const card = cardOf(w, "pr/acme/web#1/conflict");
    await expect(run(w, "notification.act", { activeView: "thread" }, { id: card?.id ?? "" })).rejects.toThrow(/owner\/name/);
    expect(prTabs(w)).toHaveLength(0);
    expect(cardOf(w, "pr/acme/web#1/conflict")).toBeDefined();
  });
});
