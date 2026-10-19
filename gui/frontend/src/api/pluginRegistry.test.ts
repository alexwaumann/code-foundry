import { create, toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it } from "vitest";
import { BrowsePluginsResponseSchema, InstallPluginResponseSchema, PluginEventSchema, PluginIndexRelation, PluginInstallPhase, PluginSchema } from "@/gen/codefoundry/v1/plugin_pb";
import { installOutcome, toBrowse, toPluginEventView, toPluginView } from "./plugin";

describe("registry mapping", () => {
  it("maps Browse: entries with what is installed, registries with their state", () => {
    const v = toBrowse(
      create(BrowsePluginsResponseSchema, {
        platform: "darwin/arm64",
        entries: [
          {
            name: "gh-actions",
            displayName: "",
            version: "0.1.0",
            repo: "o/gh-actions",
            registry: "https://github.com/o/reg",
            available: true,
            permissions: { commands: ["thread.send"], threadStatus: true },
            permissionLines: ["run Code Foundry commands: thread.send"],
            installed: { name: "gh-actions", version: "0.0.9" },
            updateAvailable: true,
            relation: PluginIndexRelation.UPDATE,
          },
          { name: "solo", version: "1.0.0" },
          {
            name: "acme-data",
            version: "1.3.0",
            installed: { name: "acme-data", version: "1.2.0" },
            relation: PluginIndexRelation.OTHER_SOURCE,
            installedFrom: "plugins.acme.dev/index.json",
          },
        ],
        registries: [{ url: "https://github.com/o/reg", fetchedAt: timestampFromMs(5000), cached: true, plugins: 2, error: "", issues: ["x"] }],
      }),
    );
    expect(v.platform).toBe("darwin/arm64");
    expect(v.entries[0]).toMatchObject({
      name: "gh-actions",
      displayName: "gh-actions",
      installedVersion: "0.0.9",
      relation: "update",
      installedFrom: "",
      permissionLines: ["run Code Foundry commands: thread.send"],
    });
    expect(v.entries[0]?.permissions.threadStatus).toBe(true);
    // A daemon that left the relation unset (nothing installed) maps to not-installed.
    expect(v.entries[1]).toMatchObject({ installedVersion: null, available: false, relation: "not-installed" });
    // Another source's entry: the daemon's decision and where it came from, newer or not.
    expect(v.entries[2]).toMatchObject({ installedVersion: "1.2.0", relation: "other-source", installedFrom: "plugins.acme.dev/index.json" });
    expect(v.registries).toEqual([{ url: "https://github.com/o/reg", fetchedAtMs: 5000, cached: true, error: "", plugins: 2, issues: ["x"] }]);
  });

  it("maps a plugin's install record and update offer", () => {
    const p = toPluginView(
      create(PluginSchema, {
        name: "hello",
        install: { kind: "registry", source: "https://x/index.json", version: "0.1.0", sha256: "ab", installedAt: timestampFromMs(7) },
        updateAvailable: true,
        updateVersion: "0.2.0",
        updateRegistry: "https://x/index.json",
      }),
    );
    expect(p.install).toEqual({ kind: "registry", source: "https://x/index.json", version: "0.1.0", sha256: "ab", installedAtMs: 7 });
    expect([p.updateAvailable, p.updateVersion, p.updateRegistry]).toEqual([true, "0.2.0", "https://x/index.json"]);
    expect(toPluginView(create(PluginSchema, { name: "bare" })).install).toBeNull();
  });

  it("maps install progress and registry epochs", () => {
    expect(
      toPluginEventView(
        create(PluginEventSchema, { event: { case: "installProgress", value: { ref: "hello", name: "hello", version: "0.1.0", phase: PluginInstallPhase.DOWNLOADING, message: "m", bytes: 2048n } } }),
      ),
    ).toEqual({ kind: "install-progress", progress: { ref: "hello", name: "hello", version: "0.1.0", phase: "downloading", message: "m", bytes: 2048 } });
    expect(toPluginEventView(create(PluginEventSchema, { event: { case: "registryEpoch", value: 3n } }))).toEqual({ kind: "registry", epoch: 3 });
  });

  it("reads plugin.install's result", () => {
    const json = toJsonString(InstallPluginResponseSchema, create(InstallPluginResponseSchema, { plugin: { name: "hello", needsConsent: true }, version: "0.1.0", changed: true }));
    expect(installOutcome(json)).toEqual({ name: "hello", version: "0.1.0", changed: true, enabled: false, needsConsent: true });
    expect(installOutcome("not json")).toBeNull();
  });
});
