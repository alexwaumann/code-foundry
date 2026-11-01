import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { useCommandsStore } = await import("@/stores/commands");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");
const { SidebarStatus } = await import("./SidebarStatus");

/**
 * The sidebar's status row buttons, started like the palette starts their commands: Settings
 * toggles its sheet (pressed while it shows), Help opens the help overlay, the palette button
 * opens the palette here without a round trip. A click on the button under the sheet's
 * backdrop is e2e/settings-sheet.spec.ts's.
 */

const cmd = (name: string, title: string): CommandView => ({ name, title, description: "", category: "View", args: [], keybindings: [], available: true });

beforeEach(() => {
  resetDaemon();
  useCommandsStore.setState({ commands: [cmd("ui.palette.open", "Command Palette"), cmd("view.usage", "Usage"), cmd("view.help", "Help"), cmd("view.settings", "Settings")] });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  act(() => {
    useUiStore.getState().closePalette();
  });
});

afterEach(() => {
  cleanup();
});

describe("SidebarStatus", () => {
  it("Settings toggles its sheet and shows pressed while it is open", () => {
    render(<SidebarStatus />);
    const settings = () => screen.getByTestId("status-settings");
    expect(settings().getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(settings());
    expect(useViewsStore.getState().settingsOpen).toBe(true);
    expect(settings().getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(settings());
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(settings().getAttribute("aria-pressed")).toBe("false");
  });

  it("Help opens the help overlay; the palette button opens the palette without asking the daemon", async () => {
    render(<SidebarStatus />);
    expect(screen.getByTestId("daemon-status")).toBeTruthy();
    fireEvent.click(screen.getByTestId("status-help"));
    expect(useViewsStore.getState().helpOpen).toBe(true);
    fireEvent.click(screen.getByTestId("status-palette"));
    // Deferred a microtask, like cmd+k.
    await vi.waitFor(() => {
      expect(useUiStore.getState().palette.open).toBe(true);
    });
    expect(invocationsOf("ui.palette.open")).toEqual([]);
  });
});
