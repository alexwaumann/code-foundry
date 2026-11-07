import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { blankFile, readFile, type FileReadView } from "@/api/files";
import { surfaces } from "@/surfaces/registry";
import { gallerySurface } from "@/surfaces/gallery";
import { GalleryTab } from "./GalleryTab";
import { loadThumb } from "./thumbnail";
import { ImageFailure } from "./thumbStore";

// jsdom lays nothing out: every row at its estimated size (as SearchDialog.test.tsx).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number }) => {
    const items: { index: number; key: number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: i, start: at, size, end: at + size });
      at += size;
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined };
  },
}));

vi.mock("@/api/files", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/api/files")>()), readFile: vi.fn() }));

vi.mock("./thumbnail", async (importOriginal) => ({ ...(await importOriginal<typeof import("./thumbnail")>()), loadThumb: vi.fn() }));

const list = (...images: { path: string; caption?: string; stamp?: number }[]) => JSON.stringify(images);
const shots = list({ path: "/tmp/a.png", caption: "Before", stamp: 1 }, { path: "/tmp/b.png", stamp: 2 }, { path: "/tmp/gone.png", caption: "Gone" });

const image = (path: string): FileReadView => ({ ...blankFile(path), text: null, binary: true, mime: "image/png", image: new Uint8Array([1, 2, 3]) });

const revoke = vi.fn();

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:full");
  URL.revokeObjectURL = revoke;
  vi.mocked(loadThumb).mockReset();
  vi.mocked(loadThumb).mockImplementation((_base, i) => (i.path.includes("gone") ? Promise.reject(new ImageFailure("Not found")) : Promise.resolve(`blob:${i.path}`)));
  vi.mocked(readFile).mockReset();
  vi.mocked(readFile).mockImplementation((_base, path) => Promise.resolve(path.includes("gone") ? { ...blankFile(path), notFound: true } : image(path)));
  // The grid draws once it has a width.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 360, height: 600 } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openGrid(images = shots) {
  const view = render(<GalleryTab base="/wt" images={images} />);
  await waitFor(() => {
    expect(screen.getAllByTestId("gallery-tile").length).toBeGreaterThan(0);
  });
  return view;
}

const tiles = () => screen.getAllByTestId("gallery-tile");
const single = () => screen.getByTestId("gallery-single");

async function openImage(index: number) {
  const tile = tiles()[index];
  if (!tile) throw new Error(`no tile ${String(index)}`);
  fireEvent.click(tile);
  await screen.findByTestId("gallery-single");
}

describe("the surface", () => {
  it("is the model's: listed nowhere and on no key, with nothing to open by itself", () => {
    expect(surfaces).toContain(gallerySurface);
    expect(gallerySurface.hotkey).toBeUndefined();
    expect(gallerySurface.available({ selection: { kind: "thread", id: "s-1" }, panelKey: "thread:s-1" })).toBe("hidden");
    expect(gallerySurface.openDefault({ selection: { kind: "thread", id: "s-1" }, panelKey: "thread:s-1" })).toBeNull();
  });
});

describe("the grid", () => {
  it("shows each image with its caption, else its file's name, and counts them", async () => {
    await openGrid();
    expect(screen.getByTestId("gallery-count").textContent).toBe("3 images");
    await waitFor(() => {
      expect(tiles()[0]?.dataset.state).toBe("ready");
    });
    expect(tiles()[0]?.querySelector("img")?.getAttribute("src")).toBe("blob:/tmp/a.png");
    expect(screen.getByText("Before")).toBeTruthy();
    expect(screen.getByText("b.png")).toBeTruthy();
  });

  it("says one image in the singular", async () => {
    await openGrid(list({ path: "/tmp/a.png" }));
    expect(screen.getByTestId("gallery-count").textContent).toBe("1 image");
  });

  it("shows an image that failed as a tile with its name and why, and the rest load", async () => {
    await openGrid();
    await waitFor(() => {
      expect(tiles()[2]?.dataset.state).toBe("failed");
    });
    expect(tiles()[2]?.textContent).toContain("gone.png");
    expect(tiles()[2]?.textContent).toContain("Not found");
    expect(tiles()[2]?.getAttribute("aria-label")).toBe("Gone: Not found");
    expect(screen.getByText("Gone")).toBeTruthy();
    expect(tiles()[1]?.dataset.state).toBe("ready");
  });

  it("names a failed tile once when it has no caption", async () => {
    await openGrid(list({ path: "/tmp/gone.png" }));
    await waitFor(() => {
      expect(tiles()[0]?.dataset.state).toBe("failed");
    });
    expect(screen.getAllByText("gone.png")).toHaveLength(1);
  });

  it("says so when the tab's params hold no images", () => {
    render(<GalleryTab base="/wt" images="nonsense" />);
    expect(screen.getByTestId("gallery-empty")).toBeTruthy();
  });

  it("frees its thumbnails with the tab's body", async () => {
    const view = await openGrid();
    await waitFor(() => {
      expect(tiles()[0]?.dataset.state).toBe("ready");
    });
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:/tmp/a.png");
  });
});

describe("the single view", () => {
  it("shows the image through the file viewer's preview, read as the File tab reads it", async () => {
    await openGrid();
    await openImage(1);
    expect(await screen.findByTestId("file-image")).toBeTruthy();
    expect(readFile).toHaveBeenCalledWith("/wt", "/tmp/b.png", undefined, expect.any(AbortSignal));
    expect(screen.getByTestId("gallery-caption").textContent).toBe("b.png");
    expect(screen.getByTestId("gallery-position").textContent).toBe("2 of 3");
    expect(screen.getAllByTestId("gallery-film-frame")).toHaveLength(3);
    expect(screen.getAllByTestId("gallery-film-frame")[1]?.getAttribute("aria-current")).toBe("true");
  });

  it("reads each thumbnail once for the grid and the filmstrip", async () => {
    await openGrid();
    await waitFor(() => {
      expect(loadThumb).toHaveBeenCalledTimes(3);
    });
    await openImage(0);
    expect(loadThumb).toHaveBeenCalledTimes(3);
  });

  it("moves with the arrows and holds at the ends", async () => {
    await openGrid();
    await openImage(0);
    fireEvent.keyDown(single(), { key: "ArrowLeft" });
    expect(screen.getByTestId("gallery-position").textContent).toBe("1 of 3");
    fireEvent.keyDown(single(), { key: "ArrowRight" });
    fireEvent.keyDown(single(), { key: "ArrowDown" });
    fireEvent.keyDown(single(), { key: "ArrowRight" });
    expect(screen.getByTestId("gallery-position").textContent).toBe("3 of 3");
    fireEvent.keyDown(single(), { key: "ArrowUp" });
    expect(screen.getByTestId("gallery-position").textContent).toBe("2 of 3");
  });

  it("goes back to the grid on Esc and on its button", async () => {
    await openGrid();
    await openImage(0);
    fireEvent.keyDown(single(), { key: "Escape" });
    expect(screen.queryByTestId("gallery-single")).toBeNull();
    expect(tiles()).toHaveLength(3);
    await openImage(0);
    fireEvent.click(screen.getByTestId("gallery-back"));
    expect(screen.queryByTestId("gallery-single")).toBeNull();
  });

  it("keeps the keys off the panel, and leaves it the ones that are not its own", async () => {
    const panel = vi.fn();
    render(
      <div onKeyDown={panel}>
        <GalleryTab base="/wt" images={shots} />
      </div>,
    );
    await waitFor(() => {
      expect(tiles()).toHaveLength(3);
    });
    await openImage(0);
    fireEvent.keyDown(single(), { key: "ArrowRight" });
    fireEvent.keyDown(single(), { key: "Escape" });
    expect(panel).not.toHaveBeenCalled();
    await openImage(0);
    fireEvent.keyDown(single(), { key: "w", metaKey: true });
    expect(panel).toHaveBeenCalledTimes(1);
  });

  it("picks from the filmstrip", async () => {
    await openGrid();
    await openImage(0);
    const frame = screen.getAllByTestId("gallery-film-frame")[1];
    if (!frame) throw new Error("no frame");
    fireEvent.click(frame);
    expect(screen.getByTestId("gallery-position").textContent).toBe("2 of 3");
  });

  it("says why an image that failed will not show, and moves on", async () => {
    await openGrid();
    await openImage(2);
    const failed = await screen.findByTestId("gallery-image-failed");
    expect(failed.textContent).toContain("Not found");
    expect(failed.textContent).toContain("/tmp/gone.png");
    fireEvent.keyDown(single(), { key: "ArrowLeft" });
    expect(await screen.findByTestId("file-image")).toBeTruthy();
  });

  it("says a read that failed", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("outside the home directory"));
    await openGrid();
    await openImage(0);
    expect((await screen.findByTestId("gallery-image-failed")).textContent).toContain("outside the home directory");
  });

  it("says bytes that will not decode", async () => {
    await openGrid();
    await openImage(0);
    const preview = await screen.findByTestId("file-image");
    const img = preview.querySelector("img");
    if (!img) throw new Error("no image");
    fireEvent.error(img);
    expect((await screen.findByTestId("gallery-image-failed")).textContent).toContain("Cannot decode");
  });

  it("shows the thumbnail while the full image reads", async () => {
    await openGrid();
    await waitFor(() => {
      expect(tiles()[0]?.dataset.state).toBe("ready");
    });
    vi.mocked(readFile).mockReturnValue(new Promise(() => undefined));
    await openImage(0);
    expect(screen.getByTestId("gallery-image-loading").querySelector("img")?.getAttribute("src")).toBe("blob:/tmp/a.png");
  });
});

describe("a re-open with the same title", () => {
  it("shows the new images in the grid", async () => {
    const view = await openGrid();
    view.rerender(<GalleryTab base="/wt" images={list({ path: "/tmp/c.png", caption: "New" })} />);
    expect(await screen.findByText("New")).toBeTruthy();
    expect(screen.queryByText("Before")).toBeNull();
  });

  it("loads again an image rewritten at its path", async () => {
    const view = await openGrid(list({ path: "/tmp/a.png", stamp: 1 }));
    await waitFor(() => {
      expect(loadThumb).toHaveBeenCalledTimes(1);
    });
    view.rerender(<GalleryTab base="/wt" images={list({ path: "/tmp/a.png", stamp: 2 })} />);
    await waitFor(() => {
      expect(loadThumb).toHaveBeenCalledTimes(2);
    });
  });

  it("stays on the file showing, wherever it moved", async () => {
    const view = await openGrid();
    await openImage(1);
    view.rerender(<GalleryTab base="/wt" images={list({ path: "/tmp/z.png" }, { path: "/tmp/y.png" }, { path: "/tmp/b.png", stamp: 2 })} />);
    expect(await screen.findByTestId("gallery-single")).toBeTruthy();
    expect(screen.getByTestId("gallery-position").textContent).toBe("3 of 3");
  });

  it("does not take the keyboard from where the user is", async () => {
    const view = render(
      <>
        <textarea data-testid="composer" />
        <GalleryTab base="/wt" images={shots} />
      </>,
    );
    await waitFor(() => {
      expect(tiles()).toHaveLength(3);
    });
    await openImage(1);
    const composer = screen.getByTestId("composer");
    composer.focus();
    view.rerender(
      <>
        <textarea data-testid="composer" />
        <GalleryTab base="/wt" images={list({ path: "/tmp/z.png" }, { path: "/tmp/b.png", stamp: 2 })} />
      </>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(composer);
  });

  it("goes back to the grid when the file showing is gone", async () => {
    const view = await openGrid();
    await openImage(1);
    view.rerender(<GalleryTab base="/wt" images={list({ path: "/tmp/z.png" })} />);
    await waitFor(() => {
      expect(screen.queryByTestId("gallery-single")).toBeNull();
    });
    expect(tiles()).toHaveLength(1);
  });
});
