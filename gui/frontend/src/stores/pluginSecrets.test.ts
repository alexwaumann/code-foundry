import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ listPluginSecrets: vi.fn(), runCommandForResult: vi.fn() }));
vi.mock("@/api/plugin", () => ({ listPluginSecrets: api.listPluginSecrets }));
vi.mock("./commands", () => ({ runCommandForResult: api.runCommandForResult }));

const { deletePluginSecret, loadPluginSecrets, usePluginSecretsStore } = await import("./pluginSecrets");

beforeEach(() => {
  usePluginSecretsStore.setState({ byName: {} });
  api.listPluginSecrets.mockReset();
  api.runCommandForResult.mockReset();
});

describe("plugin secrets", () => {
  it("reads a plugin's secret names", async () => {
    api.listPluginSecrets.mockResolvedValue([{ key: "token", updatedAtMs: 5 }]);
    await loadPluginSecrets("acme");
    expect(usePluginSecretsStore.getState().byName.acme).toEqual({ list: [{ key: "token", updatedAtMs: 5 }], error: "" });
  });

  it("keeps the last list and says why a read failed", async () => {
    api.listPluginSecrets.mockResolvedValueOnce([{ key: "token", updatedAtMs: 5 }]).mockRejectedValueOnce(new Error("keychain locked"));
    await loadPluginSecrets("acme");
    await loadPluginSecrets("acme");
    const e = usePluginSecretsStore.getState().byName.acme;
    expect(e?.list).toHaveLength(1);
    expect(e?.error).toContain("keychain locked");
  });

  it.each([
    ["deleted", { message: "deleted" }, true],
    ["declined or failed", null, false],
  ])("delete runs plugin.secrets.delete and reads the list again (%s)", async (_name, result, want) => {
    api.runCommandForResult.mockResolvedValue(result);
    api.listPluginSecrets.mockResolvedValue([]);
    await expect(deletePluginSecret("acme", "token")).resolves.toBe(want);
    expect(api.runCommandForResult).toHaveBeenCalledWith("plugin.secrets.delete", { name: "acme", key: "token" }, { quiet: true });
    expect(api.listPluginSecrets).toHaveBeenCalledTimes(1);
    expect(usePluginSecretsStore.getState().byName.acme?.list).toEqual([]);
  });
});
