import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkillView, SkillEntryView } from "@/api/skill";
import { skillItemKey } from "@/api/skill";
import { confirmPresenter } from "@/stores/confirm";
import { useSkillMarketplaceStore } from "@/stores/skill";

const m = vi.hoisted(() => ({
  enable: vi.fn(),
  disable: vi.fn(),
  update: vi.fn(),
  uninstall: vi.fn(),
  remove: vi.fn(),
  setup: vi.fn(),
  install: vi.fn(),
  search: vi.fn(),
  refresh: vi.fn(),
  owner: { value: true },
}));
vi.mock("@/stores/skill", async (orig) => ({
  ...(await orig<typeof import("@/stores/skill")>()),
  openSkillMarketplace: () => () => undefined,
  enableSkill: m.enable,
  disableSkill: m.disable,
  updateSkill: m.update,
  uninstallSkill: m.uninstall,
  removeLocalSkill: m.remove,
  runSkillSetup: m.setup,
  installSkill: m.install,
  searchSkills: m.search,
  refreshSkillMarketplaces: m.refresh,
  canRunSetup: () => m.owner.value,
}));

const { InstalledSection } = await import("./InstalledSection");
const { BrowseSection } = await import("./BrowseSection");
const { SkillsPage } = await import("./SkillsPage");

function inst(o: Partial<InstalledSkillView> & { name: string }): InstalledSkillView {
  const kind = o.kind ?? "skill";
  const registry = o.registry ?? "ai-marketplace";
  return {
    key: skillItemKey(kind, o.name, registry),
    kind,
    id: o.name,
    registry,
    path: "",
    tier: "enterprise",
    description: "",
    by: "",
    version: "20260912",
    lastUpdatedMs: Date.parse("2026-09-12T10:00:00Z"),
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

function entry(o: Partial<SkillEntryView> & { name: string }): SkillEntryView {
  const kind = o.kind ?? "skill";
  return {
    key: skillItemKey(kind, o.name, "ai-marketplace"),
    kind,
    tier: "enterprise",
    description: "",
    by: "",
    version: "20260912",
    declaredVersion: "",
    lastUpdatedMs: Date.parse("2026-09-12T10:00:00Z"),
    registry: "ai-marketplace",
    path: "",
    keywords: [],
    skills: [],
    setupScript: "",
    state: "not-installed",
    installedVersion: "",
    updateVersion: "",
    ...o,
  };
}

const page = { id: "skills", title: "Skills", description: "", sections: [] };
const schema = { groups: [], pages: [], fields: [] } as unknown as Parameters<typeof SkillsPage>[0]["schema"];

const installedRow = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="skill-installed-row"][data-name="${name}"]`);
  if (!el) throw new Error(`no row ${name}`);
  return el;
};
const entryRow = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="skill-entry"][data-name="${name}"]`);
  if (!el) throw new Error(`no entry ${name}`);
  return el;
};

beforeEach(() => {
  for (const f of [m.enable, m.disable, m.update, m.uninstall, m.remove, m.setup, m.install, m.search, m.refresh]) f.mockReset().mockResolvedValue(true);
  m.owner.value = true;
  useSkillMarketplaceStore.setState({
    installed: {
      installed: [
        inst({ name: "pr-review" }),
        inst({ name: "sql-helper", enabled: false }),
        inst({ name: "jira-sync", needsSetup: true, setupScript: "install.sh" }),
        inst({ name: "incident-postmortem", update: { version: "20261016", lastUpdatedMs: null, commitSha: "abc" } }),
        inst({ name: "my-notes", state: "local", registry: "", version: "", lastUpdatedMs: 0 }),
        inst({ name: "enterprise-data", kind: "plugin", version: "1.3.2", skills: ["catalog", "lineage"], update: { version: "1.4.0", lastUpdatedMs: null, commitSha: "" } }),
        inst({ name: "gone", state: "missing" }),
      ],
      pluginsError: "",
      epoch: 1,
    },
    installedError: "",
    search: {
      entries: [
        entry({ name: "dbt-model", keywords: ["dbt", "sql"], by: "Data Platform" }),
        entry({ name: "sql-helper", state: "disabled", installedVersion: "20260821" }),
        entry({ name: "enterprise-data", kind: "plugin", version: "1.4.0", state: "enabled", installedVersion: "1.3.2", updateVersion: "1.4.0", skills: ["catalog", "lineage"] }),
      ],
      total: 3,
      refreshError: "",
      epoch: 1,
    },
    busy: {},
    failures: {},
  });
});

afterEach(cleanup);

describe("Installed rows", () => {
  it("offer each state's actions and run them", () => {
    render(<InstalledSection onConfirm={vi.fn()} />);
    const buttons = (name: string) => within(installedRow(name)).getAllByRole("button").map((b) => b.textContent);
    expect(buttons("pr-review")).toEqual(["Disable", "Uninstall"]);
    expect(buttons("sql-helper")).toEqual(["Enable", "Uninstall"]);
    expect(buttons("jira-sync")).toEqual(["Disable", "Run setup", "Uninstall"]);
    expect(buttons("incident-postmortem")).toEqual(["Disable", "Update to 20261016", "Uninstall"]);
    expect(buttons("my-notes")).toEqual(["Remove"]);
    expect(buttons("gone")).toEqual(["Reinstall", "Uninstall"]);
    expect(within(installedRow("gone")).getByTestId("skill-state").textContent).toBe("Missing");
    expect(within(installedRow("my-notes")).getByTestId("skill-source").textContent).toBe("Local");

    fireEvent.click(within(installedRow("sql-helper")).getByTestId("skill-enable"));
    expect(m.enable).toHaveBeenCalledWith(expect.objectContaining({ name: "sql-helper", kind: "skill" }));
    fireEvent.click(within(installedRow("incident-postmortem")).getByTestId("skill-update"));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "incident-postmortem" }));
    fireEvent.click(within(installedRow("jira-sync")).getByTestId("skill-setup"));
    expect(m.setup).toHaveBeenCalledWith(expect.objectContaining({ name: "jira-sync" }), { reveal: true });
  });

  it("send Disable, Uninstall and Remove to the confirm instead of running them", () => {
    const onConfirm = vi.fn();
    render(<InstalledSection onConfirm={onConfirm} />);
    fireEvent.click(within(installedRow("pr-review")).getByTestId("skill-disable"));
    fireEvent.click(within(installedRow("pr-review")).getByTestId("skill-uninstall"));
    fireEvent.click(within(installedRow("my-notes")).getByTestId("skill-remove"));
    expect(onConfirm.mock.calls.map(([a, r]: [string, InstalledSkillView]) => `${a} ${r.name}`)).toEqual(["disable pr-review", "uninstall pr-review", "remove my-notes"]);
    expect(m.disable).not.toHaveBeenCalled();
  });

  it("disable Run setup without a thread or project", () => {
    m.owner.value = false;
    render(<InstalledSection onConfirm={vi.fn()} />);
    expect((within(installedRow("jira-sync")).getByTestId("skill-setup") as HTMLButtonElement).disabled).toBe(true);
  });

  it("show a busy row's spinner, disable its buttons, and keep a failure until dismissed", () => {
    const key = skillItemKey("skill", "pr-review", "ai-marketplace");
    useSkillMarketplaceStore.setState({ busy: { [key]: "disable" }, failures: { [key]: { action: "disable", message: "permission denied" } } });
    render(<InstalledSection onConfirm={vi.fn()} />);
    const row = within(installedRow("pr-review"));
    expect((row.getByTestId("skill-disable") as HTMLButtonElement).disabled).toBe(true);
    expect((row.getByTestId("skill-uninstall") as HTMLButtonElement).disabled).toBe(true);
    expect(row.getByTestId("skill-failure").textContent).toContain("permission denied");
    fireEvent.click(row.getByTestId("skill-failure-dismiss"));
    expect(useSkillMarketplaceStore.getState().failures[key]).toBeUndefined();
  });

  it("expand a plugin's skills", () => {
    render(<InstalledSection onConfirm={vi.fn()} />);
    const row = within(installedRow("enterprise-data"));
    expect(row.queryByTestId("skill-plugin-skill-list")).toBeNull();
    fireEvent.click(row.getByTestId("skill-plugin-skills"));
    expect(row.getByTestId("skill-plugin-skill-list").textContent).toBe("cataloglineage");
  });

  it("say so when nothing is installed", () => {
    useSkillMarketplaceStore.setState({ installed: { installed: [], pluginsError: "", epoch: 1 } });
    const { getByTestId } = render(<InstalledSection onConfirm={vi.fn()} />);
    expect(getByTestId("skills-installed-none").textContent).toContain("Nothing installed yet");
  });
});

describe("Browse rows", () => {
  it("offer Install, Update to X or say Installed", () => {
    render(<BrowseSection />);
    fireEvent.click(within(entryRow("dbt-model")).getByTestId("skill-install"));
    expect(m.install).toHaveBeenCalledWith(expect.objectContaining({ name: "dbt-model", kind: "skill" }));
    expect(within(entryRow("sql-helper")).getByTestId("skill-installed-mark").textContent).toBe("Installed, disabled");
    fireEvent.click(within(entryRow("enterprise-data")).getByTestId("skill-browse-update"));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "enterprise-data", kind: "plugin" }));
    expect(within(entryRow("dbt-model")).getByTestId("skill-keywords").textContent).toBe("dbt · sql");
    expect(within(entryRow("dbt-model")).getByTestId("skill-by").textContent).toBe("by Data Platform");
  });

  it("chips search at once with the tier and kind", () => {
    const { getByTestId } = render(<BrowseSection />);
    fireEvent.click(getByTestId("skill-chip-community"));
    expect(m.search).toHaveBeenLastCalledWith("", "community", "");
    fireEvent.click(getByTestId("skill-chip-plugin"));
    expect(m.search).toHaveBeenLastCalledWith("", "community", "plugin");
    fireEvent.click(getByTestId("skill-chip-enterprise"));
    expect(m.search).toHaveBeenLastCalledWith("", "", "plugin");
  });

  it("typing waits for the debounce", () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(<BrowseSection />);
      fireEvent.change(getByTestId("skill-search"), { target: { value: "s" } });
      fireEvent.change(getByTestId("skill-search"), { target: { value: "sq" } });
      vi.advanceTimersByTime(100);
      expect(m.search).not.toHaveBeenCalled();
      vi.advanceTimersByTime(60);
      expect(m.search).toHaveBeenCalledTimes(1);
      expect(m.search).toHaveBeenLastCalledWith("sq", "", "");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the page's confirm", () => {
  it("runs the action once confirmed and answers the daemon's confirm for that call", async () => {
    let answered: boolean | null = null;
    m.disable.mockImplementation(async () => {
      answered = await confirmPresenter("skill.disable")?.({ title: "", message: "", confirmLabel: "", command: "skill.disable", args: { name: "pr-review", kind: "skill" } }) ?? null;
      return true;
    });
    const { getByTestId, queryByTestId } = render(<SkillsPage schema={schema} page={page} />);
    fireEvent.click(within(installedRow("pr-review")).getByTestId("skill-disable"));
    expect(getByTestId("skill-confirm").textContent).toContain("Threads that are running keep it until they restart.");
    fireEvent.click(getByTestId("skill-confirm-ok"));
    expect(queryByTestId("skill-confirm")).toBeNull();
    await vi.waitFor(() => {
      expect(answered).toBe(true);
    });
  });
});
