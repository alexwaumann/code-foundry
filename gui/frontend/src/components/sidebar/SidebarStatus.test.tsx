import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { useCommandsStore } = await import("@/stores/commands");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");
const { SidebarStatus } = await import("./SidebarStatus");

/**
 * The sidebar's status row: the palette, Usage, Help and Settings buttons, started like the
 * palette starts their commands, and the two sheet toggles' pressed state. Settings and Usage
 * toggle their sheets (pressed while they show, one at a time), Help opens the help overlay,
 * the palette button opens the palette here without a round trip. A click on a button under
 * an open sheet's backdrop is e2e (settings-sheet.spec.ts, usage-page.spec.ts).
 */

const cmd = (name: string, title: string): CommandView => ({ name, title, description: "", category: "View", args: [], keybindings: [], available: true });

beforeEach(() => {
  resetDaemon();
  useCommandsStore.setState({ commands: [cmd("ui.palette.open", "Command Palette"), cmd("view.usage", "Usage"), cmd("view.help", "Help"), cmd("view.settings", "Settings")] });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  useUiStore.setState({ selection: { kind: "thread", id: "a" } });
  act(() => {
    useUiStore.getState().closePalette();
  });
});

afterEach(() => {
  cleanup();
});

function show() {
  render(
    <TooltipProvider>
      <SidebarStatus />
    </TooltipProvider>,
  );
}

const pressed = (id: string) => screen.getByTestId(id).getAttribute("aria-pressed");

describe("SidebarStatus", () => {
  it("lists the palette, Usage, Help and Settings buttons in that order", () => {
    show();
    const order = [...screen.getByTestId("sidebar-status").querySelectorAll("[data-command-button]")].map((e) => e.getAttribute("data-testid"));
    expect(order).toEqual(["status-palette", "status-usage", "status-help", "status-settings"]);
  });

  it("Settings toggles its sheet and shows pressed while it is open", () => {
    show();
    expect(pressed("status-settings")).toBe("false");
    fireEvent.click(screen.getByTestId("status-settings"));
    expect(useViewsStore.getState().settingsOpen).toBe(true);
    expect(pressed("status-settings")).toBe("true");
    fireEvent.click(screen.getByTestId("status-settings"));
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(pressed("status-settings")).toBe("false");
  });

  it("Usage toggles the usage sheet and shows pressed while it is open", () => {
    show();
    expect(pressed("status-usage")).toBe("false");
    fireEvent.click(screen.getByTestId("status-usage"));
    expect(useViewsStore.getState().usageOpen).toBe(true);
    expect(pressed("status-usage")).toBe("true");
    fireEvent.click(screen.getByTestId("status-usage"));
    expect(useViewsStore.getState().usageOpen).toBe(false);
    expect(pressed("status-usage")).toBe("false");
  });

  it("Settings and Usage are exclusive: one pressed at a time, and Themes in the sheet presses Settings", () => {
    show();
    fireEvent.click(screen.getByTestId("status-usage"));
    fireEvent.click(screen.getByTestId("status-settings"));
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, usageOpen: false });
    expect([pressed("status-settings"), pressed("status-usage")]).toEqual(["true", "false"]);
    act(() => {
      useViewsStore.setState({ settingsOpen: false, usageOpen: true });
    });
    expect([pressed("status-settings"), pressed("status-usage")]).toEqual(["false", "true"]);
    act(() => {
      useViewsStore.setState({ usageOpen: false, themesOpen: true });
    });
    expect([pressed("status-settings"), pressed("status-usage")]).toEqual(["true", "false"]);
  });

  it("Help opens the help overlay; the palette button opens the palette without asking the daemon", async () => {
    show();
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
