/**
 * The frame stylesheet, as the daemon serves it (internal/theme/frame.go,
 * docs/notes/theme-css-route.md): UiService.PublishTheme keeps the last theme, and
 * GET /cf/theme.css and /cf/theme.json write it out, the GitHub defaults before anything
 * is published. Reads the daemon's committed frame.css and frame-defaults.json, so a page
 * in the mock's HTML preview paints as it would against the daemon.
 */
import { readFileSync } from "node:fs";

export interface MockFrame {
  id: string;
  scheme: string;
  vars: Record<string, string>;
}

const read = (name: string) => readFileSync(new URL(`../../../internal/theme/${name}`, import.meta.url), "utf8");
const frameCss = read("frame.css");
const defaults = JSON.parse(read("frame-defaults.json")) as Record<"dark" | "light", MockFrame>;

let published: MockFrame | null = null;

/** Every slot name, as the daemon reads them from the defaults (internal/theme SlotNames). */
const slotNames = Object.keys(defaults.dark.vars).sort();

/**
 * Why the daemon would refuse f (Frame.Check's slot-set rule: exactly every slot), or null.
 * The id, scheme and value checks are the daemon's tests' job; the mock only mirrors the
 * rule a GUI change could break.
 */
export function mockThemeProblem(f: MockFrame): string | null {
  const missing = slotNames.filter((n) => !(n in f.vars));
  const unknown = Object.keys(f.vars)
    .filter((n) => !slotNames.includes(n))
    .sort();
  const parts = [
    ...(missing.length ? [`missing ${String(missing.length)} of the ${String(slotNames.length)} slots: ${missing.join(", ")}`] : []),
    ...(unknown.length ? [`${String(unknown.length)} unknown: ${unknown.join(", ")}`] : []),
  ];
  return parts.length ? `a theme publishes every slot the GUI resolves, exactly: ${parts.join("; ")}` : null;
}

/** Makes f the served theme; throws (the daemon's InvalidArgument) and keeps the last one when f is refused. */
export function publishMockTheme(f: MockFrame): void {
  const problem = mockThemeProblem(f);
  if (problem) throw new Error(problem);
  published = { id: f.id, scheme: f.scheme, vars: { ...f.vars } };
}

const root = (f: MockFrame, indent = "") =>
  `${indent}:root {\n${indent}  color-scheme: ${f.scheme};\n` +
  Object.keys(f.vars)
    .sort()
    .map((k) => `${indent}  ${k}: ${f.vars[k] ?? ""};\n`)
    .join("") +
  `${indent}}\n`;

/** GET /cf/theme.css or /cf/theme.json; undefined for any other path (a 404). */
export function themeRoute(pathname: string): { type: string; body: string } | undefined {
  if (pathname === "/cf/theme.css") {
    const head = published ? root(published) : root(defaults.dark) + "@media (prefers-color-scheme: light) {\n" + root(defaults.light, "  ") + "}\n";
    return { type: "text/css; charset=utf-8", body: head + frameCss };
  }
  if (pathname === "/cf/theme.json") {
    const f = published ?? defaults.dark;
    return { type: "application/json; charset=utf-8", body: JSON.stringify({ id: f.id, scheme: f.scheme, vars: f.vars, published: published !== null }) + "\n" };
  }
  return undefined;
}
