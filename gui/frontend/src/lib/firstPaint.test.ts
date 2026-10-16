import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "@/themes";
import html from "../../index.html?raw";
import { THEME_STORAGE_KEY } from "./theme";

// index.html's inline script: the first paint uses the last applied theme.
const inline = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
const root = document.documentElement;

function setSystem(light: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: light && q.includes("light") }));
}

function run() {
  // The script as the page runs it: jsdom does not execute inline scripts it is handed.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call
  new Function(inline)();
  return { theme: root.dataset.theme, dark: root.classList.contains("dark"), scheme: root.style.colorScheme };
}

beforeEach(() => {
  localStorage.clear();
  root.removeAttribute("data-theme");
  root.className = "dark";
  root.removeAttribute("style");
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("index.html first paint", () => {
  it("uses the storage key lib/theme writes", () => {
    expect(inline).toContain(`"${THEME_STORAGE_KEY}"`);
    expect(inline).toContain(`"${DEFAULT_DARK}"`);
    expect(inline).toContain(`"${DEFAULT_LIGHT}"`);
  });

  it.each([
    ["nothing stored, macOS dark", null, false, { theme: DEFAULT_DARK, dark: true, scheme: "dark" }],
    ["nothing stored, macOS light", null, true, { theme: DEFAULT_LIGHT, dark: false, scheme: "light" }],
    ["system follows macOS", { scheme: "system", dark: "dracula", light: "rose-pine-dawn" }, true, { theme: "rose-pine-dawn", dark: false, scheme: "light" }],
    ["forced dark in light macOS", { scheme: "dark", dark: "dracula", light: "rose-pine-dawn" }, true, { theme: "dracula", dark: true, scheme: "dark" }],
    ["forced light in dark macOS", { scheme: "light", dark: "dracula", light: "github-light" }, false, { theme: "github-light", dark: false, scheme: "light" }],
    ["garbage", "{not json", false, { theme: DEFAULT_DARK, dark: true, scheme: "dark" }],
  ])("%s", (_, stored, light, want) => {
    if (stored !== null) localStorage.setItem(THEME_STORAGE_KEY, typeof stored === "string" ? stored : JSON.stringify(stored));
    setSystem(light);
    expect(run()).toEqual(want);
  });
});
