import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstalledSkillView, SkillEntryView, SkillRegistryView } from "@/api/skill";
import { skillItemKey } from "@/api/skill";
import { confirmPresenter } from "@/stores/confirm";
import { useSkillMarketplaceStore } from "@/stores/skill";
import { HOME, useUiStore } from "@/stores/ui";
import { resetUpdateRuns, useUpdateRunStore } from "@/stores/updateRun";
import { useViewsStore } from "@/stores/views";
import { layoutSettled, resetFakeLayout } from "@/test/fakeLayout";
import { layoutTabs } from "@/test/layoutTabs";

vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const toast = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: Object.assign(toast, { error: vi.fn(), success: vi.fn() }) }));

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

const { SkillsPage, SEARCH_DEBOUNCE_MS } = await import("./SkillsPage");

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

const groups = () => screen.getAllByTestId("catalog-group").map((g) => g.dataset.group);
const groupOf = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="catalog-group"][data-group="${id}"]`);
  if (!el) throw new Error(`no group ${id}`);
  return el;
};
const countOf = (id: string) => within(groupOf(id)).getByTestId("catalog-group-count").textContent;
const installedNames = () => [...document.querySelectorAll<HTMLElement>('[data-testid="skill-installed-row"]')].map((e) => e.dataset.name);
const hitNames = () => [...document.querySelectorAll<HTMLElement>('[data-testid="skill-entry"]')].map((e) => e.dataset.name);

/** Opens a Radix dropdown (the ⋯). */
function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

const offer = (version: string) => ({ version, lastUpdatedMs: null, commitSha: "" });

function seed(over: Partial<ReturnType<typeof useSkillMarketplaceStore.getState>> = {}) {
  useSkillMarketplaceStore.setState({
    installed: {
      installed: [
        inst({ name: "pr-review", description: "Review a pull request", by: "Code Quality Guild" }),
        inst({ name: "sql-helper", enabled: false, description: "Write SQL" }),
        inst({ name: "jira-sync", needsSetup: true, setupScript: "install.sh" }),
        inst({ name: "incident-postmortem", update: offer("20261016") }),
        inst({ name: "my-notes", state: "local", registry: "", version: "", lastUpdatedMs: 0 }),
        inst({ name: "enterprise-data", kind: "plugin", version: "1.3.2", skills: ["catalog", "lineage"], by: "Data Platform", update: offer("1.4.0") }),
        inst({ name: "gone", state: "missing" }),
      ],
      pluginsError: "",
      epoch: 1,
    },
    installedError: "",
    search: {
      entries: [
        entry({ name: "dbt-model", keywords: ["dbt", "sql"], by: "Data Platform", setupScript: "enterprise/skills/dbt-model/setup.sh" }),
        entry({ name: "sql-helper", state: "disabled", installedVersion: "20260821" }),
        entry({ name: "enterprise-data", kind: "plugin", version: "1.4.0", state: "enabled", installedVersion: "1.3.2", updateVersion: "1.4.0", skills: ["catalog", "lineage"] }),
      ],
      total: 3,
      refreshError: "",
      epoch: 1,
    },
    searchedText: "",
    searching: false,
    searchError: "",
    query: { text: "", tier: "", kind: "" },
    registries: {
      registries: [
        {
          name: "ai-marketplace",
          repo: "acme/ai-marketplace",
          source: "github",
          url: "",
          ref: "",
          dir: "/Users/dev/.claude/plugins/marketplaces/ai-marketplace",
          owner: "AI Platform",
          plugins: 3,
          skills: 1237,
          shallow: false,
          readAtMs: Date.now() - 5 * 60_000,
          refreshedAtMs: null,
          error: "",
          issues: [],
        },
      ],
      error: "",
      expectedMarketplace: "ai-marketplace",
      epoch: 1,
    },
    registriesError: "",
    refreshing: false,
    busy: {},
    failures: {},
    ...over,
  });
}

/** The store as the daemon's answer to `text` leaves it (the fake searchSkills does not answer). */
function answered(text: string, entries: SkillEntryView[], total = entries.length) {
  act(() => {
    useSkillMarketplaceStore.setState({ search: { entries, total, refreshError: "", epoch: 1 }, searchedText: text, query: { text, tier: "", kind: "" } });
  });
}

const show = (section?: string) => render(<SkillsPage schema={schema} page={page} section={section} />);
const type = (text: string) => {
  fireEvent.change(screen.getByTestId("skill-search"), { target: { value: text } });
};

beforeEach(() => {
  for (const f of [m.enable, m.disable, m.update, m.uninstall, m.remove, m.setup, m.install, m.search, m.refresh]) f.mockReset().mockResolvedValue(true);
  toast.mockReset();
  m.owner.value = true;
  resetUpdateRuns();
  seed();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the default list", () => {
  it("groups what is installed, with counts", () => {
    show();
    expect(groups()).toEqual(["needs", "enabled", "disabled"]);
    expect(countOf("needs")).toBe("4");
    expect(countOf("enabled")).toBe("2");
    expect(countOf("disabled")).toBe("1");
    expect(installedNames()).toEqual(["jira-sync", "incident-postmortem", "enterprise-data", "gone", "pr-review", "my-notes", "sql-helper"]);
    expect(hitNames()).toEqual([]);
  });

  it("the search says how many it reaches", () => {
    show();
    expect(screen.getByTestId<HTMLInputElement>("skill-search").placeholder).toBe("Search installed and the 1,240 in your marketplace");
  });

  it("a plugin's pill counts its skills; a skill has none; a local one says so, with no switch", () => {
    show();
    expect(within(installedRow("enterprise-data")).getByTestId("skill-kind").textContent).toBe("Plugin · 2");
    expect(within(installedRow("pr-review")).queryByTestId("skill-kind")).toBeNull();
    expect(within(installedRow("my-notes")).getByTestId("skill-local").textContent).toBe("Local");
    expect(within(installedRow("my-notes")).queryByTestId("skill-switch")).toBeNull();
  });

  it("a missing skill has a pill and Reinstall, and no switch", () => {
    show();
    const r = within(installedRow("gone"));
    expect(r.getByTestId("skill-state").textContent).toBe("Missing");
    expect(r.queryByTestId("skill-switch")).toBeNull();
    fireEvent.click(r.getByTestId("skill-update"));
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "gone" }));
  });

  it("Update to X runs the row's update", () => {
    show();
    const b = within(installedRow("incident-postmortem")).getByTestId("skill-update");
    expect(b.textContent).toBe("Update to 20261016");
    fireEvent.click(b);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "incident-postmortem" }));
  });

  it("Run setup runs and reveals with an owner, and says why not without one", () => {
    show();
    fireEvent.click(within(installedRow("jira-sync")).getByTestId("skill-setup"));
    expect(m.setup).toHaveBeenCalledWith(expect.objectContaining({ name: "jira-sync" }), { reveal: true });
    cleanup();
    m.owner.value = false;
    show();
    const r = within(installedRow("jira-sync"));
    expect(r.getByTestId<HTMLButtonElement>("skill-setup").disabled).toBe(true);
    expect(r.getByTestId("skill-setup-wrap")).toBeTruthy();
  });

  it("the chevron opens everything the row used to say, in place", () => {
    show();
    const r = within(installedRow("enterprise-data"));
    expect(r.queryByTestId("catalog-details")).toBeNull();
    fireEvent.click(r.getByTestId("catalog-chevron"));
    expect(r.getByTestId("skill-source").textContent).toBe("from ai-marketplace · by Data Platform · 1.3.2, 1.4.0 available");
    expect(r.getByTestId("skill-plugin-skills").textContent).toBe("Skills: catalog, lineage");
    fireEvent.click(r.getByTestId("catalog-chevron"));
    expect(r.queryByTestId("catalog-details")).toBeNull();
  });

  it("a missing row's details say what its actions do", () => {
    show();
    const r = within(installedRow("gone"));
    fireEvent.click(r.getByTestId("catalog-chevron"));
    expect(r.getByTestId("catalog-details").textContent).toContain("Its directory is gone. Reinstall puts it back; Uninstall forgets it.");
  });

  it("the Plugins and Skills chips filter the list", () => {
    show();
    fireEvent.click(screen.getByTestId("skill-chip-plugin"));
    expect(installedNames()).toEqual(["enterprise-data"]);
    expect(m.search).toHaveBeenLastCalledWith("", "", "plugin");
  });

  it("says when nothing is installed, and what it could not read", () => {
    seed({ installed: { installed: [], pluginsError: "boom", epoch: 1 } });
    show();
    expect(screen.getByTestId("skills-installed-none").textContent).toContain("Browse all");
    expect(screen.getByTestId("skill-plugins-error").textContent).toContain("boom");
    cleanup();
    seed({ installed: null, installedError: "no daemon" });
    show();
    expect(screen.getByTestId("skill-installed-error").textContent).toContain("no daemon");
    expect(screen.queryByTestId("skills-loading")).toBeNull();
  });

  it("a failed refresh stays on the page", () => {
    seed();
    act(() => {
      const s = useSkillMarketplaceStore.getState().search;
      useSkillMarketplaceStore.setState({ search: s && { ...s, refreshError: "offline" } });
    });
    show();
    expect(screen.getByTestId("skill-refresh-error").textContent).toBe("The refresh failed, so this is the last read: offline");
  });
});

describe("the switch", () => {
  const sw = (name: string) => within(installedRow(name)).getByTestId<HTMLButtonElement>("skill-switch");

  it("disabling flips with no confirm and warns in a toast", async () => {
    show();
    fireEvent.click(sw("pr-review"));
    expect(screen.queryByTestId("skill-confirm")).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.disable).toHaveBeenCalledWith(expect.objectContaining({ name: "pr-review" }), { quiet: true });
    expect(toast).toHaveBeenCalledWith("Disabled pr-review", expect.objectContaining({ description: RESTART }));
  });

  it("enabling runs at once, with no toast of its own", async () => {
    show();
    fireEvent.click(sw("sql-helper"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.enable).toHaveBeenCalledWith(expect.objectContaining({ name: "sql-helper" }));
    expect(toast).not.toHaveBeenCalled();
  });

  it.each([
    ["disable", "pr-review", "false"],
    ["enable", "sql-helper", "true"],
  ] as const)("shows what %s asks for, busy, while it runs", (action, name, checked) => {
    seed({ busy: { [skillItemKey("skill", name, "ai-marketplace")]: action } });
    show();
    expect(sw(name).getAttribute("aria-checked")).toBe(checked);
    expect(sw(name).disabled).toBe(true);
    expect(sw(name).dataset.busy).toBe("true");
  });

  it("waits while the row does something else, and that action's own button is the one spinning", () => {
    seed({ busy: { [skillItemKey("skill", "pr-review", "ai-marketplace")]: "uninstall", [skillItemKey("skill", "jira-sync", "ai-marketplace")]: "disable" } });
    show();
    expect(sw("pr-review").disabled).toBe(true);
    expect(sw("pr-review").dataset.busy).toBeUndefined();
    const setup = within(installedRow("jira-sync")).getByTestId<HTMLButtonElement>("skill-setup");
    expect(setup.disabled).toBe(true);
    expect(setup.querySelector(".animate-spin")).toBeNull();
  });

  it("back from a failure it reads what is true, with the failure under the row", () => {
    const key = skillItemKey("skill", "pr-review", "ai-marketplace");
    seed({ failures: { [key]: { action: "disable", message: "it is in use" } } });
    show();
    expect(sw("pr-review").getAttribute("aria-checked")).toBe("true");
    expect(within(installedRow("pr-review")).getByTestId("skill-failure").textContent).toContain("it is in use");
  });
});

describe("a row's menu", () => {
  it("Uninstall asks with the restart warning, then runs without the daemon asking again", async () => {
    let answered: boolean | undefined;
    m.uninstall.mockImplementation(async () => {
      answered = await confirmPresenter("skill.uninstall")?.({ name: "skill.uninstall", args: { name: "pr-review" }, message: "" } as never);
      return true;
    });
    show();
    openMenu(within(installedRow("pr-review")).getByTestId("skill-row-menu"));
    fireEvent.click(await screen.findByTestId("skill-menu-uninstall"));
    const dialog = await screen.findByTestId("skill-confirm");
    expect(dialog.dataset.action).toBe("uninstall");
    expect(dialog.textContent).toContain(RESTART);
    fireEvent.click(within(dialog).getByTestId("skill-confirm-ok"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(m.uninstall).toHaveBeenCalledWith(expect.objectContaining({ name: "pr-review" }));
    await vi.waitFor(() => {
      expect(answered).toBe(true);
    });
  });

  it("a row being uninstalled says so, its switch and menu holding still", async () => {
    seed({ busy: { [skillItemKey("skill", "pr-review", "ai-marketplace")]: "uninstall" } });
    show();
    const r = within(installedRow("pr-review"));
    expect(r.getByTestId("catalog-working").textContent).toBe("Uninstalling…");
    openMenu(r.getByTestId("skill-row-menu"));
    expect((await screen.findByTestId("skill-menu-uninstall")).getAttribute("data-disabled")).not.toBeNull();
  });

  it("a local skill's Remove says it deletes the folder", async () => {
    show();
    openMenu(within(installedRow("my-notes")).getByTestId("skill-row-menu"));
    fireEvent.click(await screen.findByTestId("skill-menu-remove"));
    expect((await screen.findByTestId("skill-confirm")).textContent).toContain("/Users/dev/.claude/skills/my-notes");
  });

  it("right-click opens the same menu", async () => {
    show();
    fireEvent.contextMenu(installedRow("pr-review"));
    const menu = await screen.findByTestId("skill-row-menu-context");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["View SKILL.md", "Uninstall"]);
  });

  it("View SKILL.md opens the file in a tab and closes Settings", async () => {
    await resetFakeLayout("empty");
    useUiStore.setState({ selection: HOME });
    useViewsStore.setState({ settingsOpen: true });
    show();
    openMenu(within(installedRow("pr-review")).getByTestId("skill-row-menu"));
    fireEvent.click(await screen.findByTestId("skill-menu-view"));
    await vi.waitFor(() => {
      expect(useViewsStore.getState().settingsOpen).toBe(false);
    });
    await act(async () => {
      await layoutSettled();
    });
    const tab = layoutTabs().find((t) => t.kind === "file");
    expect(tab?.params).toMatchObject({ project: "", path: "/Users/dev/.claude/skills/pr-review/SKILL.md" });
  });
});

describe("Update all", () => {
  const button = () => screen.getByTestId<HTMLButtonElement>("skill-update-all");

  it("shows only with more than one update", () => {
    show();
    expect(button().textContent).toBe("Update all 2");
    cleanup();
    seed({ installed: { installed: [inst({ name: "a", update: offer("2") }), inst({ name: "b", state: "missing", update: offer("2") })], pluginsError: "", epoch: 1 } });
    show();
    expect(screen.queryByTestId("skill-update-all")).toBeNull();
  });

  it("runs the rows' own updates one at a time, quietly, and says how far it is", async () => {
    const finish: ((ok: boolean) => void)[] = [];
    m.update.mockImplementation(() => new Promise((r) => finish.push(r)));
    show();
    fireEvent.click(button());
    await vi.waitFor(() => {
      expect(button().textContent).toBe("Updating 1 of 2…");
    });
    expect(button().disabled).toBe(true);
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "incident-postmortem" }), { quiet: true });
    await act(async () => {
      finish[0]?.(true);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(button().textContent).toBe("Updating 2 of 2…");
    });
    expect(m.update).toHaveBeenCalledTimes(2);
    await act(async () => {
      finish[1]?.(false);
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(useUpdateRunStore.getState().skills.running).toBe(false);
    });
    expect(useUpdateRunStore.getState().skills.updated).toEqual({ "skill:incident-postmortem": "20261016" });
  });

  it("a finished row stays in Needs you reading Updated to X, once the re-read has taken its update away", () => {
    useUpdateRunStore.setState({ skills: { running: false, at: 2, total: 2, updated: { "skill:pr-review": "20261016" } } });
    show();
    // Opening the page forgets a finished run: this is the same run seen while the page is open.
    act(() => {
      useUpdateRunStore.setState({ skills: { running: false, at: 2, total: 2, updated: { "skill:pr-review": "20261016" } } });
    });
    expect(groupOf("needs")).toBeTruthy();
    expect(within(installedRow("pr-review")).getByTestId("skill-updated").textContent).toBe("Updated to 20261016");
    expect(countOf("needs")).toBe("5");
  });

  it("a failed row offers Retry update with the failure under it", () => {
    const key = skillItemKey("skill", "incident-postmortem", "ai-marketplace");
    seed({ failures: { [key]: { action: "update", message: "could not reach the marketplace" } } });
    show();
    const r = within(installedRow("incident-postmortem"));
    expect(r.getByTestId("skill-update").textContent).toBe("Retry update");
    expect(r.getByTestId("skill-failure").textContent).toContain("could not reach the marketplace");
  });

  it("a row updating says so", () => {
    seed({ busy: { [skillItemKey("skill", "incident-postmortem", "ai-marketplace")]: "update" } });
    show();
    const b = within(installedRow("incident-postmortem")).getByTestId<HTMLButtonElement>("skill-update");
    expect(b.textContent).toBe("Updating…");
    expect(b.disabled).toBe(true);
  });
});

describe("searching", () => {
  it("filters Installed at once and asks the daemon after the debounce", () => {
    vi.useFakeTimers();
    show();
    type("review");
    expect(installedNames()).toEqual(["pr-review"]);
    expect(m.search).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(m.search).toHaveBeenCalledWith("review", "", "");
  });

  it("does not take the whole marketplace for the answer to its first words", () => {
    show();
    type("sql");
    expect(hitNames()).toEqual([]);
    expect(within(groupOf("market")).getByTestId("catalog-group-note").textContent).toBe("Searching…");
    expect(screen.queryByTestId("skill-results-none")).toBeNull();
  });

  it("lists the marketplace's hits after what is installed, without showing a row twice", () => {
    show();
    type("sql");
    answered("sql", [entry({ name: "dbt-model" }), entry({ name: "sql-helper", state: "disabled" }), entry({ name: "sql-formatter", tier: "community" })]);
    expect(groups()).toEqual(["installed", "market"]);
    expect(installedNames()).toEqual(["sql-helper"]);
    expect(hitNames()).toEqual(["dbt-model", "sql-formatter"]);
    expect(countOf("installed")).toBe("1");
    expect(countOf("market")).toBe("2");
  });

  it("Enterprise and Community sit in the marketplace's header and search at once", () => {
    show();
    type("sql");
    answered("sql", [entry({ name: "dbt-model" })]);
    fireEvent.click(within(groupOf("market")).getByTestId("skill-chip-community"));
    expect(m.search).toHaveBeenLastCalledWith("sql", "community", "");
  });

  it("nothing anywhere is one line", () => {
    show();
    type("kubectl");
    answered("kubectl", []);
    expect(screen.getByTestId("skill-results-none").textContent).toBe("Nothing installed or in your marketplace matches “kubectl”.");
    expect(screen.queryByTestId("catalog-group")).toBeNull();
  });

  it("nothing with a tier chip on keeps the header, or the chip could not be turned off", () => {
    show();
    type("kubectl");
    answered("kubectl", []);
    act(() => {
      useSkillMarketplaceStore.setState({ query: { text: "kubectl", tier: "", kind: "" } });
    });
    cleanup();
    seed({ query: { text: "kubectl", tier: "community", kind: "" }, searchedText: "kubectl", search: { entries: [], total: 0, refreshError: "", epoch: 1 } });
    show();
    expect(within(groupOf("market")).getByTestId("skill-chip-community").dataset.on).toBe("true");
    expect(screen.getByTestId("skill-results-none").textContent).toBe("Nothing in your marketplace matches “kubectl”.");
  });

  it("hits that are all installed rows above are no marketplace group, and no “nothing”", () => {
    show();
    type("sql");
    answered("sql", [entry({ name: "sql-helper", state: "disabled" })]);
    expect(groups()).toEqual(["installed"]);
    expect(screen.queryByTestId("skill-results-none")).toBeNull();
  });

  it("the search's failure is in words; Installed still answers", () => {
    seed({ searchError: "daemon gone" });
    show();
    expect(screen.queryByTestId("skill-search-error")).toBeNull();
    type("review");
    expect(screen.getByTestId("skill-search-error").textContent).toBe("The search failed: daemon gone");
    expect(installedNames()).toEqual(["pr-review"]);
  });

  it("Escape and the × clear it", () => {
    show();
    type("review");
    fireEvent.keyDown(screen.getByTestId("skill-search"), { key: "Escape" });
    expect(screen.getByTestId<HTMLInputElement>("skill-search").value).toBe("");
    type("review");
    fireEvent.click(screen.getByTestId("skill-search-clear"));
    expect(screen.getByTestId<HTMLInputElement>("skill-search").value).toBe("");
  });

  it("a hit opens too: who by, its keywords, what installing leaves to do", () => {
    show();
    fireEvent.click(screen.getByTestId("skill-browse-all"));
    const r = within(entryRow("dbt-model"));
    fireEvent.click(r.getByTestId("catalog-chevron"));
    expect(r.getByTestId("skill-source").textContent).toContain("from ai-marketplace · by Data Platform · 20260912");
    expect(r.getByTestId("skill-keywords").textContent).toBe("dbt · sql · needs setup after installing");
  });
});

describe("Browse all", () => {
  const browse = () => {
    fireEvent.click(screen.getByTestId("skill-browse-all"));
  };

  it("counts every match, and its last line asks for the next page until none is left", () => {
    show();
    browse();
    const hits = useSkillMarketplaceStore.getState().search?.entries ?? [];
    answered("", hits, 1240);
    expect(screen.getByTestId("skill-more").textContent).toBe("Loading more…");
    answered("", hits);
    expect(screen.queryByTestId("skill-more")).toBeNull();
  });

  it("says why the next page failed and offers another try", () => {
    show();
    browse();
    answered("", useSkillMarketplaceStore.getState().search?.entries ?? [], 1240);
    act(() => {
      useSkillMarketplaceStore.setState({ loadMoreError: "daemon gone" });
    });
    expect(screen.getByTestId("skill-more").textContent).toContain("The next results did not load: daemon gone");
    expect(screen.getByTestId("skill-more-retry").textContent).toBe("Try again");
  });

  it("is the marketplace alone, with no query, pressed and counted", () => {
    show();
    browse();
    expect(groups()).toEqual(["market"]);
    expect(installedNames()).toEqual([]);
    expect(hitNames()).toEqual(["dbt-model", "sql-helper", "enterprise-data"]);
    const b = screen.getByTestId("skill-browse-all");
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.textContent).toContain("1,240");
    expect(screen.getByTestId<HTMLInputElement>("skill-search").placeholder).toBe("Search the marketplace");
  });

  it("offers Install, Update to X or Installed", () => {
    show();
    browse();
    fireEvent.click(within(entryRow("dbt-model")).getByTestId("skill-install"));
    expect(m.install).toHaveBeenCalledWith(expect.objectContaining({ name: "dbt-model" }));
    const update = within(entryRow("enterprise-data")).getByTestId("skill-browse-update");
    expect(update.textContent).toBe("Update to 1.4.0");
    fireEvent.click(update);
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ name: "enterprise-data" }));
    expect(within(entryRow("sql-helper")).getByTestId("skill-installed-mark").textContent).toBe("Installed, disabled");
  });

  it("a plugin's pill counts its skills; a tier pill says where it sits", () => {
    show();
    browse();
    expect(within(entryRow("enterprise-data")).getByTestId("skill-kind").textContent).toBe("Plugin · 2");
    expect(within(entryRow("dbt-model")).getByTestId("skill-tier").textContent).toBe("Enterprise");
  });

  it("searching in it searches only the marketplace", () => {
    show();
    browse();
    type("sql");
    answered("sql", [entry({ name: "sql-helper", state: "disabled" })]);
    expect(groups()).toEqual(["market"]);
    expect(hitNames()).toEqual(["sql-helper"]);
    expect(countOf("market")).toBe("1");
  });

  it("an install that failed says so under its row", () => {
    const key = skillItemKey("skill", "dbt-model", "ai-marketplace");
    seed({ failures: { [key]: { action: "install", message: "no such skill" } } });
    show();
    browse();
    expect(within(entryRow("dbt-model")).getByTestId("skill-failure").textContent).toContain("no such skill");
  });

  it("an empty marketplace points at Registries", async () => {
    seed({ search: { entries: [], total: 0, refreshError: "", epoch: 1 }, registries: { registries: [], error: "", expectedMarketplace: "ai-marketplace", epoch: 1 } });
    show();
    browse();
    fireEvent.click(screen.getByTestId("skill-registries-link"));
    expect((await screen.findByTestId("skill-registries-none")).textContent).toContain("claude plugin marketplace add");
  });
});

describe("the page menu", () => {
  it("says when the marketplaces were read and what they hold", async () => {
    show();
    openMenu(screen.getByTestId("skill-menu"));
    expect((await screen.findByTestId("skill-refresh-hint")).textContent).toBe("Read 5m ago");
    expect(screen.getByTestId("skill-registries-open-hint").textContent).toBe("ai-marketplace · 3 plugins · 1,237 skills");
  });

  it("Refresh marketplaces refreshes; a refresh running says so and cannot be run twice", async () => {
    show();
    openMenu(screen.getByTestId("skill-menu"));
    fireEvent.click(await screen.findByTestId("skill-refresh"));
    await vi.waitFor(() => {
      expect(m.refresh).toHaveBeenCalled();
    });
    cleanup();
    seed({ refreshing: true });
    show();
    openMenu(screen.getByTestId("skill-menu"));
    expect((await screen.findByTestId("skill-refresh-hint")).textContent).toBe("Refreshing…");
    expect((await screen.findByTestId("skill-refresh")).getAttribute("data-disabled")).not.toBeNull();
  });

  it("Registries opens the marketplaces in a dialog", async () => {
    show();
    openMenu(screen.getByTestId("skill-menu"));
    fireEvent.click(await screen.findByTestId("skill-registries-open"));
    const dialog = await screen.findByTestId("skill-registries");
    expect(within(dialog).getByTestId("skill-registry-line").textContent).toContain("3 plugins · 1,237 skills");
  });

  it.each([
    ["registries", () => screen.queryByTestId("skill-registries") !== null],
    ["browse", () => screen.getByTestId("skill-browse-all").getAttribute("aria-pressed") === "true"],
  ])("a settings search hit on %s lands on it", (section, landed) => {
    show(section);
    expect(landed()).toBe(true);
  });

  it("what a marketplace's read skipped and its failures stay in words", () => {
    const r = useSkillMarketplaceStore.getState().registries?.registries[0] as SkillRegistryView;
    seed({ registries: { registries: [{ ...r, error: "not a git repo", issues: ["skipped x"], shallow: true }], error: "list failed", expectedMarketplace: "ai-marketplace", epoch: 1 } });
    show("registries");
    expect(screen.getByTestId("skill-registry-error").textContent).toContain("not a git repo");
    expect(screen.getByTestId("skill-registry-issue").textContent).toBe("skipped x");
    expect(screen.getByTestId("skill-registry-shallow")).toBeTruthy();
    expect(screen.getByTestId("skill-registries-list-error").textContent).toContain("list failed");
  });
});
