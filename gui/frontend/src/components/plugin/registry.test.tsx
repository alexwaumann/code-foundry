import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { NODE_KINDS, type ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { NodeList } from "./NodeList";
import { renderers } from "./nodes/index";

const ctx: ViewCtx = { watchKey: "w", instance: "hello/demo/thread:s-1", version: 1, plugin: "hello", viewTab: "overview", uiContext: emptyContext, inert: false };

function inView(children: ReactNode, c: Partial<ViewCtx> = {}) {
  return render(<ViewContext.Provider value={{ ...ctx, ...c }}>{children}</ViewContext.Provider>);
}

afterEach(() => {
  cleanup();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {} });
});

describe("node renderer registry", () => {
  it("has a renderer for every node kind", () => {
    expect(Object.keys(renderers).sort()).toEqual([...NODE_KINDS].sort());
  });

  it("renders the overview: text, markdown, pairs, list, chips, progress, notice, section, empty, actions", () => {
    inView(<NodeList nodes={demoView("overview").nodes} />);
    for (const id of ["plugin-text", "plugin-markdown", "plugin-pairs", "plugin-list", "plugin-chips", "plugin-notice", "plugin-section", "plugin-empty"]) expect(screen.getAllByTestId(id).length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("plugin-progress")).toHaveLength(2);
    expect(screen.getAllByTestId("plugin-row").map((r) => r.getAttribute("data-key"))).toEqual(["run-3", "run-2", "run-1"]);
    expect(screen.getAllByTestId("plugin-chip").map((c) => c.getAttribute("data-status"))).toEqual(["ok", "running", "pending", "skipped", "off", "attention", "failed"]);
    // No filled buttons: the styles are the plugin's, drawn as outlines or text.
    const styles = screen.getAllByTestId("plugin-button").map((b) => b.getAttribute("data-style"));
    expect(styles).toContain("attention");
    expect(styles).not.toContain("primary");
    // The stale section is dimmed.
    expect(document.querySelector('[data-key="stale"][data-stale="true"]')).not.toBeNull();
  });

  it("collapses a section on the host, per instance", () => {
    inView(<NodeList nodes={demoView("overview").nodes} />);
    const section = document.querySelector('[data-testid="plugin-section"][data-key="more"]');
    const toggle = section?.querySelector('[data-testid="plugin-section-toggle"]');
    if (!toggle) throw new Error("no toggle");
    fireEvent.click(toggle);
    expect(usePluginSurfacesStore.getState().collapsed[ctx.instance]?.more).toBe(true);
    expect(section?.getAttribute("data-collapsed")).toBe("true");
  });

  it("renders the form: inputs, a secret, selects in three styles, a fieldset of toggles", () => {
    inView(<NodeList nodes={demoView("form").nodes} />, { viewTab: "form" });
    expect(screen.getAllByTestId("plugin-input").map((i) => [i.getAttribute("data-name"), i.getAttribute("type")])).toEqual([
      ["name", "text"],
      ["token", "password"],
    ]);
    expect(screen.getAllByTestId("plugin-select").map((s) => [s.getAttribute("data-name"), s.getAttribute("data-style")])).toEqual([
      ["project", "dropdown"],
      ["env", "radios"],
      ["tags", "checks"],
    ]);
    expect(screen.getByTestId("plugin-fieldset").querySelectorAll('[data-testid="plugin-toggle"]')).toHaveLength(2);
  });

  it("keeps typed values as drafts per instance, tab and form", () => {
    inView(<NodeList nodes={demoView("form").nodes} />, { viewTab: "form" });
    const name = screen.getAllByTestId("plugin-input")[0];
    if (!name) throw new Error("no input");
    fireEvent.change(name, { target: { value: "Ada" } });
    expect(usePluginSurfacesStore.getState().drafts[`${ctx.instance}\u0000form\u0000settings`]).toEqual({ name: "Ada" });
  });

  it("renders the log tab: logs with tones, and placeholders for plugin threads and terminals", () => {
    inView(<NodeList nodes={demoView("log").nodes} />, { viewTab: "log" });
    expect(screen.getAllByTestId("plugin-log")).toHaveLength(2);
    expect(document.querySelector('[data-tone="error"]')?.textContent).toBe("error: missing return");
    expect(screen.getAllByTestId("plugin-placeholder").map((p) => p.getAttribute("data-kind"))).toEqual(["thread", "terminal"]);
    expect(screen.getAllByTestId("plugin-placeholder")[0]?.textContent).toContain("Arrives with a later version");
  });

  it("says so for a node of a kind it does not know", () => {
    const nodes: ViewNode[] = [{ key: "x" }];
    inView(<NodeList nodes={nodes} />);
    expect(screen.getByTestId("plugin-unknown-node")).toBeTruthy();
  });

  it("disables buttons while the view is inert (the plugin is down)", () => {
    inView(<NodeList nodes={demoView("log").nodes} />, { inert: true, viewTab: "log" });
    for (const b of screen.getAllByTestId("plugin-button")) expect((b as HTMLButtonElement).disabled).toBe(true);
  });
});
