import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { IndexEntryView, InstallProgressView, RegistryView } from "@/api/plugin";
import { usePluginRegistryStore } from "@/stores/pluginRegistry";

const { update, install, load } = vi.hoisted(() => ({ update: vi.fn(), install: vi.fn(), load: vi.fn() }));
vi.mock("@/stores/pluginRegistry", async (orig) => ({
  ...(await orig<typeof import("@/stores/pluginRegistry")>()),
  loadBrowse: load,
  updatePlugin: update,
  installPlugin: install,
}));

const { BrowseSection } = await import("./BrowseSection");

const perms = { commands: [], events: [], threadStatus: false, sessionEnv: false, secrets: false, threads: false, terminals: false, api: false };
const entry = (o: Partial<IndexEntryView>): IndexEntryView => ({
  name: "x",
  displayName: "X",
  description: "",
  repo: "",
  version: "1.0.0",
  permissions: perms,
  permissionLines: [],
  registry: "https://github.com/o/reg",
  available: true,
  installedVersion: null,
  relation: "not-installed",
  installedFrom: "",
  ...o,
});

const row = (name: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="registry-entry"][data-plugin="${name}"]`);
  if (!el) throw new Error(`no row ${name}`);
  return el;
};

const FIXTURE = "https://github.com/alexwaumann/code-foundry-plugins";
const registry = (o: Partial<RegistryView>): RegistryView => ({ url: FIXTURE, fetchedAtMs: null, cached: false, error: "", plugins: 2, issues: [], ...o });
const step = (phase: InstallProgressView["phase"], o: Partial<InstallProgressView> = {}): InstallProgressView => ({ ref: "gh-actions", name: "gh-actions", version: "0.1.0", phase, message: "", bytes: 0, ...o });
const setBrowse = (o: { entries?: IndexEntryView[]; registries?: RegistryView[] }) => {
  act(() => {
    usePluginRegistryStore.setState((s) => ({ browse: { platform: "darwin/arm64", entries: o.entries ?? s.browse?.entries ?? [], registries: o.registries ?? s.browse?.registries ?? [] } }));
  });
};

beforeEach(() => {
  update.mockReset().mockResolvedValue(undefined);
  install.mockReset().mockResolvedValue(undefined);
  load.mockReset().mockResolvedValue(undefined);
  usePluginRegistryStore.setState({
    browse: {
      platform: "darwin/arm64",
      registries: [],
      entries: [
        entry({ name: "test-watcher", displayName: "Test Watcher", version: "0.1.0", installedVersion: "0.0.9", relation: "update" }),
        // Newer than installed, but listed by a registry it was not installed from.
        entry({ name: "acme-data", displayName: "Acme Data", version: "1.3.0", installedVersion: "1.2.0", relation: "other-source", installedFrom: "plugins.acme.dev/index.json" }),
        entry({ name: "gh-actions", displayName: "GitHub Actions", version: "0.1.0" }),
      ],
    },
    loading: false,
    error: "",
    progress: {},
    busy: {},
  });
});

afterEach(cleanup);

describe("BrowseSection", () => {
  it("offers Update only from the install source and says where another source's install came from", () => {
    render(<BrowseSection />);
    const tw = within(row("test-watcher"));
    expect(tw.getByTestId("plugin-pill").textContent).toBe("Update from 0.0.9");
    fireEvent.click(tw.getByTestId("registry-update"));
    expect(update).toHaveBeenCalledWith("test-watcher");

    const acme = within(row("acme-data"));
    expect(acme.getByTestId("plugin-pill").textContent).toBe("Installed from plugins.acme.dev/index.json");
    expect(acme.queryByTestId("registry-update")).toBeNull();
    expect(acme.queryByTestId("registry-install")).toBeNull();

    expect(within(row("gh-actions")).getByTestId("registry-install")).toBeTruthy();
  });
});

describe("BrowseSection: registries", () => {
  it("counts the plugins; Refresh reads every registry again; a failed one says so in words", () => {
    setBrowse({ registries: [registry({})] });
    render(<BrowseSection />);
    expect(load).toHaveBeenCalledWith();
    expect(screen.getByTestId("plugins-browse").textContent).toContain("3 plugins");
    const status = screen.getByTestId("registry-status");
    expect(status.dataset.error).toBeUndefined();
    expect(status.textContent).toContain("alexwaumann/code-foundry-plugins");
    expect(status.textContent).toContain("2 plugins");
    fireEvent.click(screen.getByTestId("registry-refresh"));
    expect(load).toHaveBeenLastCalledWith(true);

    setBrowse({ registries: [registry({ error: "not found: no index.json in o/r (or no access with your gh login)" })] });
    const failed = screen.getByTestId("registry-status");
    expect(failed.dataset.error).toBe("true");
    expect(failed.textContent).toContain("Not found, or your gh login cannot read it.");
  });

  it("says what a registry skipped, under it", () => {
    const loopback = "http://127.0.0.1:8765/index.json";
    setBrowse({ registries: [registry({}), registry({ url: loopback, issues: [`test-watcher: already listed by ${FIXTURE}, which comes first`] })] });
    render(<BrowseSection />);
    const second = screen.getAllByTestId("registry-status").find((r) => r.textContent.includes("127.0.0.1:8765/index.json"));
    expect(second?.textContent).toContain(`test-watcher: already listed by ${FIXTURE}, which comes first`);
  });

  it("with no registry configured: says so, lists nothing, and its link puts the caret in the setting", () => {
    setBrowse({ entries: [], registries: [] });
    // jsdom has no scrollIntoView (focusSetting brings the row into view first).
    const scroll = vi.fn();
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = scroll;
    onTestFinished(() => {
      Element.prototype.scrollIntoView = had;
    });
    render(
      <>
        <BrowseSection />
        <div data-setting="plugins.registries">
          <input aria-label="Registries" />
        </div>
      </>,
    );
    expect(screen.getByTestId("registry-none").textContent).toBe("No registry configured. Add one in Registries");
    expect(screen.queryAllByTestId("registry-entry")).toHaveLength(0);
    expect(screen.queryByTestId("registry-status")).toBeNull();
    expect(screen.queryByTestId("registry-empty")).toBeNull();
    fireEvent.click(screen.getByTestId("registry-none-link"));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Registries" }));
    expect(scroll).toHaveBeenCalled();

    // Once a registry is configured, its plugins; one that lists nothing says that.
    setBrowse({ entries: [entry({ name: "gh-actions" })], registries: [registry({})] });
    expect(screen.queryByTestId("registry-none")).toBeNull();
    expect(screen.getAllByTestId("registry-entry")).toHaveLength(1);
    setBrowse({ entries: [], registries: [registry({ url: "https://example.com/plugins/index.json", plugins: 0 })] });
    expect(screen.getByTestId("registry-empty").textContent).toBe("No plugins listed yet.");
  });

  it("a name another registry wins: installed from where it came from, no Update", () => {
    setBrowse({ entries: [entry({ name: "test-watcher", version: "0.2.0", installedVersion: "0.0.9", relation: "other-source", installedFrom: "alexwaumann/code-foundry-plugins" })] });
    render(<BrowseSection />);
    const tw = within(row("test-watcher"));
    expect(row("test-watcher").dataset.relation).toBe("other-source");
    expect(tw.getByTestId("plugin-pill").textContent).toBe("Installed from alexwaumann/code-foundry-plugins");
    expect(row("test-watcher").textContent).toContain("0.2.0");
    expect(tw.queryByTestId("registry-update")).toBeNull();
    expect(tw.queryByTestId("registry-install")).toBeNull();
  });
});

describe("BrowseSection: installing", () => {
  it("Install runs the install; the row shows each step, then Installed without the button", () => {
    render(<BrowseSection />);
    fireEvent.click(within(row("gh-actions")).getByTestId("registry-install"));
    expect(install).toHaveBeenCalledWith("gh-actions");

    act(() => {
      usePluginRegistryStore.setState({ progress: { "gh-actions": step("downloading", { bytes: 2.5 * 1024 * 1024 }) } });
    });
    const progress = () => within(row("gh-actions")).queryByTestId("registry-progress");
    expect(progress()?.dataset.phase).toBe("downloading");
    expect(progress()?.textContent).toContain("Downloading… 2.5 MB");
    act(() => {
      usePluginRegistryStore.setState({ progress: { "gh-actions": step("verifying") } });
    });
    expect(progress()?.dataset.phase).toBe("verifying");
    act(() => {
      usePluginRegistryStore.setState({ progress: {} });
    });
    expect(progress()).toBeNull();

    setBrowse({ entries: [entry({ name: "gh-actions", displayName: "GitHub Actions", version: "0.1.0", installedVersion: "0.1.0", relation: "installed" })] });
    expect(within(row("gh-actions")).getByTestId("plugin-pill").textContent).toBe("Installed");
    expect(within(row("gh-actions")).queryByTestId("registry-install")).toBeNull();
  });

  it("a failed install says the daemon's words under its row until dismissed", () => {
    usePluginRegistryStore.setState({ progress: { "gh-actions": step("failed", { message: "gh-actions: no build for darwin/arm64 in release v0.1.0" }) } });
    render(<BrowseSection />);
    const progress = within(row("gh-actions")).getByTestId("registry-progress");
    expect(progress.dataset.phase).toBe("failed");
    expect(progress.textContent).toContain("gh-actions: no build for darwin/arm64 in release v0.1.0");
    fireEvent.click(within(progress).getByTestId("registry-progress-dismiss"));
    expect(within(row("gh-actions")).queryByTestId("registry-progress")).toBeNull();
  });
});
