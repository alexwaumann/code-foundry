import { describe, expect, it } from "vitest";
import { contrast, flatten } from "./color";
import { contrastReport, derivedValue, fixContrast, pinBasis, slotContrast, staleOverrides, withoutPin, type EditableTheme } from "./contrast";
import { CONTRAST_PAIRS } from "./contrastPairs";
import { themeById, themes } from "./index";
import { resolveSlots, SLOT_NAMES } from "./slots";
import { SLOT_USES } from "./slotUses";

const gh = themeById.get("github-dark");
if (!gh) throw new Error("github-dark");
const base: EditableTheme = { scheme: gh.scheme, base: gh.base };
const pinned = (overrides: Record<string, string>): EditableTheme => ({ ...base, overrides });

describe("contrastReport", () => {
  it("is empty for every curated theme (contrast.test.ts holds them to every pair)", () => {
    for (const t of themes) expect(contrastReport(t, t.slots), t.id).toEqual([]);
  });

  it("names the slot, what it is against, the ratio and the floor, in pair order", () => {
    const surface = resolveSlots(base)["--cf-surface"] ?? "";
    const report = contrastReport(pinned({ "--cf-text-muted": surface }));
    expect(report.filter((r) => r.slot === "--cf-text-muted").map((r) => r.against)).toEqual(["--cf-surface", "--cf-canvas", "--cf-surface-sunken", "--cf-control-hover"]);
    // What derives from it falls with it: the placeholder and the row icons are the muted text.
    expect(report.map((r) => r.slot)).toContain("--cf-placeholder");
    expect(report[0]).toMatchObject({ slot: "--cf-text-muted", against: "--cf-surface", label: "--cf-text-muted on --cf-surface", ratio: 1, required: 4.5 });
    expect(report[0]?.why).toContain("secondary text");
  });

  it("flattens a tint over what it sits on", () => {
    const report = contrastReport(pinned({ "--cf-message-surface": "#e6edf3ff" }));
    expect(report).toContainEqual(expect.objectContaining({ slot: "--cf-message-foreground", against: "--cf-message-surface", over: "--cf-surface", label: "--cf-message-foreground on --cf-message-surface over --cf-surface" }));
  });
});

describe("slotContrast", () => {
  it("lists every pair the slot is in, on top or underneath, with pass/fail", () => {
    const slots = resolveSlots(base);
    const rows = slotContrast(slots, "--cf-sidebar-row-selected");
    expect(rows.map((r) => `${r.slot} on ${r.against}`)).toEqual([
      "--cf-sidebar-foreground on --cf-sidebar-row-selected",
      "--cf-sidebar-muted-foreground on --cf-sidebar-row-selected",
      "--cf-sidebar-row-selected on --cf-sidebar",
    ]);
    expect(rows.every((r) => r.pass)).toBe(true);
    const row = rows[2];
    expect(row?.ratio).toBeCloseTo(contrast(slots["--cf-sidebar-row-selected"] ?? "", slots["--cf-sidebar"] ?? ""), 6);
    expect(row?.required).toBe(1.25);
  });

  it("a slot no pair names has none", () => {
    expect(slotContrast(resolveSlots(base), "--terminal-ansi-3")).toEqual([]);
  });
});

describe("derivedValue and staleOverrides", () => {
  const theme = pinned({ "--cf-sidebar-row-selected": "#1e2e3c", "--syn-kw": "#ff00ff" });

  it("derives a pinned slot with the other pins kept", () => {
    expect(derivedValue(theme, "--cf-sidebar-row-selected")).toBe(resolveSlots(base)["--cf-sidebar-row-selected"]);
    expect(derivedValue(theme, "--syn-kw")).toBe(resolveSlots(withoutPin(theme, "--syn-kw"))["--syn-kw"]);
    expect(withoutPin(theme, "--syn-kw").overrides).toEqual({ "--cf-sidebar-row-selected": "#1e2e3c" });
  });

  it("a pin is stale once the base moves its derived value away from the one it was pinned against", () => {
    const basis = pinBasis(theme);
    expect(staleOverrides(theme, basis)).toEqual([]);
    // The canvas feeds the sidebar, so the selected row's rule moves; the keyword's does not.
    const moved: EditableTheme = { ...theme, base: { ...theme.base, canvas: "#202830" } };
    const stale = staleOverrides(moved, basis);
    expect(stale).toEqual([{ slot: "--cf-sidebar-row-selected", pinned: "#1e2e3c", basis: basis["--cf-sidebar-row-selected"], derived: derivedValue(moved, "--cf-sidebar-row-selected") }]);
    expect(stale[0]?.derived).not.toBe(stale[0]?.basis);
    // Back to the old canvas: not stale again.
    expect(staleOverrides({ ...moved, base: theme.base }, basis)).toEqual([]);
    // A pin without a basis is never stale.
    expect(staleOverrides(moved, {})).toEqual([]);
  });
});

describe("fixContrast", () => {
  it("unpins a failing pin whose derived value passes", () => {
    const sidebar = resolveSlots(base)["--cf-sidebar"] ?? "";
    expect(fixContrast(pinned({ "--cf-sidebar-row-selected": sidebar }), "--cf-sidebar-row-selected")).toEqual({ kind: "unpin" });
  });

  it("steps a derived slot that fails against a pinned background, and pins the result", () => {
    const text = resolveSlots(base)["--cf-text"] ?? "";
    const theme = pinned({ "--cf-message-surface": text });
    const fix = fixContrast(theme, "--cf-message-foreground");
    expect(fix?.kind).toBe("pin");
    if (fix?.kind !== "pin") return;
    const slots = resolveSlots({ ...theme, overrides: { ...theme.overrides, "--cf-message-foreground": fix.value } });
    const bg = flatten(slots["--cf-message-surface"] ?? "", slots["--cf-surface"] ?? "");
    expect(contrast(fix.value, bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastReport({ ...theme, overrides: { ...theme.overrides, "--cf-message-foreground": fix.value } }).filter((r) => r.slot === "--cf-message-foreground")).toEqual([]);
  });

  it("is null for a slot that fails nothing", () => {
    expect(fixContrast(base, "--cf-text")).toBeNull();
  });

  // A mid-grey hovered row under a dark theme: muted text needs 4.5:1 on it and on the dark
  // panes; white falls short on the grey, and anything dark enough for the grey fails the panes.
  const grey = pinned({ "--cf-control-hover": "#8a8a8a" });

  it("leaves a slot alone when no lightness of it holds, and says on what", () => {
    const fix = fixContrast(grey, "--cf-text-muted");
    expect(fix).toEqual({ kind: "none", reason: "unreachable", against: "--cf-control-hover", required: 4.5 });
  });

  it("never pins a value that still fails, or one that leaves more pairs failing (pressing Fix again does not undo it)", () => {
    const before = contrastReport(grey);
    for (const slot of new Set(before.map((r) => r.slot))) {
      const fix = fixContrast(grey, slot);
      if (fix?.kind !== "pin") continue;
      const fixed = { ...grey, overrides: { ...grey.overrides, [slot]: fix.value } };
      const after = contrastReport(fixed);
      expect(after.filter((r) => r.slot === slot), slot).toEqual([]);
      expect(after.length, slot).toBeLessThan(before.length);
      expect(fixContrast(fixed, slot), slot).toBeNull();
    }
  });
});

describe("SLOT_USES", () => {
  it("says where every slot is used, and names no other", () => {
    expect(Object.keys(SLOT_USES).sort()).toEqual([...SLOT_NAMES].sort());
    for (const [k, v] of Object.entries(SLOT_USES)) expect(v.length, k).toBeGreaterThan(5);
  });

  it("every pair's slots are slots", () => {
    for (const p of CONTRAST_PAIRS) for (const s of [p.fg, p.bg, p.over].filter(Boolean)) expect(SLOT_NAMES).toContain(s);
  });
});
