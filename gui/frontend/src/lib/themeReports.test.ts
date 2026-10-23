import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThemeReportView } from "@/api/ui";
import { setUserThemes, themeById, type UserThemeFile } from "@/themes";
import { derivedValue } from "@/themes/contrast";
import { carryPinBasis, reportOn } from "@/themes/report";
import { PIN_BASIS_STORAGE_KEY, startThemeReports } from "./themeReports";

/** A user theme from a curated one's colours, with a version as the daemon sends it. */
function file(id: string, version: string, edit: Partial<UserThemeFile> = {}): UserThemeFile {
  const src = themeById.get("catppuccin-mocha");
  if (!src) throw new Error("no mocha");
  return { id, name: id, scheme: "dark", source: "", base: src.base, from: "catppuccin-mocha", createdBy: "", path: `/h/themes/${id}.json`, version, ...edit };
}

const mocha = () => {
  const t = themeById.get("catppuccin-mocha");
  if (!t) throw new Error("no mocha");
  return t;
};

describe("reportOn and carryPinBasis", () => {
  it("names each failing pair as the daemon keeps it, and nothing for a curated theme's colours", () => {
    expect(reportOn(mocha(), {})).toEqual({ issues: [], stale: [] });
    const t = { ...file("x", "1"), overrides: { "--cf-warning-text": mocha().base.surface } };
    const r = reportOn(t, carryPinBasis(t, undefined));
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues[0]).toEqual({ slot: "--cf-warning-text", against: "--cf-surface", label: "--cf-warning-text on --cf-surface", ratio: expect.any(Number) as number, required: 4.5 });
    expect(Object.keys(r.issues[0] ?? {}).sort()).toEqual(["against", "label", "ratio", "required", "slot"]);
    expect(r.stale).toEqual([]);
  });

  it("carries a kept pin's basis across a base change, so it shows stale; a moved pin starts again", () => {
    const pin = "#2a2a3a";
    const v1 = { ...file("x", "1"), overrides: { "--cf-sidebar-row-selected": pin } };
    const b1 = carryPinBasis(v1, undefined);
    expect(b1["--cf-sidebar-row-selected"]).toEqual({ pinned: pin, basis: derivedValue(v1, "--cf-sidebar-row-selected") });
    const v2 = { ...v1, base: { ...v1.base, surface: "#10202c", canvas: "#0a141c" } };
    const b2 = carryPinBasis(v2, b1);
    expect(b2["--cf-sidebar-row-selected"]).toBe(b1["--cf-sidebar-row-selected"]);
    const stale = reportOn(v2, b2).stale;
    expect(stale).toEqual([{ slot: "--cf-sidebar-row-selected", pinned: pin, basis: b1["--cf-sidebar-row-selected"]?.basis, derived: derivedValue(v2, "--cf-sidebar-row-selected") }]);
    // Pinned again at another value: measured now, not stale.
    const v3 = { ...v2, overrides: { "--cf-sidebar-row-selected": "#303040" } };
    expect(reportOn(v3, carryPinBasis(v3, b2)).stale).toEqual([]);
  });
});

describe("startThemeReports", () => {
  let stop: () => void = () => {};
  let sent: ThemeReportView[][] = [];
  let connect: () => void = () => {};

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.removeItem(PIN_BASIS_STORAGE_KEY);
    sent = [];
    stop = startThemeReports(
      (r) => {
        sent.push([...r]);
        return Promise.resolve();
      },
      (cb) => {
        connect = cb;
        return () => {};
      },
    );
  });

  afterEach(() => {
    stop();
    setUserThemes([]);
    vi.useRealTimers();
  });

  it("reports each new version once, debounced; every report again on connect", () => {
    setUserThemes([file("a", "a1"), file("b", "b1", { overrides: { "--cf-warning-text": mocha().base.surface } })]);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.map((r) => [r.id, r.version, r.issues.length > 0])).toEqual([
      ["a", "a1", false],
      ["b", "b1", true],
    ]);
    // The same versions (a no-op event): nothing to send.
    setUserThemes([file("a", "a1"), file("b", "b1", { overrides: { "--cf-warning-text": mocha().base.surface } })]);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(1);
    // A new version of one: only that one.
    setUserThemes([file("a", "a2", { name: "A" }), file("b", "b1", { overrides: { "--cf-warning-text": mocha().base.surface } })]);
    vi.advanceTimersByTime(150);
    expect(sent[1]?.map((r) => r.version)).toEqual(["a2"]);
    connect();
    vi.advanceTimersByTime(150);
    expect(sent[2]?.map((r) => r.version).sort()).toEqual(["a2", "b1"]);
  });

  it("skips themes without a version (the last launch's, before the daemon's list) and keeps the pin basis", () => {
    setUserThemes([{ ...file("a", ""), version: undefined }]);
    vi.advanceTimersByTime(150);
    expect(sent).toHaveLength(0);
    setUserThemes([file("p", "p1", { overrides: { "--cf-sidebar-row-selected": "#2a2a3a" } })]);
    vi.advanceTimersByTime(150);
    const stored = JSON.parse(localStorage.getItem(PIN_BASIS_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual(["p"]);
    // The base moves, the pin stays: stale.
    setUserThemes([file("p", "p2", { overrides: { "--cf-sidebar-row-selected": "#2a2a3a" }, base: { ...mocha().base, surface: "#10202c", canvas: "#0a141c" } })]);
    vi.advanceTimersByTime(150);
    expect(sent.at(-1)?.[0]?.stale.map((s) => s.slot)).toEqual(["--cf-sidebar-row-selected"]);
  });
});
