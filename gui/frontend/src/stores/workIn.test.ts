import { beforeEach, describe, expect, it } from "vitest";
import { rememberedWorkIn, rememberWorkIn, useWorkInStore } from "./workIn";

const KEY = "code-foundry.workIn";

beforeEach(() => {
  useWorkInStore.setState({ byProject: {} });
  localStorage.clear();
});

describe("work in", () => {
  it("remembers a pick per project and persists it", () => {
    rememberWorkIn("web", "new");
    rememberWorkIn("", "current");
    expect(rememberedWorkIn("web")).toBe("new");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "{}")).toEqual({ version: 2, state: { byProject: { web: "new" } } });
  });

  it.each([
    ["version 1 kept picks under byRepo", { version: 1, state: { byRepo: { web: "current" } } }, { web: "current" }],
    ["version 2 reads byProject", { version: 2, state: { byProject: { api: "new" } } }, { api: "new" }],
  ])("%s", async (_name, stored, want) => {
    localStorage.setItem(KEY, JSON.stringify(stored));
    await useWorkInStore.persist.rehydrate();
    expect(useWorkInStore.getState().byProject).toEqual(want);
  });
});
