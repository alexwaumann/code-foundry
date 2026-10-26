/**
 * GET /cf/<file> for the page library (internal/pagelib/dist, built by `make pagelib`),
 * read from the repository like the bridge script (mock/bridge.ts), so a mock page runs the
 * daemon's own React, @cf/ui, loader and Tailwind runtime (docs/notes/page-library.md).
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../../../internal/pagelib/dist/", import.meta.url));

const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

/** GET /cf/<a .js or .css file in dist>; undefined for any other path. */
export function pagelibRoute(pathname: string): { type: string; body: Buffer } | undefined {
  if (!pathname.startsWith("/cf/")) return undefined;
  const rel = pathname.slice("/cf/".length);
  const type = TYPES[path.extname(rel)];
  const file = path.join(dist, rel);
  if (!type || rel.includes("..") || !file.startsWith(dist) || !existsSync(file)) return undefined;
  return { type, body: readFileSync(file) };
}

/** The pages e2e/page-library.spec.ts shows (mock/pagelib/*.html), by file name. */
export function pagelibPages(): Record<string, string> {
  const dir = new URL("./pagelib/", import.meta.url);
  return Object.fromEntries(["board", "tailwind", "broken", "mockup"].map((n) => [`${n}.html`, readFileSync(new URL(`${n}.html`, dir), "utf8")]));
}
