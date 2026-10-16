import { compile } from "tailwindcss";
import tailwindCss from "tailwindcss/index.css?raw";
import { describe, expect, it } from "vitest";
import indexCss from "../index.css?raw";
import { cn } from "@/lib/utils";
import { INLINE_TYPE_ROLES, SHELL_GAP, TYPE_ROLES } from "./tokens";

/**
 * The type roles, radius scale and shell gap (index.css), compiled by Tailwind itself so
 * the assertions are about the CSS the app ships: the values, and that a colour or weight
 * utility written after a role still wins (docs/notes/design-system-1-tokens.md).
 */

/** index.css compiled for `candidates`. Only Tailwind's own stylesheet matters here; the
 * animation, shadcn and theme imports are left empty. */
async function build(candidates: string[]): Promise<string> {
  const compiler = await compile(indexCss, {
    base: "/",
    loadStylesheet: (id, base) => Promise.resolve({ path: id, base, content: id === "tailwindcss" ? tailwindCss : "" }),
  });
  return compiler.build(candidates);
}

/** The top-level declarations of `.cls { … }` in the utilities layer (nested `&:hover`
 * blocks left out), first one per property. */
function rule(css: string, cls: string): Record<string, string> {
  const at = css.indexOf(`  .${cls} {`);
  if (at < 0) throw new Error(`no rule for .${cls}`);
  const end = css.indexOf("\n  }", at);
  const body = css.slice(css.indexOf("{", at) + 1, end).replace(/[^{};]+\{[^{}]*\}/g, "");
  const decls: Record<string, string> = {};
  for (const d of body.split(";").map((s) => s.trim())) {
    const colon = d.indexOf(":");
    if (colon < 0) continue;
    const prop = d.slice(0, colon).trim();
    decls[prop] ??= d.slice(colon + 1).trim();
  }
  return decls;
}

describe("type roles", () => {
  it("index.css defines exactly the roles tokens.ts lists", () => {
    const defined = [...indexCss.matchAll(/^@utility text-([\w-]+)/gm)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...TYPE_ROLES, ...INLINE_TYPE_ROLES].sort());
  });

  it.each([
    ["text-title", { "font-size": "22px", "line-height": "28px", "font-weight": "600", "letter-spacing": "var(--tracking-tight)", color: "var(--color-foreground)" }],
    ["text-display", { "font-size": "44px", "line-height": "48px", "font-weight": "600", "letter-spacing": "var(--tracking-tight)", "font-variant-numeric": "tabular-nums", color: "var(--color-foreground)" }],
    ["text-display-sm", { "font-size": "32px", "line-height": "36px", "font-weight": "600", "letter-spacing": "var(--tracking-tight)", "font-variant-numeric": "tabular-nums", color: "var(--color-foreground)" }],
    ["text-brand", { "font-size": "17px", "line-height": "20px", "font-weight": "600", "letter-spacing": "var(--tracking-tight)", color: "var(--color-foreground)" }],
    ["text-heading", { "font-size": "15px", "line-height": "20px", "font-weight": "600", color: "var(--color-foreground)" }],
    ["text-subheading", { "font-size": "14px", "line-height": "20px", "font-weight": "600", color: "var(--color-foreground)" }],
    ["text-overline", { "font-size": "11px", "line-height": "16px", "font-weight": "500", "letter-spacing": "0.06em", "text-transform": "uppercase", color: "var(--color-muted-foreground)" }],
    ["text-body", { "font-size": "15px", "line-height": "22px", "font-weight": "400", color: "var(--color-foreground)" }],
    ["text-body-sm", { "font-size": "13px", "line-height": "18px", "font-weight": "400", color: "var(--color-foreground)" }],
    ["text-label", { "font-size": "14px", "line-height": "20px", "font-weight": "500", color: "var(--color-foreground)" }],
    ["text-caption", { "font-size": "13px", "line-height": "18px", "font-weight": "400", color: "var(--color-muted-foreground)" }],
    ["text-caption-sm", { "font-size": "12px", "line-height": "16px", "font-weight": "400", color: "var(--color-muted-foreground)" }],
    ["text-link", { "font-weight": "500", color: "var(--color-link)" }],
    ["text-code", { "font-family": 'ui-monospace, "SF Mono", Menlo, monospace', "font-size": "0.92em", "font-weight": "400" }],
  ])("%s", async (cls, decls) => {
    expect(rule(await build([cls]), cls)).toEqual(decls);
  });

  // A modifier after a role in the class list must also come after it in the stylesheet.
  it.each([
    ["text-caption", "text-foreground"],
    ["text-caption-sm", "text-destructive"],
    ["text-body", "text-muted-foreground"],
    ["text-body", "font-medium"],
    ["text-body-sm", "font-semibold"],
    ["text-label", "font-normal"],
    ["text-title", "font-medium"],
    ["text-display", "text-muted-foreground"],
    ["text-display-sm", "font-medium"],
    ["text-title", "tracking-normal"],
    ["text-overline", "tracking-normal"],
    ["text-overline", "normal-case"],
    ["text-heading", "leading-none"],
    ["text-link", "text-foreground"],
    ["text-link", "font-normal"],
    ["text-code", "font-mono"],
    ["text-code", "font-semibold"],
  ])("%s is overridden by %s", async (role, modifier) => {
    const css = await build([modifier, role]);
    const r = css.indexOf(`  .${role} {`);
    const m = css.indexOf(`  .${modifier} {`);
    expect(r).toBeGreaterThanOrEqual(0);
    expect(m).toBeGreaterThan(r);
  });

  it("text-link underlines on hover", async () => {
    expect(await build(["text-link"])).toMatch(/\.text-link \{[^}]*&:hover \{\s*text-decoration-line: underline;/);
  });
});

describe("radius scale and shell gap", () => {
  it.each([
    ["rounded-sm", "4px"],
    ["rounded-md", "6px"],
    ["rounded-lg", "10px"],
    ["rounded-xl", "var(--radius)"],
    ["rounded-2xl", "16px"],
    ["rounded-pane", "var(--radius)"],
    // Bare `rounded` is Tailwind's own 0.25rem (banned by guards.test.ts, but unchanged).
    ["rounded", "0.25rem"],
  ])("%s is %s", async (cls, value) => {
    expect(rule(await build([cls]), cls)["border-radius"]).toBe(value);
  });

  it("only the scale exists", async () => {
    const css = await build(["rounded-xs", "rounded-3xl", "rounded-4xl", "rounded-full", "rounded-none"]);
    expect(css).not.toMatch(/\.rounded-(xs|3xl|4xl)\b/);
    expect(css).toMatch(/\.rounded-full \{/);
    expect(css).toMatch(/\.rounded-none \{/);
  });

  it("the pane radius is 12px and the shell gap 12px", () => {
    expect(indexCss).toMatch(/:root \{[^}]*--radius: 0\.75rem;/);
    expect(indexCss).toMatch(/:root \{[^}]*--gap-shell: 12px;/);
  });

  it("SHELL_GAP, for layout arithmetic in TS, is --gap-shell", () => {
    expect(indexCss).toMatch(new RegExp(`:root \\{[^}]*--gap-shell: ${String(SHELL_GAP)}px;`));
  });

  it.each([
    ["m-shell", "margin"],
    ["mt-shell", "margin-top"],
    ["pl-shell", "padding-left"],
    ["gap-shell", "gap"],
  ])("%s uses the shell gap", async (cls, prop) => {
    expect(rule(await build([cls]), cls)[prop]).toBe("var(--gap-shell)");
  });
});

describe("cn knows the tokens", () => {
  it.each([
    [["text-caption", "text-foreground"], "text-caption text-foreground"],
    [["text-body", "font-medium"], "text-body font-medium"],
    [["text-link", "text-destructive"], "text-link text-destructive"],
    [["text-code", "font-mono"], "text-code font-mono"],
    [["text-body", "text-caption"], "text-caption"],
    [["text-display", "text-display-sm"], "text-display-sm"],
    // Buttons, labels and tooltips keep their parent's colour unless a variant sets one.
    [["text-label text-inherit", "text-primary-foreground"], "text-label text-primary-foreground"],
    [["text-label text-inherit", "text-body-sm font-medium"], "text-inherit text-body-sm font-medium"],
    [["text-sm", "text-body"], "text-body"],
    [["text-xs text-muted-foreground", "text-caption"], "text-muted-foreground text-caption"],
    [["rounded-md", "rounded-pane"], "rounded-pane"],
    [["rounded-pane", "rounded-sm"], "rounded-sm"],
    [["m-2", "m-shell"], "m-shell"],
    [["gap-shell", "gap-1"], "gap-1"],
  ])("cn(%j) is %s", (args, want) => {
    expect(cn(...args)).toBe(want);
  });
});
