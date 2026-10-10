import { describe, expect, it } from "vitest";
import { descendInto, entryPath, tabCompletion, typedDir, homeDisplay, homeRelative } from "./paths";

describe("typedDir", () => {
  it.each([
    ["", "~/"],
    ["~", "~/"],
    ["~/", "~/"],
    ["~/src/co", "~/src/"],
    ["~/src/", "~/src/"],
    ["/Users/me/x", "/Users/me/"],
  ])("%j -> %j", (q, want) => {
    expect(typedDir(q)).toBe(want);
  });
});

describe("entryPath / descendInto", () => {
  it("keep the user's spelling", () => {
    expect(entryPath("~/src/co", "code-foundry")).toBe("~/src/code-foundry");
    expect(descendInto("~/src/co", "code-foundry")).toBe("~/src/code-foundry/");
    expect(descendInto("", "src")).toBe("~/src/");
    expect(descendInto("/Users/me/", "src")).toBe("/Users/me/src/");
  });
});

describe("tabCompletion", () => {
  it.each([
    { name: "highlighted entry wins", query: "~/s", completion: "~/s", highlighted: "src", want: "~/src/" },
    { name: "common completion", query: "~/co", completion: "~/code-", highlighted: null, want: "~/code-" },
    { name: "single match completes with slash", query: "~/sr", completion: "~/src/", highlighted: null, want: "~/src/" },
    { name: "nothing to add", query: "~/code-", completion: "~/code-", highlighted: null, want: null },
    { name: "no listing yet", query: "~/x", completion: null, highlighted: null, want: null },
  ])("$name", ({ query, completion, highlighted, want }) => {
    expect(tabCompletion(query, completion, highlighted)).toBe(want);
  });
});

describe("homeRelative / homeDisplay", () => {
  it("prefixes what is typed with ~/", () => {
    expect(homeRelative("")).toBe("~/");
    expect(homeRelative("src/x")).toBe("~/src/x");
    expect(homeRelative("/src/x")).toBe("~/src/x");
  });
  it("does not double a pasted ~", () => {
    expect(homeRelative("~/src/x")).toBe("~/src/x");
    expect(homeRelative("~")).toBe("~/");
    expect(homeRelative("~/")).toBe("~/");
  });
  it("maps an absolute path under home, and takes any other relative to home", () => {
    expect(homeRelative("/Users/dev/src/x")).toBe("~/src/x");
    expect(homeRelative("/Users/dev")).toBe("~/");
    expect(homeRelative("/etc/hosts")).toBe("~/etc/hosts");
  });
  it("shows everything after ~/", () => {
    expect(homeDisplay("~/")).toBe("");
    expect(homeDisplay("~")).toBe("");
    expect(homeDisplay("~/src/x")).toBe("src/x");
  });
});
