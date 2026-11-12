import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layoutOf, pane, seedLayout, space, tab } from "@/test/shellLayout";

const ran: [string, Record<string, string>][] = [];
vi.mock("@/shell/commands", () => ({
  closeTabNow: (id: string) => {
    ran.push(["tab.close", { tab: id }]);
    return Promise.resolve({ rev: 2, changed: true });
  },
  runLayoutCommand: (name: string, args: Record<string, string>) => {
    ran.push([name, args]);
    return Promise.resolve({ rev: 2, changed: true });
  },
}));
// Which tabs keep their place when asked: a file tab with unsaved work says no.
const keep = new Set<string>();
const asked: string[] = [];
vi.mock("@/shell/surfaces/registry", () => ({
  shellSurfaceOf: (kind: string) =>
    kind === "file"
      ? {
          beforeClose: (t: { id: string }) => {
            asked.push(t.id);
            return Promise.resolve(!keep.has(t.id));
          },
        }
      : {},
}));

const { closePaneAsked, closeTabAsked } = await import("./closeTab");
const { resetLayout } = await import("@/stores/layout");

beforeEach(async () => {
  ran.length = 0;
  asked.length = 0;
  keep.clear();
  await seedLayout(layoutOf([space(pane("p-1", [tab("t-th", "thread", "s-1"), tab("t-f1", "file", "s-1"), tab("t-f2", "file", "s-1")]), "p-1")]));
});

afterEach(() => {
  resetLayout();
});

describe("closing as the user does", () => {
  it("closes a tab whose surface has nothing to ask, and one whose surface agrees", async () => {
    await closeTabAsked("t-th");
    await closeTabAsked("t-f1");
    expect(asked).toEqual(["t-f1"]);
    expect(ran).toEqual([
      ["tab.close", { tab: "t-th" }],
      ["tab.close", { tab: "t-f1" }],
    ]);
  });

  it("keeps a tab whose surface says no (Keep editing): nothing is sent", async () => {
    keep.add("t-f1");
    await expect(closeTabAsked("t-f1")).resolves.toBeNull();
    expect(ran).toEqual([]);
  });

  it("closes a pane only when every tab agrees, asking in strip order and stopping at a no", async () => {
    keep.add("t-f1");
    await expect(closePaneAsked("p-1")).resolves.toBeNull();
    expect(asked).toEqual(["t-f1"]);
    expect(ran).toEqual([]);
    keep.clear();
    asked.length = 0;
    await closePaneAsked("p-1");
    expect(asked).toEqual(["t-f1", "t-f2"]);
    expect(ran).toEqual([["pane.close", { pane: "p-1" }]]);
  });
});
