import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";
import { resetLayout } from "@/stores/layout";
import { resetShellView, setShellMode } from "@/stores/shellView";
import { composerTabSentFrom } from "./composerTab";

describe("the composer tab a send comes from", () => {
  beforeEach(() => {
    resetLayout();
    resetShellView();
  });
  afterEach(() => {
    resetLayout();
    resetShellView();
  });

  const twoPanes = (focus: string) => layoutOf([space(row("s-r", [pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-c", "compose")], "t-c"), pane("p-2", [tab("t-prs", "prs")])]), focus)]);

  it("is the focused composer tab in the shell, and nothing otherwise", async () => {
    await seedLayout(twoPanes("p-1"));
    expect(composerTabSentFrom()).toBe("");
    setShellMode("shell");
    expect(composerTabSentFrom()).toBe("t-c");
    await seedLayout(twoPanes("p-2"));
    expect(composerTabSentFrom()).toBe("");
    await seedLayout(layoutOf([space(null, "")], 3));
    expect(composerTabSentFrom()).toBe("");
  });
});
