import type { LucideIcon } from "lucide-react";

/** Body of a surface that is registered but not built yet. */
export function SurfacePlaceholder({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-sm text-muted-foreground" data-testid="surface-placeholder">
      <Icon className="size-5" aria-hidden />
      <p>{title} is not available yet.</p>
    </div>
  );
}
