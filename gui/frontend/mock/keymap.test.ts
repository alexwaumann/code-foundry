// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { World } from "./world";

/** keybindings_test.go's TestShellKeyTable `want`: the spec's rows and their verbs. */
function daemonTable(): Map<string, string[]> {
  const src = readFileSync(new URL("../../../internal/command/keybindings_test.go", import.meta.url), "utf8");
  const body = /func TestShellKeyTable[\s\S]*?want := map\[string\]\[\]string\{([\s\S]*?)\n\t\}/.exec(src)?.[1] ?? "";
  return new Map([...body.matchAll(/"([^"]+)":\s*\{([^}]*)\}/g)].map((m) => [m[1] ?? "", [...(m[2] ?? "").matchAll(/"([^"]+)"/g)].map((v) => v[1] ?? "")]));
}

// The mock daemon's default chords are the daemon's for every verb of the spec's key table, so
// the browser tests press what a user presses.
describe("the mock's keymap", () => {
  it("binds the key table's verbs as the daemon does", () => {
    const table = daemonTable();
    expect(table.size).toBeGreaterThan(15);
    const byName = new Map(new World().listCommands(undefined, true).map((c) => [c.name, c.keybindings]));
    const verbs = [...table.values()].flat().filter((v) => v.includes("."));
    expect(verbs.length).toBeGreaterThan(15);
    for (const v of verbs) expect(byName.get(v)?.length ?? 0, v).toBeGreaterThan(0);
    // The retired chords are on nothing.
    const all = [...byName.values()].flat();
    for (const c of ["cmd+shift+e", "cmd+\\", "cmd+alt+\\"]) expect(all, c).not.toContain(c);
    for (const name of ["view.pullrequests", "view.projects", "thread.previous", "thread.next", "thread.rename"]) expect(byName.get(name), name).toEqual([]);
    // The side and bottom panel verbs went with their panels (docs/notes/shell-22-retire-verbs.md).
    for (const name of ["view.panel.toggle", "view.panel.expand", "view.panel.new-tab", "view.panel.split", "view.bottom.toggle"]) expect(byName.has(name), name).toBe(false);
  });
});
