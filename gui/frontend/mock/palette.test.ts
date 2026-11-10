// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { World } from "./world";

const commandDir = new URL("../../../internal/command/", import.meta.url);

/** Every command name the daemon registers (`Command{ Name: "…"` in internal/command). */
function daemonCommands(): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync(commandDir)) {
    if (!f.endsWith(".go") || f.endsWith("_test.go")) continue;
    for (const m of readFileSync(new URL(f, commandDir), "utf8").matchAll(/Command\{\s*Name:\s*"([^"]+)"/g)) names.add(m[1] ?? "");
  }
  return names;
}

/** keybindings_test.go's `want`: the daemon's NoKeybinding commands. */
function daemonNoKeybinding(): Set<string> {
  const src = readFileSync(new URL("keybindings_test.go", commandDir), "utf8");
  const list = /want := \[\]string\{([\s\S]*?)\n\t\}/.exec(src)?.[1] ?? "";
  return new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
}

/** palette_test.go's `noPalette`: the daemon's NoPalette commands. */
function daemonNoPalette(): Set<string> {
  const src = readFileSync(new URL("palette_test.go", commandDir), "utf8");
  const list = /var noPalette = \[\]string\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
  return new Set([...list.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? ""));
}

describe("the mock's command registry", () => {
  it("hides from the palette exactly what the daemon hides, for every command both have", () => {
    const daemon = daemonCommands();
    const hidden = daemonNoPalette();
    expect(hidden.size).toBeGreaterThan(50);
    const shared = new World().listCommands(undefined, true).filter((c) => daemon.has(c.name));
    expect(shared.length).toBeGreaterThan(100);
    const wrong = shared.filter((c) => Boolean(c.noPalette) !== hidden.has(c.name)).map((c) => `${c.name}: ${c.noPalette ? "hidden" : "listed"}`);
    expect(wrong).toEqual([]);
  });

  it("offers a keybinding for exactly the commands the daemon does, for every command both have", () => {
    const daemon = daemonCommands();
    const unbound = daemonNoKeybinding();
    expect(unbound.size).toBeGreaterThan(50);
    const world = new World();
    const bindable = new Set(world.settings.fields().flatMap((f) => (f.key.startsWith("keybindings.") ? [f.key.slice("keybindings.".length)] : [])));
    const shared = world.listCommands(undefined, true).filter((c) => daemon.has(c.name));
    const wrong = shared.filter((c) => bindable.has(c.name) === unbound.has(c.name)).map((c) => `${c.name}: ${bindable.has(c.name) ? "bindable" : "unbound"}`);
    expect(wrong).toEqual([]);
  });
});
