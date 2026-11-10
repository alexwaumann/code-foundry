// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ActionRunMode, ActionRunState } from "../src/gen/codefoundry/v1/action_pb";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { PermissionMode } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
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
