import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TabEntry } from "@/stores/layout";

const composerTextChanged = vi.hoisted(() => vi.fn());
vi.mock("@/shell/composerDrafts", async (orig) => ({ ...(await orig<typeof import("@/shell/composerDrafts")>()), composerTextChanged }));
// The composer itself is not what is tested here.
vi.mock("@/components/compose/Composer", () => ({ Composer: () => null }));

const { ComposeTab } = await import("./ComposeTab");

/**
 * A compose tab whose empty composer shows text it did not type (a heading pick in a space with
 * no pane moved it there) makes it a draft as typed text does; the No project composer's welcome
 * prefill does not.
 */

const composeTab = (params: Record<string, string>): TabEntry => ({ id: "t-c", kind: "compose", title: "", key: "compose", params, thread: "", paneId: "p-1" }) as unknown as TabEntry;

describe("ComposeTab", () => {
  beforeEach(() => {
    composerTextChanged.mockClear();
  });
  afterEach(cleanup);

  it("hands its target's text to the draft start when it shows its empty composer (only text starts one)", () => {
    render(<ComposeTab tab={composeTab({ project: "repo-cf" })} />);
    expect(composerTextChanged).toHaveBeenCalledWith("t-c", "", "repo-cf");
  });

  it.each([
    ["a draft's tab", { project: "repo-cf", draft: "d-1" }],
    ["the No project composer", {}],
  ])("not for %s", (_what, params) => {
    render(<ComposeTab tab={composeTab(params)} />);
    expect(composerTextChanged).not.toHaveBeenCalled();
  });
});
