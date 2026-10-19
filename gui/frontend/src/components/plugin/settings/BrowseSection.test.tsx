import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexEntryView } from "@/api/plugin";
import { usePluginRegistryStore } from "@/stores/pluginRegistry";

const update = vi.hoisted(() => vi.fn());
vi.mock("@/stores/pluginRegistry", async (orig) => ({
  ...(await orig<typeof import("@/stores/pluginRegistry")>()),
  loadBrowse: vi.fn(() => Promise.resolve()),
  updatePlugin: update,
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

beforeEach(() => {
  update.mockReset().mockResolvedValue(undefined);
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
