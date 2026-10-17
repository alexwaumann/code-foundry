import { describe, expect, it } from "vitest";
import { FALLBACK_MODEL_CHOICES } from "./models";
import {
  checkAttachments,
  checkoutBranch,
  inlineBytes,
  inlineCapNotice,
  longPdfNotice,
  pageCount,
  previewLabel,
  sentInline,
  type AttachmentLimits,
  type InlineLike,
  createdThreadId,
  DEFAULT_MODEL,
  draftKey,
  draftMembers,
  HOME_KEY,
  isWorkspaceKey,
  movedDraft,
  pickDefault,
  projectChipBranch,
  projectHue,
  projectInitials,
  projectSource,
  threadNewArgs,
  threadArgs,
  threadPlace,
  defaultWorktree,
  workInMemory,
  workInText,
  type ComposeTarget,
  type DraftArgsInput,
  type WorktreeChoice,
  type MovableDraft,
  type PlaceEnv,
  type PlaceInput,
  type ThreadPlace,
} from "./compose";
import { tagToken } from "./prompt";

const MB = 1024 * 1024;
const PDF = "application/pdf";
const limits: AttachmentLimits = {
  types: ["image/png", "image/jpeg", PDF],
  pdfType: PDF,
  maxBytes: (type) => (type === PDF ? 20 * MB : 10 * MB),
  maxInlineBytes: 24 * MB,
  maxInlinePages: 10,
};
const file = (name: string, type = "image/png", size = 1000) => ({ name, type, size });
const CAP = "Attachments sent with one message must total under 24 MB";

describe("checkAttachments", () => {
  it.each<[string, ReturnType<typeof file>[], { count: number; inlineBytes: number }, string[], string[]]>([
    ["accepts images and PDFs", [file("a.png"), file("b.jpg", "image/jpeg"), file("spec.pdf", PDF)], { count: 0, inlineBytes: 0 }, ["a.png", "b.jpg", "spec.pdf"], []],
    ["rejects other types", [file("notes.txt", "text/plain")], { count: 0, inlineBytes: 0 }, [], ["notes.txt: not a PNG, JPEG, GIF, WebP or PDF file"]],
    ["rejects images over 10 MB", [file("big.png", "image/png", 11 * MB)], { count: 0, inlineBytes: 0 }, [], ["big.png: larger than 10 MB"]],
    ["takes PDFs up to 20 MB", [file("book.pdf", PDF, 19 * MB)], { count: 0, inlineBytes: 0 }, ["book.pdf"], []],
    ["rejects PDFs over 20 MB", [file("huge.pdf", PDF, 21 * MB)], { count: 0, inlineBytes: 0 }, [], ["huge.pdf: larger than 20 MB"]],
    ["names unnamed pastes", [file("", "image/svg+xml")], { count: 0, inlineBytes: 0 }, [], ["pasted image: not a PNG, JPEG, GIF, WebP or PDF file"]],
    ["caps the count at 10 including existing ones", [file("a.png"), file("b.pdf", PDF), file("c.png")], { count: 9, inlineBytes: 0 }, ["a.png"], ["At most 10 attachments per message; 2 not attached"]],
    [
      "rejects an image that takes the message over the inline cap",
      [file("a.png", "image/png", 9 * MB), file("b.png", "image/png", 9 * MB), file("c.png", "image/png", 1 * MB)],
      { count: 0, inlineBytes: 8 * MB },
      ["a.png", "c.png"],
      [`${CAP}; b.png not attached`],
    ],
    // A PDF's pages are not known yet: the cap applies once they are (stores/compose settlePdf).
    ["does not hold a PDF to the inline cap", [file("spec.pdf", PDF, 19 * MB)], { count: 0, inlineBytes: 20 * MB }, ["spec.pdf"], []],
  ])("%s", (_name, files, existing, accepted, rejected) => {
    const res = checkAttachments(files, existing, limits);
    expect(res.accepted.map((f) => f.name)).toEqual(accepted);
    expect(res.rejected).toEqual(rejected);
  });
});

describe("inline bytes", () => {
  it.each<[string, InlineLike, boolean]>([
    ["an image", { kind: "image", size: 1, pages: null }, true],
    ["a PDF still being counted", { kind: "pdf", size: 1, pages: null }, false],
    ["a 10-page PDF", { kind: "pdf", size: 1, pages: 10 }, true],
    ["an 11-page PDF", { kind: "pdf", size: 1, pages: 11 }, false],
  ])("%s", (_name, a, inline) => {
    expect(sentInline(a, 10)).toBe(inline);
  });

  it("sums what goes inline", () => {
    const list: InlineLike[] = [
      { kind: "image", size: 3, pages: null },
      { kind: "pdf", size: 5, pages: 2 },
      { kind: "pdf", size: 7, pages: 30 },
      { kind: "pdf", size: 11, pages: null },
    ];
    expect(inlineBytes(list, 10)).toBe(8);
  });

  it("words the notices", () => {
    expect(inlineCapNotice("a.pdf", 24 * MB)).toBe(`${CAP}; a.pdf not attached`);
    expect(longPdfNotice("book.pdf", 30)).toBe("book.pdf has 30 pages; Claude reads it page by page");
    expect([pageCount(1), pageCount(12)]).toEqual(["1 page", "12 pages"]);
    expect(previewLabel("a.png", "image", null, "58 KB")).toBe("Preview a.png, 58 KB");
    expect(previewLabel("spec.pdf", "pdf", 12, "1.4 MB")).toBe("Preview spec.pdf, PDF, 12 pages, 1.4 MB");
    expect(previewLabel("spec.pdf", "pdf", null, "")).toBe("Preview spec.pdf, PDF");
  });
});

describe("threadNewArgs", () => {
  const base: DraftArgsInput = { text: "  Add a dark mode toggle \n", model: "opus", effort: "high", permission: "auto", worktree: { kind: "new" }, base: "origin/main" };
  it.each<[string, Partial<DraftArgsInput>, string[], Record<string, string>]>([
    [
      "new worktree from a base, with attachments",
      {},
      ["/a/1.png", "/a/2.png"],
      { project: "r", "new-worktree": "true", base: "origin/main", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle", attachments: "/a/1.png,/a/2.png" },
    ],
    ["new worktree without a known base lets the daemon pick", { base: "" }, [], { project: "r", "new-worktree": "true", model: "opus", effort: "high", permission: "auto", prompt: "Add a dark mode toggle" }],
    [
      "existing worktree: its path, no base",
      { worktree: { kind: "existing", path: "/src/app" }, model: "", effort: "", text: "" },
      [],
      { project: "r", worktree: "/src/app", permission: "auto" },
    ],
  ])("%s", (_name, over, staged, want) => {
    expect(threadNewArgs("r", { ...base, ...over }, staged)).toEqual(want);
  });
});

describe("workspaces", () => {
  const login = {
    id: "w-1",
    members: [
      { projectId: "web", worktreePath: "/wt/web/cf-login" },
      { projectId: "api", worktreePath: "/wt/api/cf-login" },
    ],
  };
  const projects = new Set(["web", "api", "lib"]);
  const env: PlaceEnv = {
    workspace: login,
    isGitProject: (id) => projects.has(id),
    hasWorktree: (projectId, path) => projectId === "web" && path === "/src/web-fix",
    defaultRef: "origin/main",
  };
  const project: PlaceInput = { target: { kind: "project", projectId: "web" }, worktree: { kind: "new" }, base: null, alsoIn: [], primary: null };
  const workspace: PlaceInput = { target: { kind: "workspace", workspaceId: "w-1" }, worktree: { kind: "members" }, base: null, alsoIn: [], primary: null };

  it("draft keys keep projects as project ids and prefix workspaces", () => {
    expect(draftKey({ kind: "project", projectId: "web" })).toBe("web");
    expect(draftKey({ kind: "workspace", workspaceId: "w-1" })).toBe("ws:w-1");
    expect(isWorkspaceKey("ws:w-1")).toBe(true);
    expect(isWorkspaceKey("web")).toBe(false);
  });

  it("no project has its own draft key, no member and no primary", () => {
    expect(draftKey({ kind: "home" })).toBe(HOME_KEY);
    expect(isWorkspaceKey(HOME_KEY)).toBe(false);
    expect(draftMembers({ target: { kind: "home" }, alsoIn: ["web"], primary: "web" }, login, (id) => projects.has(id))).toEqual({ projectIds: [], primary: "" });
  });

  it.each<[string, PlaceInput, string[], string]>([
    ["a project alone", project, ["web"], "web"],
    ["a project with Also in, unknown and duplicate ones dropped", { ...project, alsoIn: ["api", "gone", "web", "api"] }, ["web", "api"], "web"],
    ["the primary can be an Also in project", { ...project, alsoIn: ["api"], primary: "api" }, ["web", "api"], "api"],
    ["a primary no longer listed falls back to the project", { ...project, alsoIn: [], primary: "api" }, ["web"], "web"],
    ["a workspace: its members, the first by default", workspace, ["web", "api"], "web"],
    ["a workspace primary", { ...workspace, primary: "api" }, ["web", "api"], "api"],
    ["a workspace ignores Also in", { ...workspace, alsoIn: ["lib"] }, ["web", "api"], "web"],
  ])("draftMembers: %s", (_name, d, projectIds, primary) => {
    expect(draftMembers(d, login, (id) => projects.has(id))).toEqual({ projectIds, primary });
  });

  it.each<[string, PlaceInput, Partial<PlaceEnv>, ThreadPlace | null]>([
    ["a project, new worktree, default base", project, {}, { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    ["a project, existing worktree", { ...project, worktree: { kind: "existing", path: "/src/web-fix" } }, {}, { kind: "project", projectId: "web", worktree: { kind: "existing", path: "/src/web-fix" }, base: "origin/main" }],
    ["a project whose chosen worktree is gone: a new one", { ...project, worktree: { kind: "existing", path: "/gone" } }, {}, { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    [
      "Also in: a new workspace, every project's default base",
      { ...project, worktree: { kind: "existing", path: "/src/web-fix" }, alsoIn: ["api"] },
      {},
      { kind: "new-workspace", projectIds: ["web", "api"], projectId: "web", base: "" },
    ],
    ["Also in with a picked base and another primary", { ...project, alsoIn: ["api"], primary: "api", base: "origin/dev" }, {}, { kind: "new-workspace", projectIds: ["web", "api"], projectId: "api", base: "origin/dev" }],
    ["a workspace's worktrees: the primary member", { ...workspace, primary: "api" }, {}, { kind: "workspace", workspaceId: "w-1", projectId: "api", worktreePath: "/wt/api/cf-login" }],
    ["a workspace in new-worktree mode: a new workspace with its projects", { ...workspace, worktree: { kind: "new" }, base: "origin/x" }, {}, { kind: "new-workspace", projectIds: ["web", "api"], projectId: "web", base: "origin/x" }],
    ["a workspace that is gone", workspace, { workspace: undefined }, null],
    ["a workspace with no members", workspace, { workspace: { id: "w-1", members: [] } }, null],
    [
      "a project without git: its current checkout, whatever the draft says",
      { ...project, target: { kind: "project", projectId: "notes" }, alsoIn: ["api"], base: "origin/dev" },
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", projectId: "notes", worktree: { kind: "existing", path: "/src/notes" }, base: "" },
    ],
    [
      "a git project is unaffected by noGitCheckout",
      project,
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" },
    ],
  ])("threadPlace: %s", (_name, d, over, want) => {
    expect(threadPlace(d, { ...env, ...over })).toEqual(want);
  });

  const prompt = { text: " Fix login ", model: "haiku", effort: "medium", permission: "auto" };
  it.each<[string, ThreadPlace, Record<string, string>]>([
    [
      "a workspace member",
      { kind: "workspace", workspaceId: "w-1", projectId: "api", worktreePath: "/wt/api/cf-login" },
      { project: "api", workspace: "w-1", worktree: "/wt/api/cf-login", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a new workspace, default bases",
      { kind: "new-workspace", projectIds: ["web", "api"], projectId: "web", base: "" },
      { project: "web", "new-worktree": "true", projects: "web,api", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a new workspace, the primary's own base",
      { kind: "new-workspace", projectIds: ["web", "api"], projectId: "api", base: "origin/dev" },
      { project: "api", "new-worktree": "true", projects: "web,api:origin/dev", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
  ])("threadArgs: %s", (_name, place, want) => {
    expect(threadArgs(place, prompt, [])).toEqual(want);
  });

  it("threadArgs passes the composer's text with a prompt only", () => {
    const place: ThreadPlace = { kind: "workspace", workspaceId: "w-1", projectId: "api", worktreePath: "/wt" };
    expect(threadArgs(place, { ...prompt, text: "/tdd go", composerText: " [/tdd](cf-skill://~/tdd) go " }, [])).toMatchObject({ prompt: "/tdd go", "composer-prompt": "[/tdd](cf-skill://~/tdd) go" });
    expect(threadArgs(place, { ...prompt, text: " ", composerText: "x" }, [])).not.toHaveProperty("composer-prompt");
    expect(threadArgs(place, { ...prompt, text: "no tags", composerText: "no tags" }, [])).not.toHaveProperty("composer-prompt");
  });

  it("no project: the thread starts at home, whatever the draft says; thread.new gets no-project alone", () => {
    const d: PlaceInput = { target: { kind: "home" }, worktree: { kind: "existing", path: "/src/web-fix" }, base: "origin/dev", alsoIn: ["api"], primary: "api" };
    const place = threadPlace(d, env);
    expect(place).toEqual({ kind: "home" });
    expect(threadArgs({ kind: "home" }, { ...prompt, composerText: "[/tdd](cf-skill://~/tdd) Fix login" }, ["/tmp/a.png"])).toEqual({
      "no-project": "true",
      model: "haiku",
      effort: "medium",
      permission: "auto",
      prompt: "Fix login",
      "composer-prompt": "[/tdd](cf-skill://~/tdd) Fix login",
      attachments: "/tmp/a.png",
    });
  });
});

describe("Work in", () => {
  it.each<[string, { setting?: string; remembered?: string; mainPath?: string }, WorktreeChoice]>([
    ["nothing set: a fresh copy", { mainPath: "/src/cf" }, { kind: "new" }],
    ["setting new", { setting: "new", mainPath: "/src/cf" }, { kind: "new" }],
    ["setting current: the main checkout", { setting: "current", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
    ["setting current, main checkout unknown: a fresh copy", { setting: "current" }, { kind: "new" }],
    ["an unknown setting value: a fresh copy", { setting: "", mainPath: "/src/cf" }, { kind: "new" }],
    ["remembered current over setting new", { setting: "new", remembered: "current", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
    ["remembered new over setting current", { setting: "current", remembered: "new", mainPath: "/src/cf" }, { kind: "new" }],
    ["a garbled memory is ignored", { setting: "current", remembered: "elsewhere", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
  ])("defaultWorktree: %s", (_, input, want) => {
    expect(defaultWorktree(input)).toEqual(want);
  });

  it.each<[string, WorktreeChoice & { kind: "new" | "existing" }, string | undefined, string | null]>([
    ["a fresh copy", { kind: "new" }, "/src/cf", "new"],
    ["the main checkout", { kind: "existing", path: "/src/cf" }, "/src/cf", "current"],
    ["another worktree: a one-off", { kind: "existing", path: "/wt/cf-x" }, "/src/cf", null],
    ["main checkout unknown", { kind: "existing", path: "/src/cf" }, undefined, null],
  ])("workInMemory: %s", (_, choice, mainPath, want) => {
    expect(workInMemory(choice, mainPath)).toBe(want);
  });

  const main = { isMain: true, branch: "main", head: "3c3c4651234" };
  const feat = { isMain: false, branch: "feat/sidebar", head: "abcdef01234" };
  it.each<[string, Parameters<typeof workInText>[0], string]>([
    ["a new worktree", { workspace: false, noGit: false, worktree: { kind: "new" } }, "Fresh copy"],
    ["the main checkout", { workspace: false, noGit: false, worktree: { kind: "existing", path: "/src/cf" }, chosen: main }, "In place"],
    ["the main checkout, detached", { workspace: false, noGit: false, worktree: { kind: "existing", path: "/src/cf" }, chosen: { ...main, branch: "" } }, "In place"],
    ["another worktree: its branch", { workspace: false, noGit: false, worktree: { kind: "existing", path: "/wt/x" }, chosen: feat }, "feat/sidebar"],
    ["another worktree, detached: its short head", { workspace: false, noGit: false, worktree: { kind: "existing", path: "/wt/x" }, chosen: { ...feat, branch: "" } }, "abcdef0"],
    ["an existing worktree not listed: a fresh copy", { workspace: false, noGit: false, worktree: { kind: "existing", path: "/gone" } }, "Fresh copy"],
    ["a project without git", { workspace: false, noGit: true, worktree: { kind: "existing", path: "/docs" } }, "In place"],
    ["a workspace in its worktrees", { workspace: true, noGit: false, worktree: { kind: "members" } }, "Workspace worktrees"],
    ["a workspace in new-worktree mode", { workspace: true, noGit: false, worktree: { kind: "new" } }, "New worktree"],
  ])("workInText: %s", (_, input, want) => {
    expect(workInText(input)).toBe(want);
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

describe("projectChipBranch", () => {
  it.each<[string, Parameters<typeof projectChipBranch>[0], ReturnType<typeof projectChipBranch>]>([
    ["a project without git: no branch, the badge", { noGit: true, newWorktree: false, checkout: { branch: "", head: "" } }, { branch: "", noGit: true }],
    ["without git, even if a draft asked for a new worktree", { noGit: true, newWorktree: true }, { branch: "", noGit: true }],
    ["a new worktree: the cf/… placeholder", { noGit: false, newWorktree: true, checkout: { branch: "main", head: "3c3c4651" } }, { branch: "cf/…", noGit: false }],
    ["the current checkout: its branch", { noGit: false, newWorktree: false, checkout: { branch: "main", head: "3c3c4651" } }, { branch: "main", noGit: false }],
    ["an existing worktree, detached: its short head", { noGit: false, newWorktree: false, checkout: { branch: "", head: "9a8b7c6d5e" } }, { branch: "9a8b7c6", noGit: false }],
    ["an existing checkout not known yet", { noGit: false, newWorktree: false }, { branch: "", noGit: false }],
  ])("%s", (_name, p, want) => {
    expect(projectChipBranch(p)).toEqual(want);
  });
});

describe("helpers", () => {
  it("createdThreadId reads the Thread JSON", () => {
    expect(createdThreadId('{"id":"s-1a2b","worktreePath":"/x"}')).toBe("s-1a2b");
    expect(createdThreadId("")).toBeNull();
    expect(createdThreadId("not json")).toBeNull();
    expect(createdThreadId('{"name":"x"}')).toBeNull();
  });

  it("pickDefault uses a known setting, else the fallback", () => {
    const choices = [...FALLBACK_MODEL_CHOICES, { value: "claude-sonnet-5[1m]", label: "Sonnet 5" }];
    expect(pickDefault(choices, "claude-sonnet-5[1m]", DEFAULT_MODEL)).toBe("claude-sonnet-5[1m]");
    expect(pickDefault(choices, "", DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(pickDefault(choices, undefined, DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
    expect(pickDefault(choices, "opus", DEFAULT_MODEL)).toBe(DEFAULT_MODEL);
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
  ])("projectSource(%j) = %s", (r, want) => {
    expect(projectSource(r)).toBe(want);
  });

  it("projectHue is stable and in range", () => {
    expect(projectHue("code-foundry")).toBe(projectHue("code-foundry"));
    for (const n of ["a", "code-foundry", "dotfiles", "x".repeat(200)]) {
      expect(projectHue(n)).toBeGreaterThanOrEqual(0);
      expect(projectHue(n)).toBeLessThan(360);
    }
  });
});

describe("movedDraft", () => {
  const proj = (projectId: string): ComposeTarget => ({ kind: "project", projectId });
  const ws = (workspaceId: string): ComposeTarget => ({ kind: "workspace", workspaceId });
  // repo-wr is the project without git.
  const isGit = (id: string) => id !== "repo-wr";
  // The fields movedDraft does not name must come through unchanged.
  const carried = {
    text: "Add a dark mode toggle",
    attachments: ["a1"],
    model: "haiku",
    effort: "medium",
    permission: "supervised",
    phase: "idle",
    notice: "x.bmp: not a PNG image",
  };
  const draft: MovableDraft & typeof carried = {
    ...carried,
    worktree: { kind: "existing", path: "/src/cf/wt" },
    base: "origin/release",
    alsoIn: [],
    primary: null,
    error: "the last send failed",
  };

  it.each<[string, Partial<MovableDraft>, ComposeTarget, ComposeTarget, Partial<MovableDraft>]>([
    ["project → project: the project default; base and error reset", {}, proj("repo-cf"), proj("repo-gp"), { worktree: null, base: null, error: null, alsoIn: [], primary: null }],
    ["project → workspace: workspace worktrees; base and error reset", {}, proj("repo-cf"), ws("w-1"), { worktree: { kind: "members" }, base: null, error: null }],
    ["workspace → project: the project default", { worktree: { kind: "members" } }, ws("w-1"), proj("repo-cf"), { worktree: null }],
    ["workspace (new-worktree mode) → workspace: workspace worktrees", { worktree: { kind: "new" } }, ws("w-1"), ws("w-2"), { worktree: { kind: "members" } }],
    ["Also in carried to another git project; the old project is not demoted to it", { alsoIn: ["repo-sk"] }, proj("repo-cf"), proj("repo-gp"), { alsoIn: ["repo-sk"] }],
    ["the new project leaves Also in (a swap)", { alsoIn: ["repo-gp", "repo-sk"] }, proj("repo-cf"), proj("repo-gp"), { alsoIn: ["repo-sk"] }],
    ["the old project never stays in Also in", { alsoIn: ["repo-cf", "repo-sk"] }, proj("repo-cf"), proj("repo-gp"), { alsoIn: ["repo-sk"] }],
    ["a workspace target: no Also in", { alsoIn: ["repo-gp"] }, proj("repo-cf"), ws("w-1"), { alsoIn: [] }],
    ["a project without git: no Also in", { alsoIn: ["repo-gp"] }, proj("repo-cf"), proj("repo-wr"), { alsoIn: [] }],
    ["primary kept while it is still an Also in project", { alsoIn: ["repo-sk", "repo-dot"], primary: "repo-sk" }, proj("repo-cf"), proj("repo-gp"), { alsoIn: ["repo-sk", "repo-dot"], primary: "repo-sk" }],
    ["primary on the swapped-in project: null (it is the project now)", { alsoIn: ["repo-gp"], primary: "repo-gp" }, proj("repo-cf"), proj("repo-gp"), { alsoIn: [], primary: null }],
    ["primary on the old project: null", { alsoIn: ["repo-sk"], primary: "repo-cf" }, proj("repo-cf"), proj("repo-gp"), { alsoIn: ["repo-sk"], primary: null }],
    ["primary dropped with Also in for a workspace target", { alsoIn: ["repo-sk"], primary: "repo-sk" }, proj("repo-cf"), ws("w-1"), { alsoIn: [], primary: null }],
    ["a workspace member as primary does not survive a move", { primary: "repo-gp" }, ws("w-1"), ws("w-2"), { primary: null }],
    ["primary dropped for a project without git", { alsoIn: ["repo-sk"], primary: "repo-sk" }, proj("repo-cf"), proj("repo-wr"), { alsoIn: [], primary: null }],
    ["project → no project: no Also in, primary or base", { alsoIn: ["repo-sk"], primary: "repo-sk" }, proj("repo-cf"), { kind: "home" }, { alsoIn: [], primary: null, base: null, worktree: null, error: null }],
    ["workspace → no project", { worktree: { kind: "members" } }, ws("w-1"), { kind: "home" }, { alsoIn: [], worktree: null }],
    ["no project → project: the project default", { worktree: { kind: "new" }, base: null }, { kind: "home" }, proj("repo-cf"), { worktree: null, alsoIn: [] }],
    ["no project → workspace: workspace worktrees", { worktree: { kind: "new" } }, { kind: "home" }, ws("w-1"), { worktree: { kind: "members" } }],
  ])("%s", (_, over, from, to, want) => {
    const got = movedDraft({ ...draft, ...over }, from, to, isGit);
    expect(got).toMatchObject({ ...carried, ...want });
  });

  const sk = (projectId: string) => tagToken({ tagKind: "skill", name: "deploy", projectId });
  const fl = (projectId: string) => tagToken({ tagKind: "file", projectId, path: "src/a.ts" });
  const img = tagToken({ tagKind: "image", id: "a1", name: "x.png" });
  it.each<[string, Partial<MovableDraft>, ComposeTarget, ComposeTarget, string[], string]>([
    ["the old project's tags go; images and user skills stay", { text: `Use ${sk("repo-cf")} on ${fl("repo-cf")} with ${img} ${sk("")}` }, proj("repo-cf"), proj("repo-gp"), [], `Use on with ${img} ${sk("")}`],
    ["the new project's tags stay", { text: `${sk("repo-gp")} and ${sk("repo-cf")} now` }, proj("repo-cf"), proj("repo-gp"), [], `${sk("repo-gp")} and now`],
    ["a carried Also in project's tags stay", { alsoIn: ["repo-sk"], text: `${sk("repo-sk")} ${fl("repo-cf")}` }, proj("repo-cf"), proj("repo-gp"), [], sk("repo-sk")],
    ["Also in tags go with Also in (a workspace target)", { alsoIn: ["repo-sk"], text: `${sk("repo-sk")} then ${sk("repo-gp")}` }, proj("repo-cf"), ws("w-1"), ["repo-gp"], `then ${sk("repo-gp")}`],
    ["Also in tags go for a project without git", { alsoIn: ["repo-sk"], text: `x ${fl("repo-sk")}` }, proj("repo-cf"), proj("repo-wr"), [], "x"],
    ["workspace → workspace keeps the shared members' tags", { text: `${sk("repo-gp")} ${sk("repo-dot")}` }, ws("w-1"), ws("w-2"), ["repo-gp", "repo-sk"], sk("repo-gp")],
    ["workspace → project keeps that project's tags", { text: `${sk("repo-gp")} ${sk("repo-dot")}` }, ws("w-1"), proj("repo-dot"), [], sk("repo-dot")],
    ["no tags: text unchanged", { text: "  plain text  " }, proj("repo-cf"), proj("repo-gp"), [], "  plain text  "],
    ["to no project: every project tag goes; images and user skills stay", { alsoIn: ["repo-sk"], text: `${sk("repo-cf")} ${fl("repo-sk")} ${img} ${sk("")}` }, proj("repo-cf"), { kind: "home" }, [], `${img} ${sk("")}`],
  ])("tags: %s", (_, over, from, to, wsMembers, want) => {
    expect(movedDraft({ ...draft, ...over }, from, to, isGit, wsMembers).text).toBe(want);
  });

  it("does not modify the draft it moves", () => {
    const d = { ...draft, alsoIn: ["repo-gp"] };
    movedDraft(d, proj("repo-cf"), proj("repo-gp"), isGit);
    expect(d).toMatchObject({ alsoIn: ["repo-gp"], base: "origin/release", error: "the last send failed" });
  });
});
