import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

const { openFileInPanel } = vi.hoisted(() => ({ openFileInPanel: vi.fn<(target: string, file: object) => boolean>(() => true) }));
vi.mock("@/stores/filePanel", () => ({ openFileInPanel }));

afterEach(() => {
  cleanup();
  openFileInPanel.mockClear();
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
