import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

const { openFileInPanel } = vi.hoisted(() => ({ openFileInPanel: vi.fn<(target: string, file: object) => boolean>(() => true) }));
vi.mock("@/stores/filePanel", () => ({ openFileInPanel }));
const { readFile } = vi.hoisted(() => ({ readFile: vi.fn<(dir: string, path: string) => Promise<never>>(() => Promise.reject(new Error("missing"))) }));
vi.mock("@/api/files", () => ({ readFile }));

afterEach(() => {
  cleanup();
  openFileInPanel.mockClear();
  readFile.mockClear();
});

describe("a rendered markdown file's path chips", () => {
  it("resolve against the thread checkout the tab came from, not the file's folder", () => {
    const { container } = render(<MarkdownPreview text={"Start with `src/main.go:3`."} dir="/w/docs/" project="p1" base="/w" />);
    const chip = container.querySelector<HTMLElement>('[data-testid="path-chip"]');
    expect(chip?.dataset.path).toBe("src/main.go");
    fireEvent.click(chip as HTMLElement);
    expect(openFileInPanel).toHaveBeenCalledWith("current", { project: "p1", base: "/w", path: "/w/src/main.go", line: 3 });
  });
});

describe("a rendered markdown file's local images", () => {
  it("a src that is not valid percent-encoding is read as typed, and a failed read shows the chip", async () => {
    const { container } = render(<MarkdownPreview text={'<img src="progress-100%.png" alt="progress">\n\n![shot](a%20b.png)'} dir="/w/docs/" project="p1" base="/w" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(readFile.mock.calls.map((c) => c[1])).toEqual(["progress-100%.png", "a b.png"]);
    expect(container.textContent).toContain("progress");
  });
});
