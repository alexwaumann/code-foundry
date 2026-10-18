import { describe, expect, it } from "vitest";
import { pluginDataDirWords, pluginsDirWords } from "./dirs";

describe("plugin directory words", () => {
  const dirs = { pluginsDir: "/Users/alex/.cf-integ/plugins", dataDir: "/Users/alex/.cf-integ/plugin-data/" };
  it.each([
    ["the daemon's, with ~", dirs, "~/.cf-integ/plugins"],
    ["outside the home as it is", { pluginsDir: "/tmp/cfp7/plugins", dataDir: "/tmp/cfp7/plugin-data" }, "/tmp/cfp7/plugins"],
    ["not known yet", null, "the plugins folder"],
    ["an older daemon that does not say", { pluginsDir: "", dataDir: "" }, "the plugins folder"],
  ])("plugins dir: %s", (_name, d, want) => {
    expect(pluginsDirWords(d)).toBe(want);
  });
  it("names a plugin's data folder, or nothing until known", () => {
    expect(pluginDataDirWords(dirs, "hello")).toBe("~/.cf-integ/plugin-data/hello");
    expect(pluginDataDirWords(null, "hello")).toBeNull();
  });
});
