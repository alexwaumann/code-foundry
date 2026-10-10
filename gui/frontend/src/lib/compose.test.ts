import { describe, expect, it } from "vitest";
import {
  checkAttachments,
  checkoutBranch,
  createdSessionId,
  draftKey,
  draftMembers,
  isWorkspaceKey,
  pickDefault,
  MODEL_CHOICES,
  projectHue,
  projectInitials,
  repoSource,
  sessionNewArgs,
  threadArgs,
  threadPlace,
  type DraftArgsInput,
  type PlaceEnv,
  type PlaceInput,
  type ThreadPlace,
} from "./compose";

const MB = 1024 * 1024;
const opts = { types: ["image/png", "image/jpeg"], maxBytes: 10 * MB };
const file = (name: string, type = "image/png", size = 1000) => ({ name, type, size });

describe("checkAttachments", () => {
  it.each([
    ["accepts images", [file("a.png"), file("b.jpg", "image/jpeg")], 0, ["a.png", "b.jpg"], []],
    ["rejects other types", [file("notes.txt", "text/plain")], 0, [], ["notes.txt: not a PNG, JPEG, GIF or WebP image"]],
    ["rejects files over the limit", [file("big.png", "image/png", 11 * MB)], 0, [], ["big.png: larger than 10 MB"]],
    ["names unnamed pastes", [file("", "image/svg+xml")], 0, [], ["pasted image: not a PNG, JPEG, GIF or WebP image"]],
    ["caps the count at 10 including existing ones", [file("a.png"), file("b.png"), file("c.png")], 9, ["a.png"], ["At most 10 images per thread; 2 not attached"]],
  ])("%s", (_name, files, existing, accepted, rejected) => {
    const res = checkAttachments(files, existing, opts);
    expect(res.accepted.map((f) => f.name)).toEqual(accepted);
    expect(res.rejected).toEqual(rejected);
  });
});

describe("sessionNewArgs", () => {
  const base: DraftArgsInput = { text: "  Add a dark mode toggle \n", model: "opus", effort: "high", permission: "auto", worktree: { kind: "new" }, base: "origin/main" };
  it.each<[string, Partial<DraftArgsInput>, string[], Record<string, string>]>([
    [
      "new worktree from a base, with attachments",
      {},
      ["/a/1.png", "/a/2.png"],
      { repo: "r", "new-worktree": "true", base: "origin/main", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle", attachments: "/a/1.png,/a/2.png" },
    ],
    ["new worktree without a known base lets the daemon pick", { base: "" }, [], { repo: "r", "new-worktree": "true", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle" }],
    [
      "existing worktree: its path, no base",
      { worktree: { kind: "existing", path: "/src/app" }, model: "", effort: "", text: "" },
      [],
      { repo: "r", worktree: "/src/app", permission: "auto" },
    ],
  ])("%s", (_name, over, staged, want) => {
    expect(sessionNewArgs("r", { ...base, ...over }, staged)).toEqual(want);
  });
});

describe("workspaces", () => {
  const login = {
    id: "w-1",
    members: [
      { repoId: "web", worktreePath: "/wt/web/cf-login" },
      { repoId: "api", worktreePath: "/wt/api/cf-login" },
    ],
  };
  const repos = new Set(["web", "api", "lib"]);
  const env: PlaceEnv = {
    workspace: login,
    isRepo: (id) => repos.has(id),
    hasWorktree: (repoId, path) => repoId === "web" && path === "/src/web-fix",
    defaultRef: "origin/main",
  };
  const project: PlaceInput = { target: { kind: "project", repoId: "web" }, worktree: { kind: "new" }, base: null, alsoIn: [], primary: null };
  const workspace: PlaceInput = { target: { kind: "workspace", workspaceId: "w-1" }, worktree: { kind: "members" }, base: null, alsoIn: [], primary: null };

  it("draft keys keep projects as repo ids and prefix workspaces", () => {
    expect(draftKey({ kind: "project", repoId: "web" })).toBe("web");
    expect(draftKey({ kind: "workspace", workspaceId: "w-1" })).toBe("ws:w-1");
    expect(isWorkspaceKey("ws:w-1")).toBe(true);
    expect(isWorkspaceKey("web")).toBe(false);
  });

  it.each<[string, PlaceInput, string[], string]>([
    ["a project alone", project, ["web"], "web"],
    ["a project with Also in, unknown and duplicate ones dropped", { ...project, alsoIn: ["api", "gone", "web", "api"] }, ["web", "api"], "web"],
    ["the primary can be an Also in project", { ...project, alsoIn: ["api"], primary: "api" }, ["web", "api"], "api"],
    ["a primary no longer listed falls back to the project", { ...project, alsoIn: [], primary: "api" }, ["web"], "web"],
    ["a workspace: its members, the first by default", workspace, ["web", "api"], "web"],
    ["a workspace primary", { ...workspace, primary: "api" }, ["web", "api"], "api"],
    ["a workspace ignores Also in", { ...workspace, alsoIn: ["lib"] }, ["web", "api"], "web"],
  ])("draftMembers: %s", (_name, d, repoIds, primary) => {
    expect(draftMembers(d, login, (id) => repos.has(id))).toEqual({ repoIds, primary });
  });

  it.each<[string, PlaceInput, Partial<PlaceEnv>, ThreadPlace | null]>([
    ["a project, new worktree, default base", project, {}, { kind: "project", repoId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    ["a project, existing worktree", { ...project, worktree: { kind: "existing", path: "/src/web-fix" } }, {}, { kind: "project", repoId: "web", worktree: { kind: "existing", path: "/src/web-fix" }, base: "origin/main" }],
    ["a project whose chosen worktree is gone: a new one", { ...project, worktree: { kind: "existing", path: "/gone" } }, {}, { kind: "project", repoId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    [
      "Also in: a new workspace, every project's default base",
      { ...project, worktree: { kind: "existing", path: "/src/web-fix" }, alsoIn: ["api"] },
      {},
      { kind: "new-workspace", repoIds: ["web", "api"], repoId: "web", base: "" },
    ],
    ["Also in with a picked base and another primary", { ...project, alsoIn: ["api"], primary: "api", base: "origin/dev" }, {}, { kind: "new-workspace", repoIds: ["web", "api"], repoId: "api", base: "origin/dev" }],
    ["a workspace's worktrees: the primary member", { ...workspace, primary: "api" }, {}, { kind: "workspace", workspaceId: "w-1", repoId: "api", worktreePath: "/wt/api/cf-login" }],
    ["a workspace in new-worktree mode: a new workspace with its projects", { ...workspace, worktree: { kind: "new" }, base: "origin/x" }, {}, { kind: "new-workspace", repoIds: ["web", "api"], repoId: "web", base: "origin/x" }],
    ["a workspace that is gone", workspace, { workspace: undefined }, null],
    ["a workspace with no members", workspace, { workspace: { id: "w-1", members: [] } }, null],
    [
      "a project without git: its current checkout, whatever the draft says",
      { ...project, target: { kind: "project", repoId: "notes" }, alsoIn: ["api"], base: "origin/dev" },
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", repoId: "notes", worktree: { kind: "existing", path: "/src/notes" }, base: "" },
    ],
    [
      "a git project is unaffected by noGitCheckout",
      project,
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", repoId: "web", worktree: { kind: "new" }, base: "origin/main" },
    ],
  ])("threadPlace: %s", (_name, d, over, want) => {
    expect(threadPlace(d, { ...env, ...over })).toEqual(want);
  });

  const prompt = { text: " Fix login ", model: "haiku", effort: "medium", permission: "auto" };
  it.each<[string, ThreadPlace, Record<string, string>]>([
    [
      "a workspace member",
      { kind: "workspace", workspaceId: "w-1", repoId: "api", worktreePath: "/wt/api/cf-login" },
      { repo: "api", workspace: "w-1", worktree: "/wt/api/cf-login", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a new workspace, default bases",
      { kind: "new-workspace", repoIds: ["web", "api"], repoId: "web", base: "" },
      { repo: "web", "new-worktree": "true", repos: "web,api", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a new workspace, the primary's own base",
      { kind: "new-workspace", repoIds: ["web", "api"], repoId: "api", base: "origin/dev" },
      { repo: "api", "new-worktree": "true", repos: "web,api:origin/dev", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
  ])("threadArgs: %s", (_name, place, want) => {
    expect(threadArgs(place, prompt, [])).toEqual(want);
  });
});

describe("checkoutBranch", () => {
  it.each([
    [{ branch: "main", head: "3c3c4651aa", detached: false, isMain: true }, "On main", "Current checkout is on main"],
    [{ branch: "feat/sidebar", head: "9a8b7c6d", detached: false, isMain: false }, "On feat/sidebar", "Worktree is on feat/sidebar"],
    [{ branch: "", head: "3c3c4651aa", detached: true, isMain: true }, "Detached at 3c3c465", "Current checkout is detached at 3c3c465"],
    [{ branch: "", head: "9a8b7c6d", detached: true, isMain: false }, "Detached at 9a8b7c6", "Worktree is detached at 9a8b7c6"],
    // A stale branch name never wins over the detached flag.
    [{ branch: "main", head: "abc1234", detached: true, isMain: true }, "Detached at abc1234", "Current checkout is detached at abc1234"],
    [{ branch: "", head: "", detached: true, isMain: false }, "Detached HEAD", "Worktree has a detached HEAD"],
  ])("checkoutBranch(%j)", (w, text, label) => {
    expect(checkoutBranch(w)).toEqual({ text, label });
  });
});

describe("helpers", () => {
  it("createdSessionId reads the Session JSON", () => {
    expect(createdSessionId('{"id":"s-1a2b","worktreePath":"/x"}')).toBe("s-1a2b");
    expect(createdSessionId("")).toBeNull();
    expect(createdSessionId("not json")).toBeNull();
    expect(createdSessionId('{"name":"x"}')).toBeNull();
  });

  it("pickDefault uses a known setting, else the fallback", () => {
    expect(pickDefault(MODEL_CHOICES, "sonnet", "opus")).toBe("sonnet");
    expect(pickDefault(MODEL_CHOICES, "", "opus")).toBe("opus");
    expect(pickDefault(MODEL_CHOICES, undefined, "opus")).toBe("opus");
    expect(pickDefault(MODEL_CHOICES, "gpt", "opus")).toBe("opus");
  });

  it.each([
    ["code-foundry", "CF"],
    ["ghostty-playground", "GP"],
    ["dotfiles", "DO"],
    ["my app_v2", "MA"],
    ["", "?"],
  ])("projectInitials(%j) = %s", (name, want) => {
    expect(projectInitials(name)).toBe(want);
  });

  it.each([
    [{ githubSlug: "", remotes: [] }, "Local only"],
    [{ githubSlug: "", remotes: [], git: true }, "Local only"],
    [{ githubSlug: "", remotes: [], git: false }, "No git"],
    [{ githubSlug: "alexwaumann/app", remotes: ["origin"] }, "alexwaumann/app"],
    [{ githubSlug: "", remotes: ["gitlab", "origin"] }, "origin"],
    [{ githubSlug: "", remotes: ["upstream"] }, "upstream"],
  ])("repoSource(%j) = %s", (r, want) => {
    expect(repoSource(r)).toBe(want);
  });

  it("projectHue is stable and in range", () => {
    expect(projectHue("code-foundry")).toBe(projectHue("code-foundry"));
    for (const n of ["a", "code-foundry", "dotfiles", "x".repeat(200)]) {
      expect(projectHue(n)).toBeGreaterThanOrEqual(0);
      expect(projectHue(n)).toBeLessThan(360);
    }
  });
});
