import { cleanup, render, screen } from "@testing-library/react";
import { FileText } from "lucide-react";
import { afterEach, describe, expect, it } from "vitest";
import { usePanelKey } from "@/shell/panelKeyContext";
import type { Tab } from "@/shell/host";
import type { SurfaceSpec } from "@/surfaces/types";
import type { TabEntry } from "@/stores/layout";
import { panelSurface } from "./panel";
import { seamTab } from "../kinds";

afterEach(cleanup);

const entry = (over: Partial<TabEntry>): TabEntry => ({ id: "t-1", kind: "file", thread: "", key: "", params: { path: "/w/a.ts", line: "4" }, title: "", name: "", paneId: "p-1", ...over });

function Probe() {
  return <span data-testid="key">{usePanelKey() || "(none)"}</span>;
}

const seen: [string, Tab][] = [];
const spec: SurfaceSpec = {
  kind: "files",
  title: "File",
  icon: FileText,
  available: () => "enabled",
  render: () => <Probe />,
  openDefault: () => null,
  beforeClose: (panelKey, tab) => {
    seen.push([panelKey, tab]);
    return Promise.resolve(false);
  },
  useUnsaved: (panelKey, tab) => panelKey === "thread:s-1" && tab.id === "files?path=%2Fw%2Fa.ts",
};

describe("a side panel surface as a shell tab", () => {
  it("renders a linked tab's body in its thread's panel key, an unlinked one in none", () => {
    const s = panelSurface("file", spec);
    render(<>{s.render(entry({ thread: "s-1" }))}</>);
    expect(screen.getByTestId("key").textContent).toBe("thread:s-1");
    cleanup();
    render(<>{s.render(entry({}))}</>);
    expect(screen.getByTestId("key").textContent).toBe("(none)");
  });

  it("asks the surface before a close and marks unsaved work, with the panel's key and the File tab's path id", async () => {
    const s = panelSurface("file", spec);
    const tab = entry({ thread: "s-1" });
    await expect(s.beforeClose?.(tab)).resolves.toBe(false);
    expect(seen.map(([k, t]) => [k, t.id, t.kind])).toEqual([["thread:s-1", "files?path=%2Fw%2Fa.ts", "files"]]);
    expect(s.useUnsaved?.(tab)).toBe(true);
    expect(s.useUnsaved?.(entry({ thread: "s-2" }))).toBe(false);
  });

  it("has no question and no dot for a surface without them", () => {
    const s = panelSurface("diff", { ...spec, kind: "diff", beforeClose: undefined, useUnsaved: undefined });
    expect(s.beforeClose).toBeUndefined();
    expect(s.useUnsaved).toBeUndefined();
  });
});

describe("seamTab", () => {
  it("gives a File tab the side panel's id (its path), every other kind its layout id", () => {
    expect(seamTab(entry({})).id).toBe("files?path=%2Fw%2Fa.ts");
    expect(seamTab(entry({ kind: "diff", params: { project: "pj" } })).id).toBe("t-1");
    expect(seamTab(entry({ params: {} })).id).toBe("t-1");
  });
});

