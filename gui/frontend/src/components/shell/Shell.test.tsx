import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const probes = vi.fn(() => Promise.resolve("unknown" as const));
vi.mock("@/shell/layoutService", async (orig) => ({ ...(await orig<typeof import("@/shell/layoutService")>()), probeLayoutService: () => probes() }));
// The grid is not what this is about: once the layout arrives, an empty stand-in.
vi.mock("./PaneGrid", () => ({ PaneGrid: () => null }));
vi.mock("@/components/needs/NeedsPopup", () => ({ NeedsPopup: () => null }));

const { LAYOUT_WAIT_MS, Shell } = await import("./Shell");
const { resetLayout } = await import("@/stores/layout");
const { resetLayoutService, useLayoutServiceStore } = await import("@/shell/layoutService");

beforeEach(() => {
  vi.useFakeTimers();
  probes.mockClear();
  resetLayout();
  resetLayoutService();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetLayout();
  resetLayoutService();
});

describe("a window waiting for its layout", () => {
  it("asks the daemon for it once it has waited, and after each further wait, until the daemon says it has no layout service", () => {
    render(<Shell />);
    act(() => {
      vi.advanceTimersByTime(LAYOUT_WAIT_MS - 1);
    });
    expect(probes).not.toHaveBeenCalled();
    expect(screen.queryByTestId("shell-notice")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(probes).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("shell-notice").getAttribute("data-notice")).toBe("no-layout");
    act(() => {
      vi.advanceTimersByTime(LAYOUT_WAIT_MS);
    });
    expect(probes).toHaveBeenCalledTimes(2);

    act(() => {
      useLayoutServiceStore.setState({ missing: true });
    });
    act(() => {
      vi.advanceTimersByTime(3 * LAYOUT_WAIT_MS);
    });
    expect(probes).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("shell-old-daemon")).toBeTruthy();
  });

  it("asks nothing once the layout is in", async () => {
    render(<Shell />);
    await act(async () => {
      await seedLayout({ ...layoutOf([space(pane("p-1", [tab("t-1", "prs")]), "p-1")]), legacyImported: true });
    });
    act(() => {
      vi.advanceTimersByTime(3 * LAYOUT_WAIT_MS);
    });
    expect(probes).not.toHaveBeenCalled();
    expect(screen.queryByTestId("shell-notice")).toBeNull();
  });
});
