import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT, themeById } from "@/themes";
import { setThemePreference, setThemeSlots } from "./theme";
import { syncWindowBackground, windowBackground } from "./windowBackground";

const sheet = (id: string) => themeById.get(id)?.slots["--cf-canvas"];

afterEach(() => {
  setThemePreference("system");
  setThemeSlots({ light: DEFAULT_LIGHT, dark: DEFAULT_DARK });
});

describe("window background", () => {
  it("reports both slots' sheets, the preference and the scheme in effect", () => {
    setThemePreference("light");
    setThemeSlots({ dark: "dracula", light: "rose-pine-dawn" });
    expect(windowBackground()).toEqual({ scheme: "light", dark: sheet("dracula"), light: sheet("rose-pine-dawn"), active: "light" });
    expect(windowBackground().dark).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("reports on start and on each change, once per distinct value", () => {
    setThemePreference("dark");
    const report = vi.fn();
    const stop = syncWindowBackground(report);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ active: "dark", dark: sheet(DEFAULT_DARK) }));
    setThemeSlots({ dark: "dracula" });
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ dark: sheet("dracula") }));
    setThemePreference("light");
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ scheme: "light", active: "light" }));
    setThemeSlots({ dark: "dracula" }); // no change
    expect(report).toHaveBeenCalledTimes(3);
    stop();
    setThemeSlots({ dark: "nord" });
    expect(report).toHaveBeenCalledTimes(3);
  });
});
