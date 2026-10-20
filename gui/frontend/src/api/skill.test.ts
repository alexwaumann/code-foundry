import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { EventSchema } from "@/gen/codefoundry/v1/events_pb";
import {
  InstalledSkillState,
  ListInstalledSkillsResponseSchema,
  ListSkillRegistriesResponseSchema,
  SearchSkillsResponseSchema,
  SkillEntryState,
  SkillKind,
  SkillTier,
} from "@/gen/codefoundry/v1/skill_pb";
import { toEventView } from "./events";
import { skillChanges, skillCommandName, skillItemKey, toInstalledList, toSkillRegistries, toSkillSearch } from "./skill";

describe("skill keys", () => {
  it.each([
    ["plugin", "enterprise-data", "ai-marketplace", "plugin:enterprise-data@ai-marketplace", "enterprise-data@ai-marketplace"],
    ["plugin", "orphan", "", "plugin:orphan", "orphan"],
    ["skill", "pr-review", "ai-marketplace", "skill:pr-review", "pr-review"],
    ["skill", "mine", "", "skill:mine", "mine"],
  ] as const)("%s %s from %s", (kind, name, registry, key, arg) => {
    expect(skillItemKey(kind, name, registry)).toBe(key);
    expect(skillCommandName(kind, name, registry)).toBe(arg);
  });
});

describe("search mapping", () => {
  it("maps entries with what is installed of them", () => {
    const v = toSkillSearch(
      create(SearchSkillsResponseSchema, {
        total: 41,
        epoch: 9n,
        refreshError: "offline",
        entries: [
          {
            kind: SkillKind.PLUGIN,
            tier: SkillTier.ENTERPRISE,
            name: "enterprise-data",
            description: "Query the warehouse.",
            by: "Data Platform",
            version: "1.4.0",
            lastUpdated: timestampFromMs(5000),
            registry: "ai-marketplace",
            path: "enterprise/plugins/enterprise-data",
            keywords: ["sql"],
            skills: ["catalog", "query"],
            state: SkillEntryState.ENABLED,
            installedVersion: "1.3.0",
            updateVersion: "1.3.9",
          },
          { kind: SkillKind.SKILL, tier: SkillTier.COMMUNITY, name: "haiku", registry: "ai-marketplace", state: SkillEntryState.NOT_INSTALLED },
          { kind: SkillKind.SKILL, name: "odd" },
        ],
      }),
    );
    expect(v).toMatchObject({ total: 41, epoch: 9, refreshError: "offline" });
    expect(v.entries[0]).toEqual({
      key: "plugin:enterprise-data@ai-marketplace",
      kind: "plugin",
      tier: "enterprise",
      name: "enterprise-data",
      description: "Query the warehouse.",
      by: "Data Platform",
      version: "1.4.0",
      declaredVersion: "",
      lastUpdatedMs: 5000,
      registry: "ai-marketplace",
      path: "enterprise/plugins/enterprise-data",
      keywords: ["sql"],
      skills: ["catalog", "query"],
      setupScript: "",
      state: "enabled",
      installedVersion: "1.3.0",
      updateVersion: "1.3.9",
    });
    expect(v.entries[1]).toMatchObject({ key: "skill:haiku", kind: "skill", tier: "community", state: "not-installed", lastUpdatedMs: null });
    // Unspecified state is not installed; no tier is "".
    expect(v.entries[2]).toMatchObject({ state: "not-installed", tier: "" });
  });
});

describe("installed mapping", () => {
  it("maps rows: state, offer, setup", () => {
    const v = toInstalledList(
      create(ListInstalledSkillsResponseSchema, {
        epoch: 3n,
        pluginsError: "claude: exit 1",
        installed: [
          {
            kind: SkillKind.PLUGIN,
            name: "enterprise-data",
            id: "enterprise-data@ai-marketplace",
            registry: "ai-marketplace",
            version: "1.3.0",
            enabled: true,
            state: InstalledSkillState.INSTALLED,
            scope: "user",
            skills: ["catalog"],
            update: { version: "1.3.9", lastUpdated: timestampFromMs(7000), commitSha: "abc" },
          },
          { kind: SkillKind.SKILL, name: "mine", id: "mine", state: InstalledSkillState.LOCAL, enabled: true, by: "Me" },
          { kind: SkillKind.SKILL, name: "gone", id: "gone", registry: "ai-marketplace", state: InstalledSkillState.MISSING },
          { kind: SkillKind.SKILL, name: "setup-me", id: "setup-me", registry: "ai-marketplace", state: InstalledSkillState.INSTALLED, setupScript: "install.sh", needsSetup: true },
        ],
      }),
    );
    expect(v.epoch).toBe(3);
    expect(v.pluginsError).toBe("claude: exit 1");
    expect(v.installed.map((r) => [r.key, r.state])).toEqual([
      ["plugin:enterprise-data@ai-marketplace", "installed"],
      ["skill:mine", "local"],
      ["skill:gone", "missing"],
      ["skill:setup-me", "installed"],
    ]);
    expect(v.installed[0]?.update).toEqual({ version: "1.3.9", lastUpdatedMs: 7000, commitSha: "abc" });
    expect(v.installed[0]).toMatchObject({ scope: "user", skills: ["catalog"], enabled: true });
    expect(v.installed[1]).toMatchObject({ update: null, by: "Me", registry: "" });
    expect(v.installed[3]).toMatchObject({ needsSetup: true, setupScript: "install.sh" });
  });
});

describe("registries mapping", () => {
  it("maps marketplaces and the empty state's example", () => {
    const v = toSkillRegistries(
      create(ListSkillRegistriesResponseSchema, {
        expectedMarketplace: "ai-marketplace",
        epoch: 2n,
        error: "",
        registries: [{ name: "ai-marketplace", repo: "cof-primary/ai-marketplace", plugins: 3, skills: 40, readAt: timestampFromMs(1000), shallow: true, issues: ["x"] }],
      }),
    );
    expect(v).toMatchObject({ expectedMarketplace: "ai-marketplace", epoch: 2, error: "" });
    expect(v.registries[0]).toMatchObject({ name: "ai-marketplace", repo: "cof-primary/ai-marketplace", plugins: 3, skills: 40, readAtMs: 1000, refreshedAtMs: null, shallow: true, issues: ["x"] });
    expect(toSkillRegistries(create(ListSkillRegistriesResponseSchema, { expectedMarketplace: "ai-marketplace" })).registries).toEqual([]);
  });
});

describe("skill events", () => {
  it("carries the epoch on the multiplexed stream", () => {
    expect(toEventView(create(EventSchema, { event: { case: "skill", value: { epoch: 12n } } }))).toEqual({ source: "skill", event: { epoch: 12 } });
  });
});

describe("skillChanges", () => {
  it.each([
    ["one change", JSON.stringify({ op: "install", kind: "skill", name: "pr-review", registry: "ai-marketplace", version: "20260305", needsSetup: true, setupScript: "install.sh" }), [{ op: "install", name: "pr-review", needsSetup: true, setupScript: "install.sh", unchanged: false }]],
    ["a list (update)", JSON.stringify([{ op: "update", kind: "plugin", name: "a", unchanged: true }, { op: "update", kind: "skill", name: "b", error: "boom" }]), [{ kind: "plugin", unchanged: true }, { kind: "skill", error: "boom" }]],
    ["not a change (a terminal)", JSON.stringify({ id: "t-1" }), []],
    ["nothing", "", []],
    ["garbage", "{", []],
  ])("%s", (_name, json, want) => {
    const got = skillChanges(json);
    expect(got).toHaveLength(want.length);
    want.forEach((w, i) => { expect(got[i]).toMatchObject(w); });
  });
});
