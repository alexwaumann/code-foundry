import { describe, expect, it } from "vitest";
import { identityKey } from "@/shell/identity";
import { prDiffOfTab, prDiffTab, prDiffTabId } from "./prDiffTarget";

describe("prDiffTab", () => {
  it("is titled Diff #N, keeps the slug's spelling in its params and leaves the file out until there is one", () => {
    expect(prDiffTab({ slug: "Acme/App", number: 12 })).toEqual({ id: "prdiff?number=12&slug=acme%2Fapp", kind: "prdiff", title: "Diff #12", params: { slug: "Acme/App", number: "12" } });
    expect(prDiffTab({ slug: "acme/app", number: 12, file: "src/a.ts" }).params).toEqual({ slug: "acme/app", number: "12", path: "src/a.ts" });
  });

  it.each([
    ["the slug's case", { slug: "Acme/App", number: 12 }, { slug: "acme/app", number: 12 }],
    ["the file shown", { slug: "acme/app", number: 12, file: "a.ts" }, { slug: "acme/app", number: 12, file: "b.ts" }],
  ])("one tab whatever %s", (_name, a, b) => {
    expect(prDiffTab(a).id).toBe(prDiffTab(b).id);
    const ka = identityKey("prdiff", "", prDiffTab(a).params);
    expect(ka).toBe("prdiff:acme/app#12");
    expect(identityKey("prdiff", "", prDiffTab(b).params)).toBe(ka);
  });

  it("is not the pull request's own tab", () => {
    expect(prDiffTabId("acme/app", 12)).not.toBe("pullrequest?number=12&slug=acme%2Fapp");
    expect(identityKey("prdiff", "", { slug: "acme/app", number: "12" })).not.toBe(identityKey("pullrequest", "", { slug: "acme/app", number: "12" }));
  });
});

describe("prDiffOfTab", () => {
  it.each<[string, Record<string, string>, ReturnType<typeof prDiffOfTab>]>([
    ["a pull request", { slug: "Acme/App", number: "12" }, { slug: "Acme/App", number: 12, file: "" }],
    ["with its file", { slug: "a/b", number: "3", path: "x/y.go" }, { slug: "a/b", number: 3, file: "x/y.go" }],
    ["no slug", { number: "3" }, null],
    ["a slug with no owner", { slug: "repo", number: "3" }, null],
    ["no number", { slug: "a/b" }, null],
    ["number zero", { slug: "a/b", number: "0" }, null],
    ["not a number", { slug: "a/b", number: "x" }, null],
  ])("%s", (_name, params, want) => {
    expect(prDiffOfTab({ params })).toEqual(want);
  });

  it("reads back what prDiffTab writes", () => {
    const t = { slug: "Acme/App", number: 7, file: "docs/a.md" };
    expect(prDiffOfTab(prDiffTab(t))).toEqual(t);
  });
});
