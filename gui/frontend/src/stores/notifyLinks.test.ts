import { beforeEach, describe, expect, it } from "vitest";
import { notifyLinkAction } from "./notifyLinks";
import { useViewsStore } from "./views";

describe("notifyLinkAction", () => {
  beforeEach(() => {
    useViewsStore.setState({ settingsOpen: false, settingsPage: "general", usageOpen: false, themesOpen: true, helpOpen: true });
  });

  it("settings:<page> opens that Settings page over the others", () => {
    notifyLinkAction("settings:memory")?.();
    expect(useViewsStore.getState()).toMatchObject({ settingsOpen: true, settingsPage: "memory", themesOpen: false, helpOpen: false });
  });

  it.each(["", "settings", "settings:", ":memory", "elsewhere:memory"])("%j is not a link", (link) => {
    expect(notifyLinkAction(link)).toBeNull();
  });
});
