import { describe, expect, it } from "vitest";
import type { InstalledSkillView } from "@/api/skill";
import type { OverflowItem } from "@/components/projects/OverflowMenu";
import { catalogEntries } from "@/components/settings/catalog/model";
import { RESTART_WARNING, type SkillFailure } from "@/stores/skill";
import {
  ageWords,
  chipValue,
  confirmCopy,
  groupedIds,
  hasSwitch,
  kindWords,
  marketKeys,
  marketplaceCount,
  matchesInstalled,
  refreshHint,
  registriesSummary,
  registryLine,
  rowKeys,
  rowMain,
  searchedIds,
  skillGroup,
  skillMenu,
  sourceWords,
  toggleChip,
  updatableRows,
  versionWords,
  ymd,
} from "./model";

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
    for (const a of ["uninstall", "remove"] as const) expect(confirmCopy(a, skill).body).toContain(RESTART_WARNING);
    expect(confirmCopy("remove", skill)).toMatchObject({ title: "Remove my-notes?", label: "Remove" });
    expect(confirmCopy("remove", skill).body).toContain("deletes /Users/dev/.claude/skills/my-notes, a skill you wrote");
    expect(confirmCopy("uninstall", { ...skill, kind: "plugin", name: "enterprise-data" }).body).toContain("removes the plugin and its skills");
  });
});

const offer = { version: "20261016", lastUpdatedMs: null, commitSha: "" };

function row(o: Partial<InstalledSkillView> & { name: string }): InstalledSkillView {
  const kind = o.kind ?? "skill";
  return {
    key: `${kind}:${o.name}`,
    kind,
    id: o.name,
    registry: "ai-marketplace",
    path: "",
    tier: "enterprise",
    description: "",
    by: "",
    version: "20260912",
    lastUpdatedMs: null,
    enabled: true,
    state: "installed",
    dir: `/Users/dev/.claude/skills/${o.name}`,
    scope: "",
    skills: [],
    setupScript: "",
    needsSetup: false,
    update: null,
    ...o,
  };
}

describe("the list's groups", () => {
  it.each([
    ["an update", { update: offer }, "needs"],
    ["an update on a disabled row", { update: offer, enabled: false }, "needs"],
    ["needs setup", { needsSetup: true }, "needs"],
    ["a plugin never needs setup", { needsSetup: true, kind: "plugin" as const }, "enabled"],
    ["missing", { state: "missing" as const }, "needs"],
    ["enabled", {}, "enabled"],
    ["disabled", { enabled: false }, "disabled"],
    ["local, whatever its switch would say", { state: "local" as const, enabled: false }, "enabled"],
  ])("%s", (_name, o, want) => {
    expect(skillGroup(row({ name: "x", ...o }), {})).toBe(want);
  });

  it("a row a run finished stays in Needs you", () => {
    expect(skillGroup(row({ name: "x" }), { "skill:x": "20261016" })).toBe("needs");
  });

  const rows = [row({ name: "a" }), row({ name: "b", enabled: false }), row({ name: "c", update: offer }), row({ name: "p", kind: "plugin" })];

  it("groupedIds orders the groups, leaves empty ones out and counts them", () => {
    expect(catalogEntries(groupedIds(rows, "", {}))).toEqual([
      { kind: "group", id: "needs", count: 1 },
      { kind: "row", key: "skill:c" },
      { kind: "group", id: "enabled", count: 2 },
      { kind: "row", key: "skill:a" },
      { kind: "row", key: "plugin:p" },
      { kind: "group", id: "disabled", count: 1 },
      { kind: "row", key: "skill:b" },
    ]);
    expect(groupedIds(rows, "plugin", {})).toEqual(["#enabled", "plugin:p"]);
    expect(groupedIds([], "", {})).toEqual([]);
  });

  it("matchesInstalled reads every word across the name, description, author, source and a plugin's skills", () => {
    const r = row({ name: "enterprise-data", kind: "plugin", description: "Query the warehouse", by: "Data Platform", skills: ["lineage"] });
    expect(matchesInstalled(r, ["warehouse", "platform"], "")).toBe(true);
    expect(matchesInstalled(r, ["lineage"], "")).toBe(true);
    expect(matchesInstalled(r, ["ai-marketplace"], "")).toBe(true);
    expect(matchesInstalled(r, ["warehouse", "nope"], "")).toBe(false);
    expect(matchesInstalled(r, ["warehouse"], "skill")).toBe(false);
  });

  it("a search is one group: the client's filter and what the marketplace found by keyword", () => {
    const list = [row({ name: "sql-helper" }), row({ name: "dbt-model", description: "Scaffold a model" }), row({ name: "other" })];
    expect(searchedIds(list, ["sql"], "", new Set(["skill:dbt-model"]))).toEqual(["#installed", "skill:sql-helper", "skill:dbt-model"]);
    expect(searchedIds(list, ["sql"], "plugin", new Set(["skill:dbt-model"]))).toEqual([]);
  });

  it("a hit the Installed group shows is not listed twice", () => {
    const ids = searchedIds([row({ name: "a" })], ["a"], "", new Set());
    expect(marketKeys([{ key: "skill:a" }, { key: "skill:b" }], rowKeys(ids))).toEqual(["skill:b"]);
  });

  it("updatableRows leaves a missing row's Reinstall to it", () => {
    const list = [row({ name: "a", update: offer }), row({ name: "b", update: offer, state: "missing" }), row({ name: "c" })];
    expect(updatableRows(list).map((r) => r.name)).toEqual(["a"]);
  });

  it("kindWords counts a plugin's skills", () => {
    expect(kindWords("plugin", 4)).toBe("Plugin · 4");
    expect(kindWords("plugin", 0)).toBe("Plugin");
    expect(kindWords("skill", 0)).toBe("Skill");
  });
});

describe("a row's main action and switch", () => {
  const failed: SkillFailure = { action: "update", message: "no" };
  it.each([
    ["nothing", {}, null, null, undefined, null],
    ["an update", { update: offer }, null, null, undefined, { kind: "update", version: "20261016", retry: false }],
    ["an update that failed", { update: offer }, null, failed, undefined, { kind: "update", version: "20261016", retry: true }],
    ["another action's failure is no retry", { update: offer }, null, { action: "disable", message: "no" }, undefined, { kind: "update", version: "20261016", retry: false }],
    ["updating", { update: offer }, "update", null, undefined, { kind: "updating" }],
    ["a finished row", {}, null, null, "20261016", { kind: "updated", version: "20261016" }],
    ["a finished row that a newer offer reached", { update: offer }, null, null, "20261010", { kind: "update", version: "20261016", retry: false }],
    ["update before setup", { update: offer, needsSetup: true }, null, null, undefined, { kind: "update", version: "20261016", retry: false }],
    ["setup", { needsSetup: true }, null, null, undefined, { kind: "setup" }],
    ["a plugin has no setup", { needsSetup: true, kind: "plugin" as const }, null, null, undefined, null],
    ["missing", { state: "missing" as const, update: offer }, null, null, undefined, { kind: "reinstall" }],
    ["local", { state: "local" as const }, null, null, undefined, null],
    ["uninstalling", { update: offer }, "uninstall", null, undefined, { kind: "working", words: "Uninstalling…" }],
    ["removing", { state: "local" as const }, "remove", null, undefined, { kind: "working", words: "Removing…" }],
    ["setup again, from the menu", {}, "setup", null, undefined, { kind: "working", words: "Starting setup…" }],
    ["the row's own Run setup spins itself", { needsSetup: true }, "setup", null, undefined, { kind: "setup" }],
  ] as const)("%s", (_name, o, busy, failure, updated, want) => {
    expect(rowMain(row({ name: "x", ...o }), busy, failure, updated)).toEqual(want);
  });

  it.each([
    ["installed", "installed", true],
    ["local", "local", false],
    ["missing", "missing", false],
  ] as const)("switch: %s", (_name, state, want) => {
    expect(hasSwitch({ state })).toBe(want);
  });
});

describe("a row's menu", () => {
  const menu = (r: InstalledSkillView, o: { owner?: boolean; busy?: boolean } = {}): OverflowItem[] =>
    skillMenu(r, { owner: o.owner ?? true, noOwner: "Select a thread or project first", busy: o.busy ?? false, onView: () => undefined, onSetup: () => undefined, onConfirm: () => undefined });
  const labels = (items: readonly OverflowItem[]) => items.map((i) => (i === "separator" ? "---" : i.label));

  it.each([
    ["a skill", row({ name: "x" }), ["View SKILL.md", "---", "Uninstall"]],
    ["a skill with a setup script", row({ name: "x", setupScript: "install.sh" }), ["View SKILL.md", "Run setup again", "---", "Uninstall"]],
    ["a local skill", row({ name: "x", state: "local", registry: "" }), ["View SKILL.md", "---", "Remove"]],
    ["a missing skill", row({ name: "x", state: "missing", setupScript: "install.sh" }), ["Uninstall"]],
    ["a Claude Code plugin", row({ name: "x", kind: "plugin" }), ["Uninstall"]],
    ["a skill with no folder on record", row({ name: "x", dir: "" }), ["Uninstall"]],
  ])("%s", (_name, r, want) => {
    expect(labels(menu(r))).toEqual(want);
  });

  it("Run setup again waits for an owner and says so; a busy row runs nothing more", () => {
    const r = row({ name: "x", setupScript: "install.sh" });
    expect(menu(r, { owner: false })[1]).toMatchObject({ disabled: true, hint: "Select a thread or project first" });
    expect(menu(r)[1]).toMatchObject({ disabled: false });
    expect(menu(r, { busy: true }).filter((i) => i !== "separator" && i.disabled).map((i) => i !== "separator" && i.label)).toEqual(["Run setup again", "Uninstall"]);
  });

  it("the destructive item says so", () => {
    expect(menu(row({ name: "x" })).at(-1)).toMatchObject({ destructive: true, testId: "skill-menu-uninstall" });
  });
});

describe("the page menu", () => {
  const reg = { name: "ai-marketplace", plugins: 3, skills: 1237, readAtMs: now - 5 * 60_000 };

  it("marketplaceCount adds every plugin and skill; null before the read", () => {
    expect(marketplaceCount([reg, { ...reg, plugins: 1, skills: 1 }])).toBe(1242);
    expect(marketplaceCount([])).toBe(0);
    expect(marketplaceCount(undefined)).toBeNull();
  });

  it("refreshHint is the newest read, as a sentence", () => {
    expect(refreshHint([reg, { readAtMs: now - DAY }], now)).toBe("Read 5 min ago");
    expect(refreshHint([{ readAtMs: null }], now)).toBe("Not read yet");
    expect(refreshHint(undefined, now)).toBe("Not read yet");
  });

  it("registriesSummary names one marketplace and counts several", () => {
    expect(registriesSummary([reg])).toBe("ai-marketplace · 3 plugins · 1,237 skills");
    expect(registriesSummary([reg, { ...reg, plugins: 0, skills: 1 }])).toBe("2 marketplaces · 3 plugins · 1,238 skills");
    expect(registriesSummary([])).toBe("None configured");
    expect(registriesSummary(undefined)).toBe("None configured");
  });
});
