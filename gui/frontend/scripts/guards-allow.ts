/**
 * `pnpm run guards:allow`: rewrites src/design/guards.allow.json from the tree, with the
 * scanner src/design/guards.test.ts uses. Run it after removing banned classes, so the
 * allowlist only ever shrinks (docs/notes/design-system-1-tokens.md).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, buildAllowlist, isScanned, serialize } from "../src/design/scan.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "src/design/guards.allow.json");

const files: Record<string, string> = {};
for (const entry of fs.readdirSync(path.join(root, "src"), { recursive: true, encoding: "utf8" })) {
  const rel = `src/${entry.split(path.sep).join("/")}`;
  if (isScanned(rel)) files[rel] = fs.readFileSync(path.join(root, rel), "utf8");
}

const allow = buildAllowlist(files);
fs.writeFileSync(out, serialize(allow));

const totals = Object.fromEntries(CATEGORIES.map((c) => [c, Object.values(allow).reduce((n, counts) => n + counts[c], 0)]));
console.log(`${path.relative(root, out)}: ${String(Object.keys(allow).length)} files of ${String(Object.keys(files).length)}`, totals);
