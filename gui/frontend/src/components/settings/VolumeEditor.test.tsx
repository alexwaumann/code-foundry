import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingFieldView } from "@/api/settings";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const commands = vi.hoisted(() => ({ run: vi.fn(() => Promise.resolve(null)) }));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult: commands.run }));
const save = vi.hoisted(() => ({ fn: vi.fn(() => Promise.resolve({ ok: true as const })) }));
vi.mock("@/stores/settings", async (orig) => ({ ...(await orig<typeof import("@/stores/settings")>()), saveSettings: save.fn }));

// Radix's Slider measures its thumbs; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
);

const { SettingRow } = await import("./SettingRow");
const { useSettingsStore } = await import("@/stores/settings");

const KEY = "notifications.sound_volume";
const field: SettingFieldView = {
  key: KEY,
  title: "Alert volume",
  description: "",
  group: "notifications",
  type: "int",
  enumValues: [],
  enumLabels: [],
  defaultValue: "50",
  restartRequired: false,
  min: 0,
  max: 100,
  placeholder: "",
};

function setVolume(v: string | undefined, revision = 1): void {
  useSettingsStore.setState({ snapshot: { values: v === undefined ? {} : { [KEY]: v }, path: "", revision, loadError: "", issues: [], restartPending: [] } });
}

beforeEach(() => {
  vi.clearAllMocks();
  setVolume("15");
});
afterEach(cleanup);

describe("the alert volume row", () => {
  it("is a slider with its value and a Play button, not a number input", () => {
    render(<SettingRow field={field} />);
    expect(screen.getByRole("slider", { name: "Alert volume" }).getAttribute("aria-valuenow")).toBe("15");
    expect(screen.getByTestId("volume-value").textContent).toBe("15%");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(screen.getByRole("button", { name: "Play alert sound" })).toBeTruthy();
  });

  it("shows the default when the daemon has no value", () => {
    setVolume(undefined);
    render(<SettingRow field={field} />);
    expect(screen.getByTestId("volume-value").textContent).toBe("50%");
  });

  it("saves each keyboard step and Play passes the slider's value before the save lands", () => {
    render(<SettingRow field={field} />);
    const thumb = screen.getByRole("slider", { name: "Alert volume" });
    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    expect(save.fn).toHaveBeenCalledExactlyOnceWith({ [KEY]: "16" });
    expect(screen.getByTestId("volume-value").textContent).toBe("16%");
    fireEvent.click(screen.getByRole("button", { name: "Play alert sound" }));
    expect(commands.run).toHaveBeenCalledExactlyOnceWith("notifications.test", { volume: "16" }, { quiet: true });
  });

  it("follows a new daemon value (the file changed underneath)", () => {
    render(<SettingRow field={field} />);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Alert volume" }), { key: "ArrowRight" });
    act(() => {
      setVolume("70", 2);
    });
    expect(screen.getByTestId("volume-value").textContent).toBe("70%");
  });

  it("Play is disabled at 0", () => {
    setVolume("0");
    render(<SettingRow field={field} />);
    expect(screen.getByRole("button", { name: "Play alert sound" }).hasAttribute("disabled")).toBe(true);
  });
});
