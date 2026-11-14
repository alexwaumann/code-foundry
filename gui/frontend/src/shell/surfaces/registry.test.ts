import { describe, expect, it } from "vitest";
import kindsJson from "../../../../../internal/layout/testdata/kinds.json?raw";
import { shellSurfaceOf, shellSurfaces } from "./registry";

/** Kinds whose surface arrives with a later PR. */
const LATER: Readonly<Record<string, string>> = {};

describe("the shell's surfaces", () => {
  const kinds = (JSON.parse(kindsJson) as { kind: string; prefix?: boolean }[]).map((k) => k.kind);

  it("cover every kind of internal/layout's identity table, but those still to come", () => {
    const listed = new Set(shellSurfaces.map((s) => s.kind));
    for (const k of kinds) {
      if (k in LATER || k === "plugin.") continue;
      expect(listed, k).toContain(k);
    }
  });

  it("list no kind the layout does not know", () => {
    for (const s of shellSurfaces) expect(kinds, s.kind).toContain(s.kind);
  });

  it("find a plugin's surface by its prefix, and something for an unknown kind", () => {
    expect(kinds).toContain("plugin.");
    expect(shellSurfaceOf("plugin.hello.demo").kind).toBe("plugin.hello.demo");
    expect(shellSurfaceOf("someday").kind).toBe("someday");
    expect(shellSurfaceOf("someday")).toBe(shellSurfaceOf("someday"));
  });
});
