import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeBase, UserThemeFile } from "@/themes";

// A thread's theme card (docs/notes/theme-model-flow.md) over the app's themes and slots;
// its buttons go through the registry. The Undo rule itself: stores/themeCards.test.ts.
const runCommandForResult = vi.hoisted(() => vi.fn(() => Promise.resolve({ message: "", resultJson: "{}" })));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult }));

const { ThemeCard } = await import("./ThemeCard");
const { TooltipProvider } = await import("@/components/ui/tooltip");
const { setUserThemes, themeById } = await import("@/themes");
const { useThemesStore } = await import("@/stores/themes");
const { useSettingsStore } = await import("@/stores/settings");

function baseOf(id: string, edit: Partial<Omit<ThemeBase, "terminal">>): ThemeBase {
  const t = themeById.get(id);
  if (!t) throw new Error(`no curated theme ${id}`);
  return { ...t.base, ...edit, terminal: { ...t.base.terminal, ansi: [...t.base.terminal.ansi] } };
}

const OCEAN: UserThemeFile = {
  id: "ocean-dusk",
  name: "Ocean Dusk",
  scheme: "dark",
  source: "",
  from: "catppuccin-mocha",
  createdBy: "s-1",
  path: "",
  version: "v1",
  base: baseOf("catppuccin-mocha", { canvas: "#0b141c", surface: "#16232f", text: "#d7e3ea", accent: "#5fb3b3" }),
  overrides: { "--cf-sidebar-row-selected": "#1e2e3c" },
};
const LATTE: UserThemeFile = { id: "latte-softer", name: "Latte, softer", scheme: "light", source: "", from: "catppuccin-latte", createdBy: "s-3", path: "", base: baseOf("catppuccin-latte", { accent: "#8c6bb1" }) };
const NORD_COPY: UserThemeFile = { ...OCEAN, id: "nord-copy", name: "Nord, mine", from: "nord", base: baseOf("nord", {}), overrides: {} };

function slots(values: Record<string, string>): void {
  act(() => {
    useSettingsStore.setState((s) => ({ snapshot: { values: { ...s.snapshot?.values, ...values }, path: "", revision: (s.snapshot?.revision ?? 0) + 1, loadError: "", issues: [], restartPending: [] } }));
  });
}
/** A theme event: every theme, with a fresh history list for each (as the daemon's carries). */
function themes(files: UserThemeFile[], history: Record<string, string[]> = Object.fromEntries(files.map((f) => [f.id, []]))): void {
  act(() => {
    setUserThemes(files, false);
    useThemesStore.setState({ history });
  });
}

type Card = { file: UserThemeFile; applied: boolean; previous?: string; version?: string };
function show(...cards: Card[]) {
  return render(
    <TooltipProvider>
      {cards.map((c, i) => (
        <ThemeCard key={i} file={c.file} applied={c.applied} undo={{ scheme: c.file.scheme, id: c.file.id, previous: c.applied ? (c.previous ?? "") : "", version: c.version ?? "" }} />
      ))}
    </TooltipProvider>,
  );
}
const cards = () => screen.getAllByTestId("thread-theme-card");
const undoOf = (card: HTMLElement) => within(card).queryByTestId<HTMLButtonElement>("thread-theme-undo");
const tipOf = async (card: HTMLElement) => {
  const tip = within(card).getByTestId("thread-theme-undo-tip");
  fireEvent.pointerMove(tip, { pointerType: "mouse" });
  fireEvent.focus(tip);
  await waitFor(() => {
    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull();
  });
  return document.querySelector('[data-slot="tooltip-content"]')?.textContent;
};
const ran = () => (runCommandForResult.mock.calls as unknown as [string, Record<string, string>][]).map(([n, a]) => [n, a]);

beforeEach(() => {
  runCommandForResult.mockClear();
  useSettingsStore.setState({ snapshot: null });
  themes([OCEAN, LATTE]);
  slots({ "appearance.theme_dark": "ocean-dusk", "appearance.theme_light": "github-light" });
});
afterEach(() => {
  cleanup();
  setUserThemes([], false);
});

describe("ThemeCard", () => {
  it("shows the saved theme: name, scheme and origin, applied, nine swatches of the file's colours, pins and contrast", () => {
    show({ file: OCEAN, applied: true, previous: "catppuccin-mocha" });
    const [card] = cards();
    if (!card) throw new Error("no card");
    expect(within(card).getByTestId("thread-theme-name").textContent).toBe("Ocean Dusk");
    expect(card.textContent).toContain("dark · from Catppuccin Mocha");
    expect(within(card).getByTestId("thread-theme-applied").textContent).toBe("applied");
    const swatches = within(card).getByTestId("thread-theme-swatches").querySelectorAll("span");
    expect(swatches).toHaveLength(9);
    expect((swatches[0] as HTMLElement).style.background).toBe("rgb(11, 20, 28)");
    expect(within(card).getByTestId("thread-theme-summary").textContent).toMatch(/^1 pinned · (contrast ok|\d+ contrast issues?)$/);
  });

  it("Undo puts the slot back and turns into Undone; Edit opens the editor on the theme", async () => {
    show({ file: OCEAN, applied: true, previous: "catppuccin-mocha" });
    const [card] = cards();
    if (!card) throw new Error("no card");
    const undo = undoOf(card);
    expect(undo?.textContent).toBe("Undo");
    fireEvent.click(undo as HTMLButtonElement);
    expect(ran()).toEqual([["theme.set-dark", { theme: "catppuccin-mocha" }]]);
    slots({ "appearance.theme_dark": "catppuccin-mocha" });
    await waitFor(() => {
      expect(undoOf(card)?.textContent).toBe("Undone");
    });
    expect(undoOf(card)?.disabled).toBe(true);
    fireEvent.click(within(card).getByTestId("thread-theme-edit"));
    expect(ran().at(-1)).toEqual(["theme.edit", { theme: "ocean-dusk" }]);
  });

  it("a card saved without applying offers Apply, which sets the slot; then the badge shows instead", () => {
    show({ file: LATTE, applied: false });
    const [card] = cards();
    if (!card) throw new Error("no card");
    expect(within(card).queryByTestId("thread-theme-applied")).toBeNull();
    const apply = within(card).getByTestId("thread-theme-apply");
    expect(apply.textContent).toBe("Apply");
    fireEvent.click(apply);
    expect(ran()).toEqual([["theme.set-light", { theme: "latte-softer" }]]);
    slots({ "appearance.theme_light": "latte-softer" });
    expect(within(card).getByTestId("thread-theme-applied").textContent).toBe("applied");
    expect(within(card).queryByTestId("thread-theme-apply")).toBeNull();
  });

  it("Undo hides once the slot moves on and comes back with it; a refinement's Undo restores the colours before", async () => {
    // The first card applied Ocean Dusk over GitHub Dark; the refinement (v2) replaced v1's colours.
    const warmer: UserThemeFile = { ...OCEAN, version: "v2", base: { ...OCEAN.base, accent: "#e0a060" } };
    show({ file: OCEAN, applied: true, previous: "github-dark" }, { file: warmer, applied: true, previous: "ocean-dusk", version: "v1" });
    const [first, second] = cards();
    if (!first || !second) throw new Error("no cards");
    // Before the refinement lands, the slot shows the first card's colours.
    expect(undoOf(first)?.textContent).toBe("Undo");
    slots({ "appearance.theme_dark": "nord" });
    expect(undoOf(first)).toBeNull();
    slots({ "appearance.theme_dark": "ocean-dusk" });
    expect(undoOf(first)?.disabled).toBe(false);

    // The refinement lands: the first card hides (the slot no longer shows its colours).
    themes([warmer, LATTE], { "ocean-dusk": ["v1"] });
    expect(undoOf(first)).toBeNull();
    expect(undoOf(second)?.textContent).toBe("Undo");
    expect(await tipOf(second)).toBe("Undo restores the previous colours");
    fireEvent.click(undoOf(second) as HTMLButtonElement);
    expect(ran().at(-1)).toEqual(["theme.restore", { theme: "ocean-dusk", version: "v1" }]);
    // v1 is back: the refinement reads Undone, and the first card's Undo is offered again.
    themes([OCEAN, LATTE], { "ocean-dusk": ["v2"] });
    expect(undoOf(second)?.textContent).toBe("Undone");
    expect(undoOf(first)?.textContent).toBe("Undo");
  });

  it("Undo is disabled, with why, once the theme it goes back to is deleted", async () => {
    themes([OCEAN, LATTE, NORD_COPY]);
    show({ file: OCEAN, applied: true, previous: "nord-copy" });
    const [card] = cards();
    if (!card) throw new Error("no card");
    expect(undoOf(card)?.disabled).toBe(false);
    themes([OCEAN, LATTE]);
    expect(undoOf(card)?.disabled).toBe(true);
    expect(undoOf(card)?.dataset.undo).toBe("gone");
    expect(await tipOf(card)).toBe("nord-copy was deleted");
  });
});
