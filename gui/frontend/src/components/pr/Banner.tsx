import type { ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/** A warning box on a pull request's surface, with an optional action at its end. */
export function Banner({ children, testId, action, className }: { children: ReactNode; testId: string; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("mx-4 flex items-start gap-2 rounded-lg border border-cf-warning/30 bg-cf-warning-surface px-3 py-2 text-caption text-cf-warning-text", className)} role="status" data-testid={testId}>
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {action}
    </div>
  );
}
