import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownPreview } from "@/components/files/MarkdownPreview";
import type { DiagramTheme } from "./mermaidTheme";
import type { RenderedDiagram } from "./types";
import { clearDiagramCache } from "./useMermaid";

// Mermaid does not run in jsdom (no SVG text layout); e2e/file-previews-mermaid.spec.ts draws a fence for real.
const { renderDiagram } = vi.hoisted(() => ({ renderDiagram: vi.fn<(source: string, look: DiagramTheme) => Promise<RenderedDiagram>>() }));
vi.mock("./render", () => ({ renderDiagram }));
vi.mock("@/stores/filePanel", () => ({ openFileInPanel: vi.fn() }));
vi.mock("@/api/files", () => ({ readFile: vi.fn(() => Promise.reject(new Error("missing"))) }));

const DRAWN: RenderedDiagram = { ok: true, id: "cfmmd2y", svg: '<svg id="cfmmd2y" viewBox="0 0 200 80"><g class="node"><text>a</text></g></svg>', type: "flowchart-v2", width: 200, height: 80, nodes: 1 };

const DOC = "# Notes\n\n```mermaid\nflowchart TD\n  a --> b\n```\n\n```ts\nconst x = 1;\n```\n";

function show(text = DOC) {
  return render(<MarkdownPreview text={text} dir="/w/docs/" project="p" base="/w" />);
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  renderDiagram.mockReset();
  clearDiagramCache();
});

describe("a ```mermaid fence in a rendered markdown file", () => {
  it("is the code block until drawn, then the diagram; other fences stay code", async () => {
    let resolve: (r: RenderedDiagram) => void = () => undefined;
    renderDiagram.mockReturnValue(new Promise((r) => (resolve = r)));
    const { container } = show();
    expect(container.querySelector('[data-lang="mermaid"]')?.textContent).toContain("a --> b");
    expect(container.querySelector("[data-testid=md-mermaid]")).toBeNull();
    await act(async () => {
      resolve(DRAWN);
      await Promise.resolve();
    });
    await settle();
    expect(container.querySelector("[data-testid=md-mermaid-diagram] svg")).not.toBeNull();
    expect(container.querySelector('[data-lang="mermaid"]')).toBeNull();
    expect(container.querySelector('[data-lang="ts"]')?.textContent).toContain("const x = 1;");
    expect(renderDiagram).toHaveBeenCalledTimes(1);
    expect(renderDiagram.mock.calls[0]?.[0]).toBe("flowchart TD\n  a --> b");
  });

  it("that does not parse stays the code block, with a note giving the parser's message", async () => {
    renderDiagram.mockResolvedValue({ ok: false, message: "Parse error on line 2:\n...a --> -->\n------^\nExpecting 'AMP', got 'LINK'" });
    const { container, getByTestId } = show("```mermaid\nflowchart TD\n  a --> --> b\n```\n");
    await settle();
    expect(container.querySelector('[data-lang="mermaid"]')?.textContent).toContain("a --> --> b");
    expect(getByTestId("md-mermaid-note").textContent).toBe("Diagram not drawn: Parse error on line 2: Expecting 'AMP', got 'LINK'");
    expect(container.querySelector("[data-testid=md-mermaid]")).toBeNull();
  });

  it("an empty fence is a code block with a note, and Mermaid is not loaded for it", () => {
    const { getByTestId } = show("```mermaid\n```\n");
    expect(getByTestId("md-mermaid-note").textContent).toBe("Diagram not drawn: The diagram is empty.");
    expect(renderDiagram).not.toHaveBeenCalled();
  });

  it("a markdown file with no mermaid fence never loads Mermaid", async () => {
    show("# Notes\n\n```sh\nmake\n```\n");
    await settle();
    expect(renderDiagram).not.toHaveBeenCalled();
  });
});
