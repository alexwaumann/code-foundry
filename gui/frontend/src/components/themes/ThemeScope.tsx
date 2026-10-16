import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Theme } from "@/themes";

/**
 * Paints its subtree in `theme`, whatever the window shows: themes.css gives every theme a
 * `[data-theme-scope][data-theme="id"]` block next to its `html[data-theme]` one (the
 * variables, and every syntax colour on `.cf-thread` inside). The scheme class (`dark` or
 * `light`) picks the scheme's rules: `dark:` utilities and `.dark .cf-thread` skip a
 * `.light` subtree (index.css, thread.css), so a light preview inside a dark window
 * renders light. Text colour is set here because `color` inherits as a computed value
 * from the window's body.
 */
export function ThemeScope({ theme, className, children }: { theme: Theme; className?: string; children: ReactNode }) {
  return (
    <div data-theme-scope="" data-theme={theme.id} className={cn(theme.scheme, "bg-sheet text-foreground", className)} data-testid="theme-scope">
      {children}
    </div>
  );
}
