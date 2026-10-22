/**
 * Checks theme files the way the app would take them (docs/THEMES.md): parseThemeFile (fields,
 * id, hex, the scheme against the surface, override names), then every contrast pair of
 * src/themes/contrastPairs.ts on the resolved slots. A file may hold one theme or an array.
 *
 *   pnpm run themes:check path/to/theme.json [more.json …]
 *
 * Exits 1 when a file is refused or a pair falls short. Nothing is installed: loading user
 * theme files is not built yet.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contrastFailures } from "../src/themes/contrastPairs.ts";
import { parseThemeFile, resolveSlots } from "../src/themes/slots.ts";

/** The report lines for one file's JSON, and whether it passed. */
export function checkThemeJson(json: unknown): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  for (const entry of Array.isArray(json) ? json : [json]) {
    try {
      const theme = parseThemeFile(entry);
      const failures = contrastFailures(resolveSlots(theme));
      ok &&= failures.length === 0;
      lines.push(`${theme.id} (${theme.scheme}): ${failures.length === 0 ? "every pair reads" : `${String(failures.length)} pairs fall short`}`);
      for (const f of failures) lines.push(`  ${f.label}: ${f.ratio.toFixed(2)} < ${String(f.pair.min)} (${f.pair.why})`);
    } catch (err) {
      ok = false;
      lines.push(`refused: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok, lines };
}

function main(): void {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: pnpm run themes:check <theme.json> [...]");
    process.exit(2);
  }
  let ok = true;
  for (const f of files) {
    const { ok: fileOk, lines } = checkThemeJson(JSON.parse(fs.readFileSync(f, "utf8")) as unknown);
    ok &&= fileOk;
    console.log(`${f}:\n${lines.map((l) => `  ${l}`).join("\n")}`);
  }
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
