// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesDroppedView } from "@/api/app";
import type { ProjectView } from "@/api/project";
import { getDraft, updateDraft, useComposeStore } from "@/stores/compose";
import { useProjectsStore } from "@/stores/projects";
import { useWorkspacesStore } from "@/stores/workspaces";
import { Composer } from "./Composer";

// No daemon: refs and skills never load (the composer shows them loading).
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), listRefs: () => new Promise(() => undefined) }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), listSkills: () => new Promise(() => undefined) }));

// A Wails host: the drop subscriptions are kept here and fired by drop().
const host = vi.hoisted(() => ({
  handlers: new Set<(d: FilesDroppedView) => void>(),
  pickFiles: vi.fn<(startDir: string) => Promise<string[] | null>>(),
}));
vi.mock("@/api/app", async (orig) => ({
  ...(await orig<typeof import("@/api/app")>()),
  appInfo: () => Promise.resolve({ version: "test" }),
  onFilesDropped: (fn: (d: FilesDroppedView) => void) => {
    host.handlers.add(fn);
    return () => host.handlers.delete(fn);
  },
  pickFiles: host.pickFiles,
}));

// The daemon stages any .png or .pdf path; the staged file reads back as that type.
const staged = vi.hoisted(() => [] as string[]);
vi.mock("@/api/threads", async (orig) => ({
  ...(await orig<typeof import("@/api/threads")>()),
  stageAttachmentPath: (path: string) => {
    staged.push(path);
    return Promise.resolve(`/h/att/${String(staged.length)}${path.endsWith(".pdf") ? "-1p.pdf" : ".png"}`);
  },
}));
vi.mock("@/stores/attachments", async (orig) => ({
  ...(await orig<typeof import("@/stores/attachments")>()),
  readAttachmentFile: (path: string) => Promise.resolve(new Blob(["x"], { type: path.endsWith(".pdf") ? "application/pdf" : "image/png" })),
}));
vi.mock("@/lib/pdf", () => ({ pdfSummary: () => new Promise(() => undefined) }));

const project = (id: string): ProjectView => ({
  id,
  path: `/src/${id}`,
  name: id,
  defaultBranch: "main",
  githubSlug: "",
  remotes: [],
  git: true,
  worktrees: [{ projectId: id, path: `/src/${id}`, branch: "main", head: "abc", detached: false, isMain: true, status: { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null } }],
});

function drop(paths: string[], target: string) {
  act(() => {
    for (const h of host.handlers) h({ paths, target });
  });
}

function dropId(el: HTMLElement): string {
  return el.getAttribute("data-drop-id") ?? "";
}

// jsdom has no layout: ProseMirror's scrollIntoView asks for rects.
const noRects = () => [] as unknown as DOMRectList;

beforeEach(() => {
  Range.prototype.getClientRects = noRects;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  Element.prototype.getClientRects = noRects;
  URL.createObjectURL = vi.fn(() => "blob:draft");
  URL.revokeObjectURL = vi.fn();
  useProjectsStore.setState({ byId: { web: project("web"), api: project("api") }, order: ["web", "api"], loaded: true });
  useWorkspacesStore.setState({ byId: {}, order: [], loaded: true });
});

afterEach(() => {
  cleanup();
  host.handlers.clear();
  host.pickFiles.mockReset();
  staged.length = 0;
  useComposeStore.setState({ drafts: {}, refs: {}, preview: null });
});

describe("native drops on the composer", () => {
  it("the card is a drop target with an id; images are attached, other paths go into the prompt", async () => {
    render(<Composer projectId="web" />);
    const card = screen.getByTestId("composer-card");
    expect(card.hasAttribute("data-file-drop-target")).toBe(true);
    expect(dropId(card)).not.toBe("");
    drop(["/src/web/notes.txt", "/Users/me/shot one.png", "/Users/me/my dir"], dropId(card));
    await waitFor(() => {
      expect(getDraft("web").attachments).toHaveLength(1);
    });
    expect(staged).toEqual(["/Users/me/shot one.png"]);
    const a = getDraft("web").attachments[0];
    expect(a?.file.name).toBe("shot one.png");
    expect(a?.stagedPath).toBe("/h/att/1.png");
    await waitFor(() => {
      expect(getDraft("web").text).toBe(`/src/web/notes.txt "/Users/me/my dir" ![shot one.png](cf-attachment://${a?.id ?? ""}) `);
    });
  });

  it("only the composer whose id the drop names takes it", async () => {
    render(
      <>
        <Composer projectId="web" />
        <Composer projectId="api" />
      </>,
    );
    const [web, api] = screen.getAllByTestId("composer-card");
    expect(dropId(web ?? document.body)).not.toBe(dropId(api ?? document.body));
    drop(["/a/readme.md"], dropId(api ?? document.body));
    await waitFor(() => {
      expect(getDraft("api").text).toBe("/a/readme.md");
    });
    expect(getDraft("web").text).toBe("");
    drop(["/a/other.md"], "someone-else");
    drop(["/a/none.md"], "");
    expect(getDraft("web").text).toBe("");
    expect(getDraft("api").text).toBe("/a/readme.md");
  });

  it("a sending draft is no drop target and ignores a drop", () => {
    render(<Composer projectId="web" />);
    const card = screen.getByTestId("composer-card");
    const id = dropId(card);
    act(() => {
      updateDraft("web", { phase: "starting", text: "hi" });
    });
    expect(card.hasAttribute("data-file-drop-target")).toBe(false);
    drop(["/a/x.png", "/a/y.txt"], id);
    expect(staged).toEqual([]);
    expect(getDraft("web").text).toBe("hi");
  });
});

describe("the attach button in the host", () => {
  it("opens the native panel in the checkout and routes the picks the same way", async () => {
    host.pickFiles.mockResolvedValue(["/src/web/spec.pdf", "/src/web/main.go"]);
    render(<Composer projectId="web" />);
    const button = screen.getByTestId("composer-attach");
    await waitFor(() => {
      expect(button.getAttribute("aria-label")).toBe("Attach files");
    });
    fireEvent.click(button);
    expect(host.pickFiles).toHaveBeenCalledWith("/src/web");
    await waitFor(() => {
      expect(getDraft("web").attachments.map((a) => [a.file.name, a.kind, a.pages])).toEqual([["spec.pdf", "pdf", 1]]);
    });
    expect(getDraft("web").text).toContain("/src/web/main.go");
  });

  it("a cancel changes nothing", async () => {
    host.pickFiles.mockResolvedValue([]);
    render(<Composer projectId="web" />);
    const button = screen.getByTestId("composer-attach");
    await waitFor(() => {
      expect(button.getAttribute("aria-label")).toBe("Attach files");
    });
    fireEvent.click(button);
    await waitFor(() => {
      expect(host.pickFiles).toHaveBeenCalled();
    });
    expect(getDraft("web").text).toBe("");
    expect(getDraft("web").attachments).toEqual([]);
  });
});
