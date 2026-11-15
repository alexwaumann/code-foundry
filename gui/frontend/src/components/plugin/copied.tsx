import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCopiedHere } from "./useCopiedHere";

/**
 * The check an element shows for a moment after its copy action (no toast:
 * docs/notes/toast-success-rule.md), in the success colour, named "Copied" for a screen
 * reader. Nothing otherwise. For elements with no icon of their own to swap (a row, a table
 * row, a stat card, a bar's tooltip); a button and a chip swap their icon for it.
 */
export function CopiedMark({ elementKey, className }: { elementKey: string; className?: string }) {
  const copied = useCopiedHere(elementKey);
  if (!copied) return null;
  return <Check role="img" aria-label="Copied" className={cn("size-3.5 shrink-0 text-cf-success-text", className)} data-testid="plugin-copied" />;
}
