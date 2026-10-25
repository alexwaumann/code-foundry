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
  setWorkIn,
  defaultWorktree,
  workInText,
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
  it.each<[string, (ReturnType<typeof file> & { pages?: number | null })[], { count: number; inlineBytes: number }, string[], string[]]>([
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
    // A path the daemon staged names its count: a short PDF counts toward the cap at once.
    ["holds a counted short PDF to the inline cap", [{ ...file("spec.pdf", PDF, 19 * MB), pages: 3 }], { count: 0, inlineBytes: 20 * MB }, [], [`${CAP}; spec.pdf not attached`]],
    ["counts a counted short PDF toward the cap", [{ ...file("a.pdf", PDF, 15 * MB), pages: 10 }, { ...file("b.png", "image/png", 9 * MB + 1) }], { count: 0, inlineBytes: 0 }, ["a.pdf"], [`${CAP}; b.png not attached`]],
    ["does not hold a counted long PDF to the inline cap", [{ ...file("book.pdf", PDF, 19 * MB), pages: 11 }], { count: 0, inlineBytes: 20 * MB }, ["book.pdf"], []],
    ["does not hold an uncounted PDF to the inline cap", [{ ...file("x.pdf", PDF, 19 * MB), pages: null }], { count: 0, inlineBytes: 20 * MB }, ["x.pdf"], []],
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

describe("project sets", () => {
  const projects = new Set(["web", "api", "lib"]);
  const env: PlaceEnv = {
    isGitProject: (id) => projects.has(id),
    hasWorktree: (projectId, path) => projectId === "web" && (path === "/src/web-fix" || path === "/src/web"),
    mainPath: (id) => (id === "web" ? "/src/web" : undefined),
    defaultRef: "origin/main",
  };
  const one = { projectIds: ["web"], workspaceId: "", primary: "web", isSet: false };
  const two = { projectIds: ["api", "web"], workspaceId: "", primary: "web", isSet: true };
  const project: PlaceInput = { target: { kind: "project", projectId: "web" }, worktree: { kind: "new" }, base: null, set: one };

  it("draft keys keep projects as project ids and prefix workspaces and like drafts", () => {
    expect(draftKey({ kind: "project", projectId: "web" })).toBe("web");
    expect(draftKey({ kind: "workspace", workspaceId: "w-1" })).toBe("ws:w-1");
    expect(draftKey({ kind: "like", threadId: "s-1" })).toBe("like:s-1");
    expect(isWorkspaceKey("ws:w-1")).toBe(true);
    expect(isWorkspaceKey("web")).toBe(false);
    expect(draftKey({ kind: "home" })).toBe(HOME_KEY);
    expect(isWorkspaceKey(HOME_KEY)).toBe(false);
  });

  it.each<[string, PlaceInput, Partial<PlaceEnv>, ThreadPlace | null]>([
    ["a project, new worktree, default base", project, {}, { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    ["a project, existing worktree", { ...project, worktree: { kind: "existing", path: "/src/web-fix" } }, {}, { kind: "project", projectId: "web", worktree: { kind: "existing", path: "/src/web-fix" }, base: "origin/main" }],
    ["a project in place: its main checkout", { ...project, worktree: { kind: "current" } }, {}, { kind: "project", projectId: "web", worktree: { kind: "existing", path: "/src/web" }, base: "origin/main" }],
    ["a project whose chosen worktree is gone: a new one", { ...project, worktree: { kind: "existing", path: "/gone" } }, {}, { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" }],
    [
      "a set in place: every project's own checkout, no base",
      { ...project, worktree: { kind: "current" }, base: "origin/dev", set: two },
      {},
      { kind: "set", projectIds: ["api", "web"], primary: "web", workspaceId: "", newWorktree: false, base: "" },
    ],
    [
      "a set with fresh copies and a picked base for the primary",
      { ...project, base: "origin/dev", set: { ...two, primary: "api" } },
      {},
      { kind: "set", projectIds: ["api", "web"], primary: "api", workspaceId: "", newWorktree: true, base: "origin/dev" },
    ],
    [
      "a workspace with one project is a set, its folder the primary: no base",
      { ...project, target: { kind: "workspace", workspaceId: "w-1" }, base: "origin/dev", set: { projectIds: ["web"], workspaceId: "w-1", primary: "workspace", isSet: true } },
      {},
      { kind: "set", projectIds: ["web"], primary: "workspace", workspaceId: "w-1", newWorktree: true, base: "" },
    ],
    ["nothing left to start in", { ...project, set: { projectIds: [], workspaceId: "", primary: "", isSet: false } }, {}, null],
    [
      "a project without git: its current checkout, whatever the draft says",
      { ...project, target: { kind: "project", projectId: "notes" }, base: "origin/dev", set: { ...one, projectIds: ["notes"], primary: "notes" } },
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", projectId: "notes", worktree: { kind: "existing", path: "/src/notes" }, base: "" },
    ],
    [
      "a git project is unaffected by noGitCheckout",
      project,
      { noGitCheckout: (id) => (id === "notes" ? "/src/notes" : undefined) },
      { kind: "project", projectId: "web", worktree: { kind: "new" }, base: "origin/main" },
    ],
    ["a like draft keeps the thread's primary", { ...project, target: { kind: "like", threadId: "s-1" } }, {}, { kind: "like", threadId: "s-1", primary: "" }],
    ["a like draft with another primary", { ...project, target: { kind: "like", threadId: "s-1" }, likePrimary: "api" }, {}, { kind: "like", threadId: "s-1", primary: "api" }],
  ])("threadPlace: %s", (_name, d, over, want) => {
    expect(threadPlace(d, { ...env, ...over })).toEqual(want);
  });

  const prompt = { text: " Fix login ", model: "haiku", effort: "medium", permission: "auto" };
  it.each<[string, ThreadPlace, Record<string, string>]>([
    [
      "a set in place",
      { kind: "set", projectIds: ["api", "web"], primary: "web", workspaceId: "", newWorktree: false, base: "" },
      { project: "web", projects: "api,web", "new-worktree": "false", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a set with fresh copies, the primary's own base",
      { kind: "set", projectIds: ["api", "web"], primary: "api", workspaceId: "", newWorktree: true, base: "origin/dev" },
      { project: "api", projects: "api:origin/dev,web", "new-worktree": "true", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    [
      "a workspace's set in its folder",
      { kind: "set", projectIds: ["api", "web"], primary: "workspace", workspaceId: "w-1", newWorktree: true, base: "" },
      { project: "workspace", projects: "api,web", workspace: "w-1", "new-worktree": "true", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" },
    ],
    ["like, the thread's own primary", { kind: "like", threadId: "s-1", primary: "" }, { id: "s-1", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" }],
    ["like, another primary", { kind: "like", threadId: "s-1", primary: "api" }, { id: "s-1", project: "api", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" }],
  ])("threadArgs: %s", (_name, place, want) => {
    expect(threadArgs(place, prompt, [])).toEqual(want);
  });

  it("threadArgs passes the composer's text with a prompt only", () => {
    const place: ThreadPlace = { kind: "set", projectIds: ["api", "web"], primary: "api", workspaceId: "", newWorktree: false, base: "" };
    expect(threadArgs(place, { ...prompt, text: "/tdd go", composerText: " [/tdd](cf-skill://~/tdd) go " }, [])).toMatchObject({ prompt: "/tdd go", "composer-prompt": "[/tdd](cf-skill://~/tdd) go" });
    expect(threadArgs(place, { ...prompt, text: " ", composerText: "x" }, [])).not.toHaveProperty("composer-prompt");
    expect(threadArgs(place, { ...prompt, text: "no tags", composerText: "no tags" }, [])).not.toHaveProperty("composer-prompt");
  });

  it("no project: the thread starts at home, whatever the draft says; thread.new gets no-project alone", () => {
    const d: PlaceInput = { target: { kind: "home" }, worktree: { kind: "existing", path: "/src/web-fix" }, base: "origin/dev", set: two };
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

  it.each<[string, WorktreeChoice | null, string | undefined, "new" | "current"]>([
    ["no pick, no setting: in place", null, undefined, "current"],
    ["no pick, setting new", null, "new", "new"],
    ["no pick, setting current", null, "current", "current"],
    ["a pick of fresh copies wins over the setting", { kind: "new" }, "current", "new"],
    ["an existing worktree picked for a lone project counts as in place", { kind: "existing", path: "/src/web-fix" }, "new", "current"],
  ])("setWorkIn: %s", (_name, choice, setting, want) => {
    expect(setWorkIn(choice, setting)).toBe(want);
  });

  it("setWorkIn: a set without a git project runs in place, whatever the pick or the setting", () => {
    expect(setWorkIn({ kind: "new" }, "new", false)).toBe("current");
    expect(setWorkIn(null, "new", false)).toBe("current");
    expect(setWorkIn({ kind: "new" }, "current", true)).toBe("new");
  });

  it("threadArgs: a workspace without projects sends no projects list (never an empty one)", () => {
    const place: ThreadPlace = { kind: "set", projectIds: [], primary: "workspace", workspaceId: "w-0", newWorktree: false, base: "" };
    expect(threadArgs(place, prompt, [])).toEqual({ project: "workspace", workspace: "w-0", "new-worktree": "false", model: "haiku", effort: "medium", permission: "auto", prompt: "Fix login" });
  });
});

describe("Work in", () => {
  it.each<[string, { setting?: string; mainPath?: string }, WorktreeChoice]>([
    ["nothing set: the main checkout", { mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
    ["nothing set, main checkout unknown: a fresh copy", {}, { kind: "new" }],
    ["setting new", { setting: "new", mainPath: "/src/cf" }, { kind: "new" }],
    ["setting current: the main checkout", { setting: "current", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
    ["setting current, main checkout unknown: a fresh copy", { setting: "current" }, { kind: "new" }],
    ["an unknown setting value: the main checkout", { setting: "", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
    ["a garbled setting value: the main checkout", { setting: "elsewhere", mainPath: "/src/cf" }, { kind: "existing", path: "/src/cf" }],
  ])("defaultWorktree: %s", (_, input, want) => {
    expect(defaultWorktree(input)).toEqual(want);
  });

  const main = { isMain: true, branch: "main", head: "3c3c4651234" };
  const feat = { isMain: false, branch: "feat/sidebar", head: "abcdef01234" };
  it.each<[string, Parameters<typeof workInText>[0], string]>([
    ["a new worktree", { set: false, noGit: false, worktree: { kind: "new" } }, "Fresh copy"],
    ["the main checkout", { set: false, noGit: false, worktree: { kind: "existing", path: "/src/cf" }, chosen: main }, "In place"],
    ["the main checkout, detached", { set: false, noGit: false, worktree: { kind: "existing", path: "/src/cf" }, chosen: { ...main, branch: "" } }, "In place"],
    ["another worktree: its branch", { set: false, noGit: false, worktree: { kind: "existing", path: "/wt/x" }, chosen: feat }, "feat/sidebar"],
    ["another worktree, detached: its short head", { set: false, noGit: false, worktree: { kind: "existing", path: "/wt/x" }, chosen: { ...feat, branch: "" } }, "abcdef0"],
    ["an existing worktree not listed: a fresh copy", { set: false, noGit: false, worktree: { kind: "existing", path: "/gone" } }, "Fresh copy"],
    ["a project without git", { set: false, noGit: true, worktree: { kind: "existing", path: "/docs" } }, "In place"],
    ["a set in place", { set: true, noGit: false, worktree: { kind: "current" } }, "In place"],
    ["a set with fresh copies", { set: true, noGit: false, worktree: { kind: "new" } }, "Fresh copies"],
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
    projects: ["repo-cf", "repo-gp"],
    workspace: "w-1",
    primary: "repo-gp",
    error: "the last send failed",
  };

  it("resets where the thread runs to the new target's, keeps the rest", () => {
    expect(movedDraft(draft, ["repo-sk"])).toMatchObject({ ...carried, worktree: null, base: null, projects: null, workspace: null, primary: null, error: null });
  });

  const sk = (projectId: string) => tagToken({ tagKind: "skill", name: "deploy", projectId });
  const fl = (projectId: string) => tagToken({ tagKind: "file", projectId, path: "src/a.ts" });
  const img = tagToken({ tagKind: "image", id: "a1", name: "x.png" });
  it.each<[string, string, string[], string]>([
    ["tags of projects the target lacks go; images and user skills stay", `Use ${sk("repo-cf")} on ${fl("repo-cf")} with ${img} ${sk("")}`, ["repo-gp"], `Use on with ${img} ${sk("")}`],
    ["the target's projects keep theirs", `${sk("repo-gp")} and ${sk("repo-cf")} now`, ["repo-gp"], `${sk("repo-gp")} and now`],
    ["no tags: text unchanged", "  plain text  ", [], "  plain text  "],
    ["to no project: every project tag goes", `${sk("repo-cf")} ${fl("repo-sk")} ${img} ${sk("")}`, [], `${img} ${sk("")}`],
  ])("tags: %s", (_, text, members, want) => {
    expect(movedDraft({ ...draft, text }, members).text).toBe(want);
  });

  it("does not modify the draft it moves", () => {
    const d = { ...draft };
    movedDraft(d, []);
    expect(d).toMatchObject({ projects: ["repo-cf", "repo-gp"], base: "origin/release", error: "the last send failed" });
  });
});
