import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiContextView } from "@/api/command";
import type { InstalledListView, SkillQuery, SkillRegistriesView, SkillSearchView } from "@/api/skill";
import {
  applySkillFailure,
  browseAction,
  canRunSetup,
  disableSkill,
  dismissSkillFailure,
  installedActions,
  installSkill,
  onSkillEpoch,
  openSkillMarketplace,
  refreshSkillMarketplaces,
  removeLocalSkill,
  runSkillSetup,
  searchSkills,
  setSkillMarketplaceDeps,
  updateSkill,
  useSkillMarketplaceStore,
  type SkillMarketplaceDeps,
} from "./skill";

const ctx = (over: Partial<UiContextView> = {}): UiContextView => ({ activeThreadId: "", activeTerminalId: "", activeProjectId: "", activeWorktreePath: "", activeView: "", activeWorkspaceId: "", ...over });

const searchView = (names: string[], epoch = 1): SkillSearchView => ({
  entries: names.map((name) => ({
    key: `skill:${name}`,
    kind: "skill",
    tier: "enterprise",
    name,
    description: "",
    by: "",
    version: "20261001",
    declaredVersion: "",
    lastUpdatedMs: null,
    registry: "ai-marketplace",
    path: `enterprise/skills/${name}`,
    keywords: [],
    skills: [],
    setupScript: "",
    state: "not-installed",
    installedVersion: "",
    updateVersion: "",
  })),
  total: names.length,
  refreshError: "",
  epoch,
});

const installedView = (epoch = 1): InstalledListView => ({ installed: [], pluginsError: "", epoch });
const registriesView = (epoch = 1): SkillRegistriesView => ({ registries: [], error: "", expectedMarketplace: "ai-marketplace", epoch });

/** A deferred answer per call, so a test decides the order answers arrive in. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

let calls: { name: string; args: Record<string, string>; ctx?: UiContextView }[];
let runResult: (name: string) => { message: string; resultJson: string } | null;
let runError: string;

function install(over: Partial<SkillMarketplaceDeps> = {}): void {
  calls = [];
  runResult = () => ({ message: "ok", resultJson: "{}" });
  runError = "";
  setSkillMarketplaceDeps({
    search: (q: SkillQuery) => Promise.resolve(searchView(q.text ? [q.text] : ["a", "b"])),
    installed: () => Promise.resolve(installedView()),
    registries: () => Promise.resolve(registriesView()),
    run: (name, args, opts) => {
      calls.push({ name, args, ...(opts.ctx ? { ctx: opts.ctx } : {}) });
      const res = runResult(name);
      if (res === null && runError) opts.onError?.(runError);
      return Promise.resolve(res);
    },
    context: () => ctx({ activeThreadId: "s-1" }),
    reveal: () => {},
    reloadDelayMs: 0,
    ...over,
  });
}

beforeEach(() => { install(); });
afterEach(() => { setSkillMarketplaceDeps(null); });

describe("search", () => {
  it("keeps the newest query's answer and drops an older one that arrives late", async () => {
    const answers = { sq: deferred<SkillSearchView>(), sql: deferred<SkillSearchView>() };
    install({ search: (q) => (q.text === "sq" ? answers.sq : answers.sql).promise });
    const first = searchSkills("sq");
    const second = searchSkills("sql", "enterprise", "skill");
    expect(useSkillMarketplaceStore.getState().query).toEqual({ text: "sql", tier: "enterprise", kind: "skill" });
    answers.sql.resolve(searchView(["sql-helper"]));
    await second;
    answers.sq.resolve(searchView(["stale"]));
    await first;
    const s = useSkillMarketplaceStore.getState();
    expect(s.search?.entries.map((e) => e.name)).toEqual(["sql-helper"]);
    expect(s.searching).toBe(false);
  });

  it("aborts the request in flight for an older query", async () => {
    const signals: AbortSignal[] = [];
    install({
      search: (_q, _limit, signal) => {
        if (signal) signals.push(signal);
        return Promise.resolve(searchView([]));
      },
    });
    const a = searchSkills("a");
    const b = searchSkills("ab");
    await Promise.all([a, b]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("reports a failed search and keeps the last hits", async () => {
    await searchSkills("x");
    install({ search: () => Promise.reject(new Error("daemon down")) });
    await searchSkills("y");
    const s = useSkillMarketplaceStore.getState();
    expect(s.searchError).toBe("daemon down");
    expect(s.search?.entries.map((e) => e.name)).toEqual(["x"]);
  });

  it("asks for SKILL_SEARCH_LIMIT hits", async () => {
    const limits: number[] = [];
    install({ search: (_q, limit) => (limits.push(limit), Promise.resolve(searchView([]))) });
    await searchSkills("");
    expect(limits).toEqual([200]);
  });
});

describe("open and epochs", () => {
  it("reads everything on open, re-reads on a new epoch while open, not after close", async () => {
    let reads = 0;
    install({ installed: () => (reads++, Promise.resolve(installedView(reads))) });
    const close = openSkillMarketplace();
    await vi.waitFor(() => { expect(useSkillMarketplaceStore.getState().installed).not.toBeNull(); });
    expect(useSkillMarketplaceStore.getState().registries?.expectedMarketplace).toBe("ai-marketplace");
    expect(useSkillMarketplaceStore.getState().search?.entries.map((e) => e.name)).toEqual(["a", "b"]);
    expect(reads).toBe(1);

    onSkillEpoch(5);
    await vi.waitFor(() => { expect(reads).toBe(2); });
    onSkillEpoch(5); // the same epoch again: nothing
    await flush();
    await flush();
    expect(reads).toBe(2);

    close();
    onSkillEpoch(6);
    await flush();
    await flush();
    expect(reads).toBe(2);
    expect(useSkillMarketplaceStore.getState().epoch).toBe(6);
  });

  it("re-runs the current query on a re-read", async () => {
    const texts: string[] = [];
    install({ search: (q) => (texts.push(q.text), Promise.resolve(searchView([q.text]))) });
    await searchSkills("pr");
    const close = openSkillMarketplace();
    await vi.waitFor(() => { expect(texts).toEqual(["pr", "pr"]); });
    close();
  });
});

describe("actions", () => {
  const entry = { kind: "plugin" as const, name: "enterprise-data", registry: "ai-marketplace" };
  const skill = { kind: "skill" as const, name: "pr-review", registry: "ai-marketplace" };

  it.each([
    ["install a plugin", () => installSkill(entry), "skill.install", { name: "enterprise-data@ai-marketplace", kind: "plugin" }],
    ["install a skill", () => installSkill(skill), "skill.install", { name: "pr-review", kind: "skill" }],
    ["disable", () => disableSkill(skill), "skill.disable", { name: "pr-review", kind: "skill" }],
    ["update", () => updateSkill(entry), "skill.update", { name: "enterprise-data@ai-marketplace", kind: "plugin" }],
    ["remove passes no kind", () => removeLocalSkill({ kind: "skill", name: "mine", registry: "" }), "skill.remove", { name: "mine" }],
  ] as const)("%s", async (_name, run, cmd, args) => {
    expect(await run()).toBe(true);
    expect(calls).toEqual([{ name: cmd, args }]);
    expect(useSkillMarketplaceStore.getState().busy).toEqual({});
  });

  it("is busy while it runs and leaves a second click alone", async () => {
    const answer = deferred<{ message: string; resultJson: string } | null>();
    install({ run: (name, args) => (calls.push({ name, args }), answer.promise) });
    const p = installSkill(skill);
    expect(useSkillMarketplaceStore.getState().busy).toEqual({ "skill:pr-review": "install" });
    expect(await installSkill(skill)).toBe(false);
    answer.resolve({ message: "", resultJson: "{}" });
    expect(await p).toBe(true);
    expect(calls).toHaveLength(1);
    expect(useSkillMarketplaceStore.getState().busy).toEqual({});
  });

  it("keeps a failure under the row until the next try succeeds; a declined confirm leaves none", async () => {
    runResult = () => null;
    runError = 'skill pr-review: the directory /Users/me/.claude/skills/pr-review is not one Code Foundry installed';
    expect(await installSkill(skill)).toBe(false);
    expect(useSkillMarketplaceStore.getState().failures["skill:pr-review"]).toEqual({ action: "install", message: runError });

    runError = ""; // the user declined the confirm
    expect(await disableSkill(skill)).toBe(false);
    expect(useSkillMarketplaceStore.getState().failures["skill:pr-review"]).toBeUndefined();

    runResult = () => null;
    runError = "boom";
    await installSkill(skill);
    dismissSkillFailure("skill:pr-review");
    expect(useSkillMarketplaceStore.getState().failures).toEqual({});

    await installSkill(skill);
    runResult = () => ({ message: "ok", resultJson: "{}" });
    await installSkill(skill);
    expect(useSkillMarketplaceStore.getState().failures).toEqual({});
  });

  it("re-reads after an action while the page is open", async () => {
    let reads = 0;
    install({ installed: () => (reads++, Promise.resolve(installedView())) });
    const close = openSkillMarketplace();
    await vi.waitFor(() => { expect(reads).toBe(1); });
    await installSkill(skill);
    await vi.waitFor(() => { expect(reads).toBe(2); });
    close();
  });

  it("runs setup in the context, returns the terminal and reveals it when asked", async () => {
    const revealed: string[] = [];
    install({ reveal: (id) => revealed.push(id) });
    runResult = () => ({ message: "running", resultJson: JSON.stringify({ id: "t-9", labels: { kind: "setup" } }) });
    expect(await runSkillSetup(skill)).toBe("t-9");
    expect(revealed).toEqual([]);
    expect(await runSkillSetup(skill, { reveal: true })).toBe("t-9");
    expect(revealed).toEqual(["t-9"]);
    expect(calls[0]).toEqual({ name: "skill.setup", args: { name: "pr-review" }, ctx: ctx({ activeThreadId: "s-1" }) });
    runResult = () => null;
    expect(await runSkillSetup(skill, { reveal: true })).toBeNull();
  });

  it("refreshes the marketplaces once at a time", async () => {
    const answer = deferred<{ message: string; resultJson: string } | null>();
    install({ run: (name, args) => (calls.push({ name, args }), answer.promise) });
    const p = refreshSkillMarketplaces();
    expect(useSkillMarketplaceStore.getState().refreshing).toBe(true);
    expect(await refreshSkillMarketplaces()).toBe(false);
    answer.resolve({ message: "", resultJson: "[]" });
    expect(await p).toBe(true);
    expect(calls).toEqual([{ name: "skill.refresh", args: {} }]);
    expect(useSkillMarketplaceStore.getState().refreshing).toBe(false);
  });
});

describe("what a row offers", () => {
  it.each([
    ["not installed", { state: "not-installed", updateVersion: "" }, "install"],
    ["installed", { state: "enabled", updateVersion: "" }, "installed"],
    ["disabled", { state: "disabled", updateVersion: "" }, "installed"],
    ["update offered", { state: "enabled", updateVersion: "1.3.9" }, "update"],
  ] as const)("browse: %s", (_name, e, want) => {
    expect(browseAction(e)).toBe(want);
  });

  const offer = { version: "20261020", lastUpdatedMs: null, commitSha: "" };
  it.each([
    ["local", { state: "local", enabled: true, update: null, needsSetup: false, kind: "skill" }, ["remove"]],
    ["missing", { state: "missing", enabled: false, update: offer, needsSetup: false, kind: "skill" }, ["update", "uninstall"]],
    ["enabled", { state: "installed", enabled: true, update: null, needsSetup: false, kind: "skill" }, ["disable", "uninstall"]],
    ["disabled with an update", { state: "installed", enabled: false, update: offer, needsSetup: false, kind: "plugin" }, ["enable", "update", "uninstall"]],
    ["needs setup", { state: "installed", enabled: true, update: null, needsSetup: true, kind: "skill" }, ["disable", "setup", "uninstall"]],
  ] as const)("installed: %s", (_name, r, want) => {
    expect(installedActions(r)).toEqual(want);
  });

  it.each([
    ["a thread", ctx({ activeThreadId: "s-1" }), true],
    ["a worktree", ctx({ activeWorktreePath: "/w" }), true],
    ["a project", ctx({ activeProjectId: "p" }), true],
    ["nothing", ctx(), false],
  ])("setup with %s", (_name, c, want) => {
    expect(canRunSetup(c)).toBe(want);
  });

  it("applySkillFailure replaces and clears one row", () => {
    const s = applySkillFailure({ a: { action: "install", message: "x" } }, "b", { action: "update", message: "y" });
    expect(Object.keys(s)).toEqual(["a", "b"]);
    expect(applySkillFailure(s, "a", null)).toEqual({ b: { action: "update", message: "y" } });
  });
});
