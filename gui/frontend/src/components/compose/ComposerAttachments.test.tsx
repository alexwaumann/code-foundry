// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pdfSummary } from "@/lib/pdf";
import { tagToken } from "@/lib/prompt";
import { getDraft, updateDraft } from "@/stores/compose";
import { useConfirmStore } from "@/stores/confirm";
import { composerDaemon } from "@/test/composerFakes";
import { composeIn, seedComposer, send, settle } from "@/test/composerWorld";
import { SelectedComposer } from "@/test/SelectedComposer";
import { lastInvocation } from "@/test/daemonFakes";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/project", async (orig) => ({ ...(await orig<typeof import("@/api/project")>()), ...(await import("@/test/composerFakes")).projectFakes }));
vi.mock("@/api/filesystem", async (orig) => ({ ...(await orig<typeof import("@/api/filesystem")>()), ...(await import("@/test/composerFakes")).filesystemFakes }));
vi.mock("@/api/threads", async (orig) => ({ ...(await orig<typeof import("@/api/threads")>()), ...(await import("@/test/composerFakes")).stageFakes }));
// pdf.js does not run in jsdom: each test says what a PDF turns out to be.
vi.mock("@/lib/pdf", () => ({ pdfSummary: vi.fn(() => new Promise(() => undefined)), loadPdf: () => new Promise(() => undefined) }));

const THUMB = "data:image/png;base64,AAAA";

/** A 1x1 PNG's worth of bytes (the size shows as 1 KB). */
const png = (name: string) => new File([new Uint8Array(68)], name, { type: "image/png" });
const pdf = (name: string, bytes = 1000) => new File([new Uint8Array(bytes)], name, { type: "application/pdf" });

/** Picks files with the attach button's file input. */
async function pick(...files: File[]): Promise<void> {
  const input = screen.getByTestId("composer-file-input");
  act(() => {
    fireEvent.change(input, { target: { files } });
  });
  await settle();
}

const tiles = () => screen.queryAllByTestId("attachment");
const notice = () => screen.queryByTestId("composer-notice")?.textContent ?? null;

beforeEach(() => {
  seedComposer();
  vi.mocked(pdfSummary).mockImplementation(() => new Promise(() => undefined));
  composeIn("repo-cf");
});

afterEach(() => {
  cleanup();
});

describe("attachments (compose.spec.ts)", () => {
  it("picked, rejected, removed without a confirm while unreferenced, staged on send in the draft's order", async () => {
    render(<SelectedComposer />);
    await settle();
    await pick(png("shot.png"), new File(["hi"], "notes.txt", { type: "text/plain" }));
    expect(tiles()).toHaveLength(1);
    expect(tiles()[0]?.querySelector("img")?.getAttribute("src")).toBe("blob:draft");
    expect(notice()).toBe("notes.txt: not a PNG, JPEG, GIF, WebP or PDF file");

    await pick(png("other.png"));
    expect(tiles()).toHaveLength(2);
    expect(notice()).toBeNull();
    // Not referenced in the (empty) text: × removes it without asking.
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove other.png" }));
    });
    await settle();
    expect(useConfirmStore.getState().pending).toBeNull();
    expect(tiles()).toHaveLength(1);

    await pick(png("third.png"));
    act(() => {
      updateDraft("repo-cf", { text: "Match these screenshots" });
    });
    await send();
    expect(composerDaemon.staged.map((a) => [a.name, a.mimeType, a.size])).toEqual([
      ["shot.png", "image/png", 68],
      ["third.png", "image/png", 68],
    ]);
    expect(lastInvocation("thread.new")?.args.attachments).toBe(composerDaemon.staged.map((a) => a.path).join(","));
  });

  it("the preview: from the thumbnail, its name, size and image; Esc and × close it and focus returns; × on the tile opens none", async () => {
    render(<SelectedComposer />);
    await settle();
    await pick(png("shot.png"));
    const open = screen.getByTestId("attachment-open");
    expect(open.className).toContain("cursor-pointer");
    expect(screen.queryByTestId("attachment-preview")).toBeNull();

    act(() => {
      fireEvent.click(open);
    });
    const preview = await screen.findByTestId("attachment-preview");
    expect(within(preview).getByRole("heading").textContent).toBe("shot.png");
    expect(screen.getByTestId("attachment-preview-size").textContent).toBe("1 KB");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(tiles()[0]?.querySelector("img")?.getAttribute("src"));

    act(() => {
      fireEvent.keyDown(preview, { key: "Escape" });
    });
    await settle();
    expect(screen.queryByTestId("attachment-preview")).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(open);
    });
    // Esc closed the preview, not the composer.
    expect(screen.getByTestId("composer")).not.toBeNull();

    act(() => {
      fireEvent.click(open);
    });
    act(() => {
      fireEvent.click(screen.getByTestId("attachment-preview-close"));
    });
    await settle();
    expect(screen.queryByTestId("attachment-preview")).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(open);
    });

    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Remove shot.png" }));
    });
    await settle();
    expect(tiles()).toHaveLength(0);
    expect(screen.queryByTestId("attachment-preview")).toBeNull();
  });
});

describe("PDFs (compose.spec.ts)", () => {
  it("a first-page tile with its pages, the preview's size line, sent staged with its pages as [PDF: …]", async () => {
    vi.mocked(pdfSummary).mockImplementation((file) => Promise.resolve({ pages: (file as File).name === "notes.pdf" ? 1 : 2, thumb: THUMB }));
    render(<SelectedComposer />);
    await settle();
    expect(screen.getByTestId("composer-attach").getAttribute("aria-label")).toBe("Attach images or PDFs");
    expect(screen.getByTestId("composer-file-input").getAttribute("accept")).toMatch(/application\/pdf,\.pdf$/);

    await pick(pdf("spec.pdf"));
    expect(tiles()).toHaveLength(1);
    const tile = tiles()[0];
    expect(tile?.getAttribute("data-kind")).toBe("pdf");
    expect(tile?.getAttribute("data-pages")).toBe("2");
    expect(tile?.textContent).toContain("PDF");
    expect(tile?.querySelector("img")?.getAttribute("src")).toBe(THUMB);
    expect(screen.getByTestId("attachment-open").getAttribute("aria-label")).toBe("Preview spec.pdf, PDF, 2 pages, 1 KB");
    expect(notice()).toBeNull();

    act(() => {
      fireEvent.click(screen.getByTestId("attachment-open"));
    });
    const preview = await screen.findByTestId("attachment-preview");
    expect(preview.getAttribute("data-kind")).toBe("pdf");
    expect(within(preview).getByRole("heading").textContent).toBe("spec.pdf");
    expect(screen.getByTestId("attachment-preview-size").textContent).toBe("1 KB · 2 pages");
    act(() => {
      fireEvent.keyDown(preview, { key: "Escape" });
    });
    await settle();

    await pick(pdf("notes.pdf", 900));
    const [spec, notes] = getDraft("repo-cf").attachments;
    const chip = (a: typeof spec) => (a ? tagToken({ tagKind: "image", name: a.file.name, id: a.id }) : "");
    act(() => {
      updateDraft("repo-cf", { text: `Summarize ${chip(spec)} and ${chip(notes)}` });
    });
    await send();
    expect(composerDaemon.staged.map((a) => [a.name, a.mimeType, a.size, a.pages])).toEqual([
      ["spec.pdf", "application/pdf", 1000, 2],
      ["notes.pdf", "application/pdf", 900, 1],
    ]);
    const [up1, up2] = composerDaemon.staged;
    const args = lastInvocation("thread.new")?.args;
    expect(args?.prompt).toBe(`Summarize [PDF: spec.pdf; ref=${up1?.path ?? ""}] and [PDF: notes.pdf; ref=${up2?.path ?? ""}]`);
    expect(args?.attachments).toBe(`${up1?.path ?? ""},${up2?.path ?? ""}`);
  });

  it("over 20 MB is rejected; over 10 pages goes as a path and says so", async () => {
    vi.mocked(pdfSummary).mockResolvedValue({ pages: 30, thumb: null });
    render(<SelectedComposer />);
    await settle();
    await pick(pdf("huge.pdf", 21 * 1024 * 1024));
    expect(notice()).toBe("huge.pdf: larger than 20 MB");
    expect(tiles()).toHaveLength(0);

    await pick(pdf("book.pdf", 40_000));
    expect(tiles()[0]?.getAttribute("data-pages")).toBe("30");
    expect(notice()).toBe("book.pdf has 30 pages; Claude reads it page by page");
    expect(screen.getByTestId("attachment-open").getAttribute("aria-label")).toMatch(/^Preview book\.pdf, PDF, 30 pages, \d+ KB$/);
  });
});
