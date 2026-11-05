import { Circle, Puzzle, Trash2 } from "lucide-react";
import dynamicIconImports from "lucide-react/dynamicIconImports";
import { describe, expect, it } from "vitest";
import iconsGo from "../../../../../pluginsdk/ui/icons.go?raw";
import { iconByName, pluginIcon } from "./icons";

/** pluginsdk/ui/icons.go's names, which the skill and the SDK give plugin authors. */
function sdkNames(): string[] {
  const list = /var Icons = \[\]string\{(.*?)\n\}/s.exec(iconsGo)?.[1] ?? "";
  return Array.from(list.matchAll(/"([a-z0-9-]+)"/g), (m) => m[1] ?? "");
}

describe("plugin icons", () => {
  it("lists all of lucide in the SDK (scripts/pluginIcons.ts writes it) and draws every name", () => {
    const names = sdkNames();
    expect(names).toEqual(Object.keys(dynamicIconImports).sort((a, b) => (a < b ? -1 : 1)));
    expect(names.filter((n) => iconByName(n) === undefined)).toEqual([]);
  });

  it("finds an alias, and nothing that is not an icon", () => {
    expect(iconByName("trash-2")).toBe(Trash2);
    for (const name of ["icon", "lucide-provider", "create-lucide-icon", "default", "constructor", "to-string"]) expect(iconByName(name)).toBeUndefined();
  });

  it("falls back: a circle for an unknown name, the fallback for none", () => {
    expect(pluginIcon("no-such-icon")).toBe(Circle);
    expect(pluginIcon(undefined)).toBe(Puzzle);
  });
});
