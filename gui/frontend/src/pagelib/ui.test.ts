import { describe, expect, it } from "vitest";
import indexCss from "../index.css?raw";
import * as ui from "./ui";
import { appTheme, cfColours, pageSafelist, typeRoleNames } from "./theme";

/** Every component module in components/ui, by file (tests left out). */
const components = import.meta.glob<Record<string, unknown>>(["../components/ui/*.tsx", "!../components/ui/*.test.tsx"], { eager: true });

describe("@cf/ui (/cf/ui.js, docs/notes/page-library.md)", () => {
  it("re-exports every component file in components/ui, every export unchanged", () => {
    expect(Object.keys(components).length).toBeGreaterThan(20);
    for (const [file, mod] of Object.entries(components)) {
      for (const [name, value] of Object.entries(mod)) {
        // A new file in components/ui goes in src/pagelib/ui.ts, and its exports in the pages
        // skill's reference/components.md (internal/skills/pages_test.go).
        expect(ui, `${file} exports ${name}; add the file to src/pagelib/ui.ts`).toHaveProperty(name, value);
      }
    }
  });

  it("adds cn and sonner's toast", () => {
    expect(typeof ui.cn).toBe("function");
    expect(ui.cn("text-caption", "text-cf-text")).toBe("text-caption text-cf-text");
    expect(typeof ui.toast).toBe("function");
  });
});

describe("the page theme (src/pagelib/theme.ts)", () => {
  it("carries index.css's @theme and type roles, not its base or the sidebar's brand", () => {
    const css = appTheme(indexCss);
    expect(css).toMatch(/^@theme inline \{/);
    expect(css).toContain("--color-cf-surface-raised: var(--cf-surface-raised);");
    expect(css).toContain("--radius-pane: var(--radius);");
    for (const role of ["text-body", "text-caption", "text-heading", "text-link", "text-code"]) {
      expect(css).toContain(`@utility ${role} {`);
    }
    expect(css).toContain("@keyframes cf-indeterminate {");
    expect(css).not.toContain("text-brand");
    expect(css).not.toContain("@layer base");
    expect(css).not.toContain("@custom-variant");
  });

  it("safelists every cf colour and type role", () => {
    const list = pageSafelist(indexCss);
    expect(cfColours(indexCss).length).toBeGreaterThan(50);
    for (const c of cfColours(indexCss)) expect(list).toContain(c);
    for (const r of typeRoleNames(indexCss)) expect(list).toContain(r);
  });
});
