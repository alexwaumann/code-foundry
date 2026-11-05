/**
 * Writes pluginsdk/ui/icons.go from the installed lucide-react: run it after a lucide bump
 * (`bun scripts/pluginIcons.ts` from gui/frontend). src/components/plugin/icons.test.ts
 * fails while the two differ. lucide's dynamic import map has its real kebab names, aliases
 * included (`trash-2` is an alias of `trash`).
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import dynamicIconImports from "lucide-react/dynamicIconImports";

const names = Object.keys(dynamicIconImports).sort((a, b) => (a < b ? -1 : 1));

const lines: string[] = [];
let line = "\t";
for (const name of names) {
  const item = `"${name}", `;
  if (line.length + item.length > 96) {
    lines.push(line.trimEnd());
    line = "\t";
  }
  line += item;
}
lines.push(line.trimEnd());

const out = `package ui

import "slices"

// Icons are the lucide icon names (kebab case) the Code Foundry GUI draws in plugin
// views: header and surface icons, glyphs, buttons, notices. Any other well-formed name
// passes Validate and draws a plain circle. All of lucide with its aliases, sorted; written by
// gui/frontend/scripts/pluginIcons.ts.
var Icons = []string{
${lines.join("\n")}
}

// KnownIcon reports whether the GUI draws name (Icons); others draw a circle.
func KnownIcon(name string) bool {
	_, ok := slices.BinarySearch(Icons, name)
	return ok
}
`;
writeFileSync(join(import.meta.dirname, "../../../pluginsdk/ui/icons.go"), out);
console.log(names.length, "icons");
