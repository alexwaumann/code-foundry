import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { confirmPresenter } from "@/stores/confirm";
import { useConsentStore } from "@/stores/pluginConsent";
import { usePluginsStore } from "@/stores/plugins";
import { ConsentDialog } from "./ConsentDialog";

// The daemon's plugin.ConsentText for the mock's acme-data (mock/plugins.ts consentText).
const ACME = [
  "Enable Acme Data 1.2.0? It runs bin/acme-data as you and may:",
  "  - run Code Foundry commands: thread.send",
  "  - add environment variables to new Claude threads",
  "  - keep secrets in your Keychain (its own, under code-foundry-plugin)",
].join("\n");

/** plugin.enable's daemon confirm, as runCommand hands it to the command's presenter. */
function askEnable(text: string, name = "acme-data"): Promise<boolean> {
  const present = confirmPresenter("plugin.enable");
  if (!present) throw new Error("plugin.enable has no presenter");
  let out: Promise<boolean> = Promise.resolve(false);
  act(() => {
    out = present({ title: "Enable", message: text, confirmLabel: "", command: "plugin.enable", args: { name } });
  });
  return out;
}

beforeEach(() => {
  useConsentStore.setState({ pending: null });
  usePluginsStore.setState({ byName: {}, order: [] });
});

afterEach(cleanup);

describe("ConsentDialog", () => {
  it("plugin.enable's confirm asks here: the title and each permission in the daemon's words", () => {
    render(<ConsentDialog />);
    expect(screen.queryByTestId("consent-dialog")).toBeNull();
    void askEnable(ACME);
    const dialog = within(screen.getByTestId("consent-dialog"));
    expect(dialog.getByTestId("consent-title").textContent).toBe("Enable Acme Data 1.2.0?");
    expect(screen.getByTestId("consent-dialog").textContent).toContain("It runs bin/acme-data as you and may:");
    expect(dialog.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "•run Code Foundry commands: thread.send",
      "•add environment variables to new Claude threads",
      "•keep secrets in your Keychain (its own, under code-foundry-plugin)",
    ]);
    expect(dialog.queryByTestId("consent-grew")).toBeNull();
  });

  it.each([
    ["Cancel", "consent-cancel", false],
    ["Enable", "consent-enable", true],
  ])("%s answers the daemon's confirm and closes", async (_name, testId, want) => {
    render(<ConsentDialog />);
    const answer = askEnable(ACME);
    fireEvent.click(screen.getByTestId(testId));
    await expect(answer).resolves.toBe(want);
    expect(screen.queryByTestId("consent-dialog")).toBeNull();
  });

  it("a plugin that asks for nothing says so", () => {
    render(<ConsentDialog />);
    void askEnable("Enable Crasher 0.0.1? It runs bin/crasher as you and asks for no permissions.", "crasher");
    expect(screen.getByTestId("consent-title").textContent).toBe("Enable Crasher 0.0.1?");
    expect(screen.queryByTestId("consent-permissions")).toBeNull();
  });
});
