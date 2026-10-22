import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { Theme } from "@/themes";

/**
 * Paints its subtree in `theme`, whatever the window shows: the theme's resolved slots are
 * set inline on this element, and index.css declares the component aliases (`--card:
 * var(--cf-surface-raised)`, ...) on every `[data-theme-scope]` too, so they resolve
 * against these slots rather than inheriting the window's. The scheme class (`dark` or
 * `light`) picks the scheme's rules: `dark:` utilities and `.dark .cf-thread` skip a
 * `.light` subtree (index.css, thread.css), so a light preview inside a dark window
 * renders light. Text colour is set here because `color` inherits as a computed value
 * from the window's body.
 */
export function ThemeScope({ theme, className, children }: { theme: Theme; className?: string; children: ReactNode }) {
  const style = { ...theme.slots, colorScheme: theme.scheme } as CSSProperties;
  return (
    <div data-theme-scope="" data-theme={theme.id} style={style} className={cn(theme.scheme, "bg-cf-canvas text-cf-text", className)} data-testid="theme-scope">
      {children}
    </div>
  );
}
