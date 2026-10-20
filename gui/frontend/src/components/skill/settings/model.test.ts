import { describe, expect, it } from "vitest";
import { ageWords, chipValue, confirmCopy, installedPill, readWords, RESTART_WARNING, registryLine, resultsWords, sourceWords, toggleChip, versionWords, ymd } from "./model";

const DAY = 86_400_000;
const now = Date.parse("2026-10-20T12:00:00Z");

describe("skill settings model", () => {
  it("ymd is the UTC date", () => {
    expect(ymd(Date.parse("2026-10-16T23:30:00Z"))).toBe("20261016");
  });

  it.each([
    [0, "today"],
    [-DAY, "today"],
    [DAY, "yesterday"],
    [5 * DAY, "5 days ago"],
    [13 * DAY, "13 days ago"],
    [14 * DAY, "2 weeks ago"],
    [59 * DAY, "8 weeks ago"],
    [60 * DAY, "2 months ago"],
    [729 * DAY, "24 months ago"],
    [800 * DAY, "2 years ago"],
  ])("ageWords(%d ms ago) is %s", (ago, want) => {
    expect(ageWords(now - ago, now)).toBe(want);
  });

  it.each([
    [null, "not read yet"],
    [now - 10_000, "read just now"],
    [now - 5 * 60_000, "read 5 min ago"],
    [now - 3 * 3_600_000, "read 3 h ago"],
    [now - 2 * DAY, "read 2 d ago"],
  ])("readWords(%s) is %s", (at, want) => {
    expect(readWords(at, now)).toBe(want);
  });

  it.each([
    ["a plugin's version as it is", { kind: "plugin" as const, version: "1.4.0", lastUpdatedMs: now - DAY }, "1.4.0"],
    ["a skill's date and age", { kind: "skill" as const, version: "20261016", lastUpdatedMs: now - 4 * DAY }, "20261016 · 4 days ago"],
    ["a skill without a version takes its date", { kind: "skill" as const, version: "", lastUpdatedMs: Date.parse("2026-10-19T10:00:00Z") }, "20261019 · yesterday"],
    ["a skill without history", { kind: "skill" as const, version: "", lastUpdatedMs: null }, ""],
    ["a local skill (epoch zero)", { kind: "skill" as const, version: "", lastUpdatedMs: 0 }, ""],
  ])("versionWords: %s", (_name, r, want) => {
    expect(versionWords(r, now)).toBe(want);
  });

  it.each([
    ["installed", { state: "installed" as const, registry: "ai-marketplace" }, "from ai-marketplace"],
    ["local", { state: "local" as const, registry: "" }, "Local"],
    ["missing", { state: "missing" as const, registry: "ai-marketplace" }, "from ai-marketplace"],
  ])("sourceWords: %s", (_name, r, want) => {
    expect(sourceWords(r)).toBe(want);
  });

  it.each([
    ["enabled", { state: "installed" as const, enabled: true, needsSetup: false, kind: "skill" as const }, "Enabled"],
    ["disabled", { state: "installed" as const, enabled: false, needsSetup: false, kind: "skill" as const }, "Disabled"],
    ["needs setup", { state: "installed" as const, enabled: true, needsSetup: true, kind: "skill" as const }, "Needs setup"],
    ["disabled wins over needs setup", { state: "installed" as const, enabled: false, needsSetup: true, kind: "skill" as const }, "Disabled"],
    ["a plugin never needs setup", { state: "installed" as const, enabled: true, needsSetup: true, kind: "plugin" as const }, "Enabled"],
    ["missing", { state: "missing" as const, enabled: true, needsSetup: true, kind: "skill" as const }, "Missing"],
    ["local has none", { state: "local" as const, enabled: true, needsSetup: false, kind: "skill" as const }, null],
  ])("installedPill: %s", (_name, r, want) => {
    expect(installedPill(r)?.label ?? null).toBe(want);
  });

  it("resultsWords says when the list is cut", () => {
    expect(resultsWords(1, 1)).toBe("1 result");
    expect(resultsWords(42, 42)).toBe("42 results");
    expect(resultsWords(1234, 200)).toBe("1,234 results, showing the first 200");
  });

  it("registryLine counts and dates a marketplace", () => {
    expect(registryLine({ plugins: 1, skills: 39, readAtMs: now - 5 * 60_000 }, now)).toBe("1 plugin · 39 skills · read 5 min ago");
  });

  it("chips: none or both is any, one is its value; a press toggles", () => {
    expect(chipValue([])).toBe("");
    expect(chipValue(["enterprise"])).toBe("enterprise");
    expect(chipValue(["enterprise", "community"])).toBe("");
    expect(toggleChip(["enterprise"], "community")).toEqual(["enterprise", "community"]);
    expect(toggleChip(["enterprise", "community"], "enterprise")).toEqual(["community"]);
  });

  it("every confirm carries the restart warning; Remove says it deletes a skill you wrote", () => {
    const skill = { kind: "skill" as const, name: "my-notes", dir: "/Users/dev/.claude/skills/my-notes" };
    for (const a of ["disable", "uninstall", "remove"] as const) expect(confirmCopy(a, skill).body).toContain(RESTART_WARNING);
    expect(confirmCopy("remove", skill)).toMatchObject({ title: "Remove my-notes?", label: "Remove" });
    expect(confirmCopy("remove", skill).body).toContain("deletes /Users/dev/.claude/skills/my-notes, a skill you wrote");
    expect(confirmCopy("uninstall", { ...skill, kind: "plugin", name: "enterprise-data" }).body).toContain("removes the plugin and its skills");
  });
});
