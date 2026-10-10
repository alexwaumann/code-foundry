import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUiStore } from "@/stores/ui";
import { PaneHeader } from "./PaneHeader";
import { TRAFFIC_LIGHT_GUTTER, trafficLightGutter } from "./titleBand";

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

describe("trafficLightGutter", () => {
  it("keeps the gutter at 80 screen px across zooms", () => {
    expect(trafficLightGutter(100)).toBe(80);
    expect(trafficLightGutter(150)).toBe(53);
    expect(trafficLightGutter(90)).toBe(89);
  });

  it("the pane header's gutter follows the zoom", () => {
    useUiStore.setState({ sidebarVisible: false, zoom: 200 });
    render(<PaneHeader data-testid="z" />);
    expect(screen.getByTestId("z").style.paddingLeft).toBe("40px");
  });
});
