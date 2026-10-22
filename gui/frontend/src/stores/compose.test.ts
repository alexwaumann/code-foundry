import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView } from "@/api/project";
import { HOME_KEY } from "@/lib/compose";
import { tagToken } from "@/lib/prompt";
import { pdfSummary } from "@/lib/pdf";
import {
  addAlsoIn,
  addAttachments,
  clearDraft,
  composeNoProject,
  composeSelection,
  composeTarget,
  draftPlace,
  emptyDraft,
  emptyWorkspaceDraft,
  getDraft,
  projectWorktree,
  removeAlsoIn,
  setPrimary,
  settlePdf,
  switchDraftTarget,
  updateDraft,
  useComposeStore,
  type DraftAttachment,
} from "./compose";
import { answerConfirm, useConfirmStore } from "./confirm";
import { useProjectsStore } from "./projects";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

// pdf.js does not run in jsdom: each test says what a PDF turns out to be.
vi.mock("@/lib/pdf", () => ({ pdfSummary: vi.fn(() => new Promise(() => undefined)) }));

afterEach(() => {
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
  useConfirmStore.setState({ pending: null });
});

describe("compose drafts", () => {
  it("a project draft starts with the project's default (null), a workspace draft in its worktrees", () => {
    expect(emptyDraft.worktree).toBeNull();
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
    const sk = (projectId: string) => tagToken({ tagKind: "skill", name: "deploy", projectId });
    const file = tagToken({ tagKind: "file", projectId: "repo-gp", path: "src/a.ts" });
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
  it("its selection has no project and maps to the home target and back", () => {
    composeNoProject();
    const sel = useUiStore.getState().selection;
    expect(sel).toEqual({ kind: "compose", projectId: "", noProject: true });
    if (sel.kind !== "compose") throw new Error("not a composer");
    expect(composeTarget(sel)).toEqual({ kind: "home" });
    expect(composeSelection({ kind: "home" }, { kind: "home" })).toEqual(sel);
    expect(composeTarget({ kind: "compose", projectId: "repo-cf" })).toEqual({ kind: "project", projectId: "repo-cf" });
  });
});

describe("Work in: the setting, the per-project memory, the draft's own pick", () => {
  const wt = (path: string, isMain: boolean) => ({ path, branch: isMain ? "main" : "feat/x", head: "abc1234", detached: false, isMain, status: undefined });
  const project = (id: string): ProjectView =>
    ({ id, path: `/src/${id}`, name: id, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [wt(`/src/${id}`, true), wt(`/wt/${id}-x`, false)] }) as unknown as ProjectView;
  const setting = (v: string | undefined) => {
    useSettingsStore.setState({
      snapshot: { values: v === undefined ? {} : { "threads.default_worktree": v }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] },
    });
  };
  const place = (id: string) => {
    const p = draftPlace({ kind: "project", projectId: id }, getDraft(id));
    return p?.kind === "project" ? p.worktree : p;
  };

  beforeEach(() => {
    useProjectsStore.setState({ byId: { "repo-cf": project("repo-cf"), "repo-gp": project("repo-gp") }, order: ["repo-cf", "repo-gp"] });
  });
  afterEach(() => {
    useSettingsStore.setState({ snapshot: null });
  });

  it.each<[string, string | undefined, { kind: string; path?: string }]>([
    ["no settings yet: the main checkout", undefined, { kind: "existing", path: "/src/repo-cf" }],
    ["setting new", "new", { kind: "new" }],
    ["setting current: the main checkout", "current", { kind: "existing", path: "/src/repo-cf" }],
    ["an unknown setting value: the main checkout", "elsewhere", { kind: "existing", path: "/src/repo-cf" }],
  ])("%s", (_, value, want) => {
    setting(value);
    expect(projectWorktree("repo-cf")).toEqual(want);
    expect(place("repo-cf")).toEqual(want);
  });

  it("current with an unknown main checkout falls back to a fresh copy", () => {
    setting("current");
    expect(projectWorktree("repo-unknown")).toEqual({ kind: "new" });
    setting(undefined);
    expect(projectWorktree("repo-unknown")).toEqual({ kind: "new" });
  });

  it("a pick applies to its draft only: the next draft starts from the setting again", () => {
    setting("new");
    updateDraft("repo-cf", { worktree: { kind: "existing", path: "/src/repo-cf" } });
    expect(place("repo-cf")).toEqual({ kind: "existing", path: "/src/repo-cf" });
    expect(projectWorktree("repo-cf")).toEqual({ kind: "new" });
    expect(place("repo-gp")).toEqual({ kind: "new" });
    clearDraft("repo-cf");
    expect(getDraft("repo-cf").worktree).toBeNull();
    expect(place("repo-cf")).toEqual({ kind: "new" });
  });

  it("the draft's own choice wins over the default; a vanished worktree still falls back to a fresh copy", () => {
    setting("current");
    updateDraft("repo-cf", { worktree: { kind: "new" } });
    expect(place("repo-cf")).toEqual({ kind: "new" });
    updateDraft("repo-cf", { worktree: { kind: "existing", path: "/gone" } });
    expect(place("repo-cf")).toEqual({ kind: "new" });
  });

  it("workspace drafts ignore the setting and the memory", () => {
    setting("current");
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login", branch: "cf/login", members: [{ projectId: "repo-gp", worktreePath: "/wt/gp" }], createdAtMs: null } }, order: ["w-1"], loaded: true });
    expect(getDraft("ws:w-1").worktree).toEqual({ kind: "members" });
    expect(draftPlace({ kind: "workspace", workspaceId: "w-1" }, getDraft("ws:w-1"))).toMatchObject({ kind: "workspace", worktreePath: "/wt/gp" });
  });
});

describe("switchDraftTarget", () => {
  const project = (id: string, git = true): ProjectView => ({ id, path: `/src/${id}`, name: id.replace("repo-", ""), defaultBranch: "main", githubSlug: "", remotes: [], git, worktrees: [] });
  const cf = { kind: "project", projectId: "repo-cf" } as const;
  const gp = { kind: "project", projectId: "repo-gp" } as const;
  const login = { kind: "workspace", workspaceId: "w-1" } as const;
  const image = (id: string): DraftAttachment => ({ id, file: new File(["x"], `${id}.png`, { type: "image/png" }), kind: "image", url: `blob:${id}`, stagedPath: null, pages: null, thumb: null });
  const revoke = vi.fn();

  beforeEach(() => {
    revoke.mockClear();
    URL.revokeObjectURL = revoke;
    useProjectsStore.setState({ byId: { "repo-cf": project("repo-cf"), "repo-gp": project("repo-gp"), "repo-sk": project("repo-sk") }, order: ["repo-cf", "repo-gp", "repo-sk"] });
    useWorkspacesStore.setState({ byId: { "w-1": { id: "w-1", name: "login", branch: "cf/login", members: [{ projectId: "repo-gp", worktreePath: "/wt/gp" }], createdAtMs: null } }, order: ["w-1"], loaded: true });
    useUiStore.setState({ selection: { kind: "compose", projectId: "repo-cf" } });
  });

  it("moves the draft (images kept, not revoked), deletes the old key, shows the new composer focused", async () => {
    updateDraft("repo-cf", { text: "hi", attachments: [image("a1")], model: "haiku", alsoIn: ["repo-gp", "repo-sk"], base: "origin/dev" });
    const seq = useUiStore.getState().composerFocusSeq;
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(true);
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
    expect(getDraft("repo-gp")).toMatchObject({ text: "hi", model: "haiku", alsoIn: ["repo-sk"], base: null, worktree: null });
    expect(getDraft("repo-gp").attachments.map((a) => a.url)).toEqual(["blob:a1"]);
    expect(revoke).not.toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-gp" });
    expect(useUiStore.getState().composerFocusSeq).toBe(seq + 1);
  });

  it("to a workspace: selects it with its first member for the context", async () => {
    updateDraft("repo-cf", { text: "hi", alsoIn: ["repo-sk"] });
    await switchDraftTarget(cf, login);
    expect(getDraft("ws:w-1")).toMatchObject({ text: "hi", alsoIn: [], worktree: { kind: "members" } });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-gp", workspaceId: "w-1" });
  });

  it("the same target, or a busy draft: nothing happens", async () => {
    updateDraft("repo-cf", { text: "hi" });
    await expect(switchDraftTarget(cf, cf)).resolves.toBe(false);
    updateDraft("repo-cf", { phase: "starting" });
    await expect(switchDraftTarget(cf, gp)).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe("hi");
    expect(useComposeStore.getState().drafts["repo-gp"]).toBeUndefined();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-cf" });
  });

  it("a non-empty draft at the target: replaced only after the confirm", async () => {
    updateDraft("repo-cf", { text: "new idea" });
    updateDraft("repo-gp", { text: "older idea", attachments: [image("a2")] });
    const cancelled = switchDraftTarget(cf, gp);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Replace the draft in gp?", message: "It has unsent text or attachments.", confirmLabel: "Replace" });
    answerConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe("new idea");
    expect(getDraft("repo-gp").text).toBe("older idea");
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-cf" });

    const replaced = switchDraftTarget(cf, gp);
    answerConfirm(true);
    await expect(replaced).resolves.toBe(true);
    expect(getDraft("repo-gp")).toMatchObject({ text: "new idea", attachments: [] });
    expect(revoke).toHaveBeenCalledWith("blob:a2");
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
  });

  it("tags of projects that leave the draft: removed only after the confirm", async () => {
    const sk = (projectId: string) => tagToken({ tagKind: "skill", name: "deploy", projectId });
    const text = `${sk("repo-cf")} and ${sk("repo-cf")} with ${sk("repo-gp")} ${sk("")}`;
    updateDraft("repo-cf", { text });
    const cancelled = switchDraftTarget(cf, gp);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Switch to gp?", message: "2 references to cf in your text will be removed.", confirmLabel: "Switch" });
    answerConfirm(false);
    await expect(cancelled).resolves.toBe(false);
    expect(getDraft("repo-cf").text).toBe(text);
    expect(useComposeStore.getState().drafts["repo-gp"]).toBeUndefined();
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-cf" });

    const switched = switchDraftTarget(cf, gp);
    answerConfirm(true);
    await expect(switched).resolves.toBe(true);
    expect(getDraft("repo-gp").text).toBe(`and with ${sk("repo-gp")} ${sk("")}`);
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-gp" });
  });

  it("to a workspace: Also in tags go too; its members' tags stay", async () => {
    const sk = (projectId: string) => tagToken({ tagKind: "skill", name: "deploy", projectId });
    updateDraft("repo-cf", { text: `${sk("repo-sk")} ${sk("repo-cf")} ${sk("repo-gp")}`, alsoIn: ["repo-sk", "repo-gp"] });
    const p = switchDraftTarget(cf, login);
    expect(useConfirmStore.getState().pending).toMatchObject({ title: "Switch to login?", message: "2 references to sk and cf in your text will be removed." });
    answerConfirm(true);
    await expect(p).resolves.toBe(true);
    expect(getDraft("ws:w-1").text).toBe(sk("repo-gp"));
  });

  it("to no project: the home draft, selected without a project; and back to a project", async () => {
    updateDraft("repo-cf", { text: "hi", alsoIn: ["repo-gp"], model: "haiku" });
    await expect(switchDraftTarget(cf, { kind: "home" })).resolves.toBe(true);
    expect(useComposeStore.getState().drafts["repo-cf"]).toBeUndefined();
    expect(getDraft(HOME_KEY)).toMatchObject({ text: "hi", alsoIn: [], model: "haiku" });
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "", noProject: true });
    await expect(switchDraftTarget({ kind: "home" }, gp)).resolves.toBe(true);
    expect(useComposeStore.getState().drafts[HOME_KEY]).toBeUndefined();
    expect(getDraft("repo-gp")).toMatchObject({ text: "hi", worktree: null });
  });

  it("to no project with project tags: removed only after the confirm, which names No project", async () => {
    const sk = tagToken({ tagKind: "skill", name: "deploy", projectId: "repo-cf" });
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
    const sk = tagToken({ tagKind: "skill", name: "deploy", projectId: "repo-sk" });
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
    expect(useUiStore.getState().selection).toEqual({ kind: "compose", projectId: "repo-gp" });
  });
});

describe("attachments: kinds, PDF pages and the inline cap", () => {
  const MB = 1024 * 1024;
  const KEY = "repo-cf";
  /** A File that says it has `size` bytes without holding them. */
  const sized = (name: string, type: string, size: number): File => {
    const f = new File(["x"], name, { type });
    Object.defineProperty(f, "size", { value: size });
    return f;
  };
  const summary = vi.mocked(pdfSummary);
  const CAP = "Attachments sent with one message must total under 24 MB";
  const revoke = vi.fn();

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    revoke.mockClear();
    URL.revokeObjectURL = revoke;
    summary.mockReset();
    summary.mockReturnValue(new Promise(() => undefined));
  });

  it("adds images and PDFs by kind; a .pdf without a type is a PDF", () => {
    const added = addAttachments(KEY, [sized("a.png", "image/png", 10), sized("spec.pdf", "application/pdf", 10), sized("drag.PDF", "", 10)]);
    expect(added.map((a) => [a.kind, a.file.type, a.pages, a.thumb])).toEqual([
      ["image", "image/png", null, null],
      ["pdf", "application/pdf", null, null],
      ["pdf", "application/pdf", null, null],
    ]);
    expect(summary).toHaveBeenCalledTimes(2);
    expect(getDraft(KEY).notice).toBeNull();
  });

  it("stores a PDF's pages and thumbnail; over 10 pages adds the page-by-page notice", async () => {
    summary.mockResolvedValueOnce({ pages: 2, thumb: "data:image/png;base64,AA" }).mockResolvedValueOnce({ pages: 30, thumb: null });
    addAttachments(KEY, [sized("short.pdf", "application/pdf", 10), sized("book.pdf", "application/pdf", 10), sized("notes.txt", "text/plain", 1)]);
    await vi.waitFor(() => {
      expect(getDraft(KEY).attachments.map((a) => a.pages)).toEqual([2, 30]);
    });
    expect(getDraft(KEY).attachments[0]?.thumb).toBe("data:image/png;base64,AA");
    expect(getDraft(KEY).notice).toBe("notes.txt: not a PNG, JPEG, GIF, WebP or PDF file · book.pdf has 30 pages; Claude reads it page by page");
  });

  it("removes a short PDF, chip and all, that takes the message over the inline cap", () => {
    const [img] = addAttachments(KEY, [sized("big.png", "image/png", 9 * MB)]);
    const [a, b, long] = addAttachments(KEY, [sized("a.pdf", "application/pdf", 9 * MB), sized("b.pdf", "application/pdf", 9 * MB), sized("long.pdf", "application/pdf", 19 * MB)]);
    if (!img || !a || !b || !long) throw new Error("not added");
    updateDraft(KEY, { text: `see ![b.pdf](cf-attachment://${b.id}) now` });
    settlePdf(long.id, { pages: 40, thumb: null });
    settlePdf(a.id, { pages: 3, thumb: null });
    settlePdf(b.id, { pages: 3, thumb: null });
    const d = getDraft(KEY);
    // 9 (image) + 9 (a) = 18 MB inline; b would make it 27. long.pdf goes as a path.
    expect(d.attachments.map((x) => x.file.name)).toEqual(["big.png", "a.pdf", "long.pdf"]);
    expect(d.text).toBe("see now");
    expect(d.notice).toBe(`long.pdf has 40 pages; Claude reads it page by page · ${CAP}; b.pdf not attached`);
    expect(revoke).toHaveBeenCalledWith("blob:x");
  });

  it("holds images to the inline cap against counted short PDFs only", () => {
    const [pdf] = addAttachments(KEY, [sized("a.pdf", "application/pdf", 15 * MB)]);
    expect(addAttachments(KEY, [sized("b.png", "image/png", 10 * MB)])).toHaveLength(1);
    if (!pdf) throw new Error("not added");
    settlePdf(pdf.id, { pages: 2, thumb: null });
    // 15 + 10 already: a PDF counted after the image is the one that goes.
    expect(getDraft(KEY).attachments.map((x) => x.file.name)).toEqual(["b.png"]);
    expect(addAttachments(KEY, [sized("c.png", "image/png", 9 * MB)])).toHaveLength(1);
    expect(addAttachments(KEY, [sized("d.png", "image/png", 6 * MB)])).toHaveLength(0);
    expect(getDraft(KEY).notice).toBe(`${CAP}; d.png not attached`);
  });

  it("keeps a PDF over the inline cap that a failed send already staged", () => {
    const [img, pdf] = addAttachments(KEY, [sized("big.png", "image/png", 9 * MB), sized("a.pdf", "application/pdf", 18 * MB)]);
    if (!img || !pdf) throw new Error("not added");
    // The send staged both and failed; the count arrives with the draft idle again.
    updateDraft(KEY, { phase: "idle", attachments: getDraft(KEY).attachments.map((x) => ({ ...x, stagedPath: `/att/${x.file.name}` })) });
    settlePdf(pdf.id, { pages: 2, thumb: null });
    expect(getDraft(KEY).attachments.map((x) => [x.file.name, x.pages])).toEqual([
      ["big.png", null],
      ["a.pdf", 2],
    ]);
  });

  it("settles a PDF in the draft it moved to; ignores one that is gone", () => {
    const [pdf] = addAttachments(KEY, [sized("a.pdf", "application/pdf", 10)]);
    if (!pdf) throw new Error("not added");
    useComposeStore.setState((s) => {
      const { [KEY]: moved, ...rest } = s.drafts;
      return { drafts: moved ? { ...rest, "repo-gp": moved } : rest };
    });
    settlePdf(pdf.id, { pages: 4, thumb: null });
    expect(getDraft("repo-gp").attachments[0]?.pages).toBe(4);
    clearDraft("repo-gp");
    settlePdf(pdf.id, { pages: 5, thumb: null });
    expect(getDraft("repo-gp").attachments).toEqual([]);
  });
});
