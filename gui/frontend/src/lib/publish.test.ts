import { describe, expect, it } from "vitest";
import { defaultVisibility, keepVisibility, projectNameError, projectsDirFrom, visibilityOptions, type PublishOwnerView, type Visibility } from "./publish";

const user: PublishOwnerView = { login: "dev", kind: "user", allowed: ["public", "private"], known: true };
const octo: PublishOwnerView = { login: "octo-org", kind: "org", allowed: ["public", "internal"], known: true };
const acme: PublishOwnerView = { login: "acme", kind: "org", allowed: ["public", "internal", "private"], known: false };
const internalOnly: PublishOwnerView = { login: "corp", kind: "org", allowed: ["internal", "private"], known: true };
const privateOnly: PublishOwnerView = { login: "vault", kind: "org", allowed: ["private"], known: true };
const nothing: PublishOwnerView = { login: "locked", kind: "org", allowed: [], known: true };
// Unknown policy: whatever allowed says, every visibility is offered.
const unknownSparse: PublishOwnerView = { login: "x", kind: "org", allowed: [], known: false };

describe("projectNameError", () => {
  const cases: [string, boolean][] = [
    ["my-project", true],
    ["My_Project.v2", true],
    ["a", true],
    ["x.", true],
    ["a".repeat(100), true],
    ["", false],
    [".", false],
    ["..", false],
    [".hidden", false],
    ["a/b", false],
    ["has space", false],
    ["emoji-✨", false],
    ["a".repeat(101), false],
  ];
  it.each(cases)("%j ok=%s", (name, ok) => {
    expect(projectNameError(name) === null).toBe(ok);
  });
});

describe("projectsDirFrom", () => {
  it.each([
    ["/Users/me/.code-foundry/settings.toml", "/Users/me/.code-foundry/projects"],
    ["/Users/me/.cf-scratch/settings.toml", "/Users/me/.cf-scratch/projects"],
    [undefined, "~/.code-foundry/projects"],
    ["", "~/.code-foundry/projects"],
    ["/odd/path.toml", "~/.code-foundry/projects"],
  ])("%s -> %s", (path, want) => {
    expect(projectsDirFrom(path)).toBe(want);
  });
});

describe("visibility picker", () => {
  const cases: [string, PublishOwnerView | undefined, Visibility[], Visibility | null][] = [
    ["personal account", user, ["public", "private"], "public"],
    ["org with a known policy", octo, ["public", "internal"], "public"],
    ["org with an unknown policy", acme, ["public", "internal", "private"], "public"],
    ["unknown means all three", unknownSparse, ["public", "internal", "private"], "public"],
    ["internal is the most open allowed", internalOnly, ["internal", "private"], "internal"],
    ["private is never the default", privateOnly, ["private"], null],
    ["nothing allowed", nothing, [], null],
    ["no owner yet", undefined, [], null],
  ];
  it.each(cases)("%s", (_name, owner, options, def) => {
    expect(visibilityOptions(owner)).toEqual(options);
    expect(defaultVisibility(owner)).toBe(def);
  });

  it("keeps an allowed choice across owners, else takes the default", () => {
    expect(keepVisibility("private", user)).toBe("private");
    expect(keepVisibility("private", octo)).toBe("public");
    expect(keepVisibility("internal", acme)).toBe("internal");
    expect(keepVisibility(null, internalOnly)).toBe("internal");
    expect(keepVisibility("public", privateOnly)).toBe(null);
  });
});
