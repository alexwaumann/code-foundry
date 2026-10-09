import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/stores/ui";
import { PaneHeader } from "./PaneHeader";
import { TRAFFIC_LIGHT_GUTTER } from "./titleBand";

afterEach(() => {
  cleanup();
});

describe("PaneHeader", () => {
  it.each([
    { sidebarVisible: true, paddingLeft: "" },
    { sidebarVisible: false, paddingLeft: `${String(TRAFFIC_LIGHT_GUTTER)}px` },
  ])("sidebar visible $sidebarVisible: padding-left '$paddingLeft'", ({ sidebarVisible, paddingLeft }) => {
    useUiStore.setState({ sidebarVisible });
    render(<PaneHeader className="px-5" style={{ color: "red" }} data-testid="h" />);
    const h = screen.getByTestId("h");
    expect(h.style.paddingLeft).toBe(paddingLeft);
    expect(h.style.color).toBe("red");
    expect(h.className).toContain("[--wails-draggable:drag]");
    expect(h.className).toContain("h-11");
    expect(h.hasAttribute("data-pane-header")).toBe(true);
  });

  it("follows the sidebar being hidden and shown", () => {
    useUiStore.setState({ sidebarVisible: true });
    render(<PaneHeader data-testid="h" />);
    act(() => {
      useUiStore.setState({ sidebarVisible: false });
    });
    expect(screen.getByTestId("h").style.paddingLeft).toBe(`${String(TRAFFIC_LIGHT_GUTTER)}px`);
    act(() => {
      useUiStore.setState({ sidebarVisible: true });
    });
    expect(screen.getByTestId("h").style.paddingLeft).toBe("");
  });
});
