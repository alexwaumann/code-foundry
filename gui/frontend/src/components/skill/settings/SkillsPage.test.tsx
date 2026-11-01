import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkillView, SkillEntryView, SkillRegistryView } from "@/api/skill";
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
const { RegistriesSection } = await import("./RegistriesSection");

const RESTART = "Threads that are running keep it until they restart. New threads pick this up at once.";

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
    expect(onConfirm.mock.calls.map((c) => `${String(c[0])} ${(c[1] as InstalledSkillView).name}`)).toEqual(["disable pr-review", "uninstall pr-review", "remove my-notes"]);
    expect(m.disable).not.toHaveBeenCalled();
  });

  it("disable Run setup without a thread or project", () => {
    m.owner.value = false;
    render(<InstalledSection onConfirm={vi.fn()} />);
    expect(within(installedRow("jira-sync")).getByTestId<HTMLButtonElement>("skill-setup").disabled).toBe(true);
  });

  it("show a busy row's spinner, disable its buttons, and keep a failure until dismissed", () => {
    const key = skillItemKey("skill", "pr-review", "ai-marketplace");
    useSkillMarketplaceStore.setState({ busy: { [key]: "disable" }, failures: { [key]: { action: "disable", message: "permission denied" } } });
    render(<InstalledSection onConfirm={vi.fn()} />);
    const row = within(installedRow("pr-review"));
    expect(row.getByTestId<HTMLButtonElement>("skill-disable").disabled).toBe(true);
    expect(row.getByTestId<HTMLButtonElement>("skill-uninstall").disabled).toBe(true);
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

describe("Installed rows: what each says", () => {
  it("kind, state, source and version; a plugin's version, its update and its skills", () => {
    useSkillMarketplaceStore.setState((st) => ({
      installed: st.installed && {
        ...st.installed,
        installed: st.installed.installed.map((r) => (r.name === "pr-review" ? { ...r, by: "Code Quality Guild" } : r.name === "enterprise-data" ? { ...r, skills: ["catalog", "data-quality", "lineage", "query-warehouse"] } : r)),
      },
    }));
    render(<InstalledSection onConfirm={vi.fn()} />);
    const pr = within(installedRow("pr-review"));
    expect(pr.getByTestId("skill-kind").textContent).toBe("Skill");
    expect(pr.getByTestId("skill-state").textContent).toBe("Enabled");
    expect(pr.getByTestId("skill-source").textContent).toBe("from ai-marketplace · by Code Quality Guild");
    expect(pr.getByTestId("skill-version").textContent).toContain("20260912 · ");
    expect(within(installedRow("sql-helper")).getByTestId("skill-state").textContent).toBe("Disabled");
    expect(within(installedRow("jira-sync")).getByTestId("skill-state").textContent).toBe("Needs setup");
    expect(within(installedRow("incident-postmortem")).getByTestId("skill-update").textContent).toBe("Update to 20261016");
    // A local skill has no state.
    expect(within(installedRow("my-notes")).queryByTestId("skill-state")).toBeNull();

    const data = within(installedRow("enterprise-data"));
    expect(installedRow("enterprise-data").dataset.kind).toBe("plugin");
    expect(data.getByTestId("skill-kind").textContent).toBe("Plugin");
    expect(data.getByTestId("skill-version").textContent).toBe("1.3.2");
    expect(data.getByTestId("skill-update").textContent).toBe("Update to 1.4.0");
    fireEvent.click(data.getByTestId("skill-plugin-skills"));
    expect(data.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["catalog", "data-quality", "lineage", "query-warehouse"]);
  });

  it("Update passes the kind, and the offer goes once the row has no update", () => {
    render(<InstalledSection onConfirm={vi.fn()} />);
    fireEvent.click(within(installedRow("incident-postmortem")).getByTestId("skill-update"));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "incident-postmortem", kind: "skill" }));
    act(() => {
      useSkillMarketplaceStore.setState((st) => ({
        installed: st.installed && { ...st.installed, installed: st.installed.installed.map((r) => (r.name === "incident-postmortem" ? { ...r, update: null } : r)) },
      }));
    });
    expect(within(installedRow("incident-postmortem")).queryByTestId("skill-update")).toBeNull();
  });

  it("Run setup, off with no thread or project, says why in its tooltip", () => {
    m.owner.value = false;
    render(<InstalledSection onConfirm={vi.fn()} />);
    const wrap = within(installedRow("jira-sync")).getByTestId("skill-setup-wrap");
    // The wrapper is not focusable (the button inside is disabled): keyboard-navigation focus reaches it as an event.
    fireEvent.keyDown(document, { key: "Tab" });
    fireEvent.focus(wrap);
    expect(screen.queryByRole("tooltip")?.textContent).toBe("Select a thread or project first: setup runs in its bottom panel.");
  });
});

describe("Browse rows: what each says", () => {
  it("counts the hits, says the tier, author, keywords and installed state; a plugin's skills expand", () => {
    useSkillMarketplaceStore.setState((st) => ({
      search: st.search && { ...st.search, entries: st.search.entries.map((e) => (e.name === "sql-helper" ? { ...e, by: "Jane Doe", keywords: ["sql", "postgres"] } : e)) },
    }));
    render(<BrowseSection />);
    expect(screen.getByTestId("skill-results").textContent).toBe("3 results");
    const helper = within(entryRow("sql-helper"));
    expect(helper.getByTestId("skill-tier").textContent).toBe("Enterprise");
    expect(helper.getByTestId("skill-by").textContent).toBe("by Jane Doe");
    expect(helper.getByTestId("skill-keywords").textContent).toBe("sql · postgres");
    expect(helper.getByTestId("skill-installed-mark").textContent).toBe("Installed, disabled");
    const plugin = within(entryRow("enterprise-data"));
    expect(plugin.getByTestId("skill-browse-update").textContent).toBe("Update to 1.4.0");
    fireEvent.click(plugin.getByTestId("skill-plugin-skills"));
    expect(plugin.getAllByRole("listitem")).toHaveLength(2);
  });

  it("one hit is “1 result”; many are virtualised", () => {
    useSkillMarketplaceStore.setState((st) => ({ search: st.search && { ...st.search, entries: [entry({ name: "pandas-tips" })], total: 1 } }));
    render(<BrowseSection />);
    expect(screen.getByTestId("skill-results").textContent).toBe("1 result");
    expect(screen.getByTestId("skill-entries").dataset.virtual).toBe("false");
    cleanup();
    const many = Array.from({ length: 42 }, (_, i) => entry({ name: `skill-${String(i).padStart(2, "0")}` }));
    useSkillMarketplaceStore.setState((st) => ({ search: st.search && { ...st.search, entries: many, total: 42 } }));
    render(<BrowseSection />);
    expect(screen.getByTestId("skill-results").textContent).toBe("42 results");
    expect(screen.getByTestId("skill-entries").dataset.virtual).toBe("true");
  });

  it("nothing found names the query", () => {
    useSkillMarketplaceStore.setState((st) => ({ query: { ...st.query, text: "sql" }, search: st.search && { ...st.search, entries: [], total: 0 } }));
    render(<BrowseSection />);
    expect(screen.getByTestId("skill-results-none").textContent).toBe("Nothing matches “sql”.");
  });

  it("a chip shows pressed; one pressed while typing waits takes the text along, and the wait does not undo it", () => {
    vi.useFakeTimers();
    try {
      render(<BrowseSection />);
      const chip = screen.getByTestId("skill-chip-community");
      expect(chip.getAttribute("aria-pressed")).toBe("false");
      fireEvent.change(screen.getByTestId("skill-search"), { target: { value: "data" } });
      fireEvent.click(chip);
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      expect(m.search).toHaveBeenCalledTimes(1);
      expect(m.search).toHaveBeenLastCalledWith("data", "community", "");
      vi.advanceTimersByTime(400);
      expect(m.search).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a failed install stays under its hit until dismissed", () => {
    const key = skillItemKey("skill", "dbt-model", "ai-marketplace");
    useSkillMarketplaceStore.setState({ failures: { [key]: { action: "install", message: "~/.claude/skills/k8s-manifest exists and is not ours" } } });
    render(<BrowseSection />);
    const dbt = within(entryRow("dbt-model"));
    expect(dbt.getByTestId("skill-failure").textContent).toContain("~/.claude/skills/k8s-manifest exists and is not ours");
    fireEvent.click(dbt.getByTestId("skill-failure-dismiss"));
    expect(dbt.queryByTestId("skill-failure")).toBeNull();
  });
});

describe("the page's confirm: words and Cancel", () => {
  it("Disable names the skill with the restart warning; Cancel runs nothing", () => {
    render(<SkillsPage schema={schema} page={page} />);
    fireEvent.click(within(installedRow("pr-review")).getByTestId("skill-disable"));
    const dialog = screen.getByTestId("skill-confirm");
    expect(dialog.textContent).toContain("Disable pr-review?");
    expect(dialog.textContent).toContain(RESTART);
    fireEvent.click(screen.getByTestId("skill-confirm-cancel"));
    expect(screen.queryByTestId("skill-confirm")).toBeNull();
    expect(m.disable).not.toHaveBeenCalled();
  });

  it("Remove on a local skill says it deletes a skill you wrote, and removes it once confirmed", async () => {
    render(<SkillsPage schema={schema} page={page} />);
    fireEvent.click(within(installedRow("my-notes")).getByTestId("skill-remove"));
    const dialog = screen.getByTestId("skill-confirm");
    expect(dialog.textContent).toContain("a skill you wrote");
    expect(dialog.textContent).toContain(RESTART);
    fireEvent.click(screen.getByTestId("skill-confirm-ok"));
    await vi.waitFor(() => {
      expect(m.remove).toHaveBeenCalledWith(expect.objectContaining({ name: "my-notes" }));
    });
  });
});

describe("Registries", () => {
  const reg = (o: Partial<SkillRegistryView>): SkillRegistryView => ({
    name: "ai-marketplace",
    repo: "cof-primary/ai-marketplace",
    source: "github",
    url: "",
    ref: "",
    dir: "",
    owner: "",
    plugins: 3,
    skills: 39,
    shallow: false,
    readAtMs: Date.now() - 5 * 60_000,
    refreshedAtMs: null,
    error: "",
    issues: [],
    ...o,
  });

  it("lists each marketplace with its counts and when it was read", () => {
    useSkillMarketplaceStore.setState({ registries: { registries: [reg({})], error: "", expectedMarketplace: "ai-marketplace", epoch: 1 } });
    render(<RegistriesSection />);
    const row = screen.getByTestId("skill-registry");
    expect(row.dataset.name).toBe("ai-marketplace");
    expect(row.textContent).toContain("cof-primary/ai-marketplace");
    expect(within(row).getByTestId("skill-registry-line").textContent).toContain("3 plugins · 39 skills · read ");
  });

  it("says how to add one when Claude Code has none", () => {
    useSkillMarketplaceStore.setState({ registries: { registries: [], error: "", expectedMarketplace: "ai-marketplace", epoch: 1 } });
    render(<RegistriesSection />);
    expect(screen.getByTestId("skill-registries-none").textContent).toBe(
      "No marketplace is configured. Add your organisation's with claude plugin marketplace add <owner/repo> (for example ai-marketplace) and Refresh.",
    );
    expect(screen.queryByTestId("skill-registry")).toBeNull();
  });
});
