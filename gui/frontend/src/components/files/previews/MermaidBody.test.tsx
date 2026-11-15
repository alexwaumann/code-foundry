import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankFile, type FileReadView } from "@/api/files";
import type { DiagramTheme } from "@/components/mermaid/mermaidTheme";
import type { RenderedDiagram } from "@/components/mermaid/types";
import { clearDiagramCache } from "@/components/mermaid/useMermaid";
import { setThemePreference } from "@/lib/theme";
import { MermaidBody } from "./MermaidBody";

// jsdom cannot lay out SVG text, so Mermaid itself does not run here (e2e/file-previews-mermaid.spec.ts draws for real).
const { renderDiagram } = vi.hoisted(() => ({ renderDiagram: vi.fn<(source: string, look: DiagramTheme) => Promise<RenderedDiagram>>() }));
vi.mock("@/components/mermaid/render", () => ({ renderDiagram }));

const FLOW = "flowchart TD\n  a --> b\n";

function drawn(nodes: number | null = 9, type = "flowchart-v2"): RenderedDiagram {
  return { ok: true, id: "cfmmd1x", svg: '<svg id="cfmmd1x" viewBox="0 0 300 120" width="100%" style="max-width: 300px;"><style>#cfmmd1x .node{}</style><g class="node"><text>a</text></g></svg>', type, width: 300, height: 120, nodes };
}

function file(text: string): FileReadView {
  return { ...blankFile("/w/docs/flow.mmd"), text, size: new TextEncoder().encode(text).length, mime: "text/vnd.mermaid" };
}

function show(text: string) {
  const onMeta = vi.fn();
  const onMode = vi.fn();
  const view = render(<MermaidBody file={file(text)} path="/w/docs/flow.mmd" mode="diagram" name="flow.mmd" place={{ project: "p", dir: "/w", file: "/w/docs/flow.mmd" }} page={undefined} reloads={0} findKey={undefined} onMeta={onMeta} onMode={onMode} />);
  return { ...view, onMeta, onMode };
}

/** Lets the dynamic import and the render's promise settle. */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
  renderDiagram.mockReset();
  clearDiagramCache();
  setThemePreference("system");
});

describe("MermaidBody", () => {
  it("draws the diagram with its own ids, Mermaid's sizing replaced by ours, and says the node count", async () => {
    renderDiagram.mockResolvedValue(drawn());
    const { container, onMeta } = show(FLOW);
    expect(screen.getByTestId("file-mermaid-drawing").textContent).toBe("Drawing…");
    await settle();
    const svg = container.querySelector("[data-testid=file-mermaid-diagram] svg");
    expect(svg).not.toBeNull();
    expect(svg?.id).toMatch(/^cfmmd1x.+/);
    expect(svg?.getAttribute("width")).toBeNull();
    expect(svg?.getAttribute("style") ?? "").not.toContain("max-width");
    expect(container.querySelector("style")?.textContent).toContain(`#${String(svg?.id)} .node`);
    expect(screen.getByTestId("file-mermaid-diagram").style.getPropertyValue("--cf-diagram-w")).toBe("300px");
    expect(onMeta).toHaveBeenLastCalledWith("Flowchart · 9 nodes · 23 B · Mermaid");
  });

  it("a diagram without a node count leaves the kind's meta as it is", async () => {
    renderDiagram.mockResolvedValue(drawn(null, "sequence"));
    const { onMeta } = show("sequenceDiagram\n  a->>b: hi\n");
    await settle();
    expect(screen.getByTestId("file-mermaid-diagram")).toBeTruthy();
    expect(onMeta).not.toHaveBeenCalled();
  });

  it("a parse error shows the parser's message and a way to Source", async () => {
    renderDiagram.mockResolvedValue({ ok: false, message: "Parse error on line 3:\n...b --> --> c\n---------^\nExpecting 'AMP', got 'LINK'" });
    const { onMode } = show("flowchart LR\n  a --> --> b\n");
    await settle();
    expect(screen.getByTestId("file-mermaid-error").textContent).toContain("This diagram cannot be drawn");
    expect(screen.getByTestId("file-mermaid-message").textContent).toContain("Expecting 'AMP', got 'LINK'");
    fireEvent.click(screen.getByTestId("file-mermaid-source"));
    expect(onMode).toHaveBeenCalledWith("source");
  });

  it.each<[string, string, string]>([
    ["empty", "", "The diagram is empty."],
    ["blank", "\n  \n", "The diagram is empty."],
    ["over Mermaid's limit", `flowchart TD\n${"  a --> b\n".repeat(6000)}`, "Mermaid draws up to 50K"],
  ])("%s: says so without loading Mermaid", (_, text, want) => {
    show(text);
    expect(screen.getByTestId("file-mermaid-message").textContent).toContain(want);
    expect(renderDiagram).not.toHaveBeenCalled();
  });

  it("Mermaid failing to load is an error, not a blank pane, and is tried again on the next mount", async () => {
    renderDiagram.mockRejectedValueOnce(new Error("boom"));
    show(FLOW);
    await settle();
    expect(screen.getByTestId("file-mermaid-message").textContent).toContain("boom");
    cleanup();
    renderDiagram.mockResolvedValue(drawn());
    show(FLOW);
    await settle();
    expect(screen.getByTestId("file-mermaid-diagram")).toBeTruthy();
  });

  it("draws once per text and theme: a remount reuses it, a theme change draws again in the new colours", async () => {
    renderDiagram.mockResolvedValue(drawn());
    show(FLOW);
    await settle();
    cleanup();
    show(FLOW);
    // From the cache: at once, no "Drawing…".
    expect(screen.getByTestId("file-mermaid-diagram")).toBeTruthy();
    expect(renderDiagram).toHaveBeenCalledTimes(1);
    act(() => {
      setThemePreference("light");
    });
    await settle();
    expect(renderDiagram).toHaveBeenCalledTimes(2);
    const [dark, light] = renderDiagram.mock.calls.map((c) => c[1]);
    expect(dark?.variables.darkMode).toBe(true);
    expect(light?.variables.darkMode).toBe(false);
    expect(light?.variables.background).not.toBe(dark?.variables.background);
  });
});
