// @vitest-environment node
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT } from "../src/themes/defaults.ts";
import { COMPONENT_ALIASES, SLOT_NAMES } from "../src/themes/slots.ts";
import { buildCatalog, PATHS, readInputs } from "./convert.ts";
import { frameCss, frameDefaultsJson, radii, typeRoles } from "./frame.ts";

const indexCss = fs.readFileSync(PATHS.indexCss, "utf8");

describe("frame stylesheet", () => {
  // `pnpm run themes` regenerates both; a changed role, radius, alias or default theme fails here.
  it("internal/theme/frame.css and frame-defaults.json match the generator", () => {
    expect(fs.readFileSync(PATHS.frameCss, "utf8")).toBe(frameCss(indexCss));
    expect(fs.readFileSync(PATHS.frameDefaults, "utf8")).toBe(frameDefaultsJson(buildCatalog(readInputs())));
  });

  it("aliases every component name to its slot, as index.css does", () => {
    const css = frameCss(indexCss);
    for (const [name, slot] of Object.entries(COMPONENT_ALIASES)) expect(css).toContain(`  ${name}: var(${slot});\n`);
  });

  it("carries every type role but the sidebar's brand, colours read as slots", () => {
    const roles = typeRoles(indexCss);
    const names = roles.map((r) => r.name);
    expect(names).toContain("text-body");
    expect(names).toContain("text-caption");
    expect(names).not.toContain("text-brand");
    for (const r of roles)
      for (const [p, v] of [...r.decls, ...r.nested.flatMap((n) => n.decls)]) if (p === "color") expect(v, r.name).toMatch(/^var\(--cf-[a-z0-9-]+\)$/);
    expect(roles.find((r) => r.name === "text-link")?.nested).toEqual([{ suffix: ":hover", decls: [["text-decoration-line", "underline"]] }]);
  });

  it("reads index.css's radius scale", () => {
    expect(Object.fromEntries(radii(indexCss))).toMatchObject({ "--radius-sm": "4px", "--radius-md": "6px", "--radius-lg": "10px", "--radius-pane": "var(--radius)" });
  });

  it("maps a role's colour through the aliases whichever name index.css uses", () => {
    const css = "@utility text-a {\n  font-size: 1px;\n  color: var(--muted-foreground);\n}\n@utility text-b {\n  color: var(--cf-text);\n}\n";
    expect(typeRoles(css).map((r) => r.decls)).toEqual([[["font-size", "1px"], ["color", "var(--cf-text-muted)"]], [["color", "var(--cf-text)"]]]);
  });

  it("defaults are GitHub Dark and Light with every slot", () => {
    const d = JSON.parse(frameDefaultsJson(buildCatalog(readInputs()))) as Record<string, { id: string; scheme: string; vars: Record<string, string> }>;
    expect(d.dark?.id).toBe(DEFAULT_DARK);
    expect(d.light?.id).toBe(DEFAULT_LIGHT);
    expect(d.light?.scheme).toBe("light");
    expect(Object.keys(d.dark?.vars ?? {})).toEqual(SLOT_NAMES);
  });
});
