import { describe, expect, it } from "vitest";
import pkg from "../../package.json";

/**
 * lib/markdownText runs the thread renderer's parse with its own unified, remark-parse and
 * remark-rehype (direct dependencies, as bun's isolated install hides react-markdown's).
 * They must be the versions react-markdown resolves: a react-markdown bump that moves to
 * other ones would ship two copies, which could parse differently from what renders.
 */

type Manifest = { version: string };
const NAMES = ["unified", "remark-parse", "remark-rehype"] as const;

// Ours: the top-level node_modules. react-markdown's: its own node_modules in bun's store (node_modules/.bun/<name>@<version>/node_modules).
const ours = import.meta.glob<Manifest>("/node_modules/{unified,remark-parse,remark-rehype}/package.json", { eager: true, import: "default" });
const theirs = import.meta.glob<Manifest>("/node_modules/.bun/react-markdown@*/node_modules/{unified,remark-parse,remark-rehype}/package.json", { eager: true, import: "default" });

function versionIn(found: Record<string, Manifest>, name: string): string[] {
  return Object.entries(found)
    .filter(([path]) => path.endsWith(`/node_modules/${name}/package.json`))
    .map(([, m]) => m.version);
}

describe("markdownText's parse packages", () => {
  it.each(NAMES)("%s: package.json pins the version react-markdown resolves", (name) => {
    const pinned = (pkg.dependencies as Record<string, string>)[name];
    const mine = versionIn(ours, name);
    const its = versionIn(theirs, name);
    expect(mine, `node_modules/${name}`).toHaveLength(1);
    // One react-markdown in the store, resolving one copy (else the layout changed: update this guard).
    expect(its, `react-markdown's ${name} (node_modules/.bun/react-markdown@*/node_modules/${name})`).toHaveLength(1);
    expect(mine[0], `package.json pins ${name} ${pinned ?? "?"}; react-markdown resolves ${its[0] ?? "?"}`).toBe(its[0]);
    expect(pinned).toBe(mine[0]);
  });
});
