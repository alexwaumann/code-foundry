import { describe, expect, it } from "vitest";
import casesJson from "../../../../internal/layout/testdata/identity.json?raw";
import kindsJson from "../../../../internal/layout/testdata/kinds.json?raw";
import { IDENTITY_KINDS, identify, isRefusal } from "./identity";

interface KindRow {
  kind: string;
  link: string;
  scope: string;
  key_params?: string[];
  renameable?: boolean;
  prefix?: boolean;
}

interface CaseRow {
  name: string;
  kind: string;
  thread?: string;
  params?: Record<string, string>;
  key?: string;
  refused?: boolean;
}

describe("the identity table", () => {
  const rows = JSON.parse(kindsJson) as KindRow[];

  it("has the daemon's kinds, links, scopes, key params and names (testdata/kinds.json)", () => {
    const ours = Object.entries(IDENTITY_KINDS)
      .map(([kind, k]) => ({ kind, link: k.link, scope: k.scope, key_params: k.keyParams ?? [], renameable: k.renameable ?? false, prefix: k.prefix ?? false }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
    const theirs = rows.map((r) => ({ kind: r.kind, link: r.link, scope: r.scope, key_params: r.key_params ?? [], renameable: r.renameable ?? false, prefix: r.prefix ?? false }));
    expect(ours).toEqual(theirs);
  });
});

describe("identify", () => {
  const cases = JSON.parse(casesJson) as CaseRow[];

  it.each(cases.map((c) => [c.name, c] as const))("%s (testdata/identity.json)", (_name, c) => {
    const r = identify({ kind: c.kind, thread: c.thread ?? "", params: c.params ?? {} });
    if (c.refused) expect(isRefusal(r)).toBe(true);
    else expect(isRefusal(r) ? r : r.key).toBe(c.key);
  });
});
