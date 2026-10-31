import { Layers } from "lucide-react";
import type { ProjectKind } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { ProjectKindIcon } from "@/components/icons/ProjectKindIcon";

export function KindIcon({ kind, className }: { kind: ProjectKind; className?: string }) {
  return (
    <span className="flex shrink-0" data-testid="project-kind-icon" data-kind={kind}>
      <ProjectKindIcon kind={kind} className={cn("size-4 text-cf-text-muted", className)} />
    </span>
  );
}

export function WorkspaceIcon({ className }: { className?: string }) {
  return <Layers className={cn("size-4 shrink-0 text-cf-text-muted", className)} aria-hidden />;
}

export type PillTone = "neutral" | "success" | "warning" | "error" | "info";

const PILL_TONE: Record<PillTone, string> = {
  neutral: "bg-cf-control text-cf-text-secondary",
  success: "bg-cf-success-surface text-cf-success-text",
  warning: "bg-cf-warning-surface text-cf-warning-text",
  error: "bg-cf-error-surface text-cf-error-text",
  info: "bg-cf-info-surface text-cf-info-text",
};

/** A small tinted pill: what needs a look (PRs, worktrees to tidy), a checkout's tag, a pull request. */
export function Pill({ tone = "neutral", small = false, className, children, ...rest }: { tone?: PillTone; small?: boolean; className?: string; children: React.ReactNode } & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full whitespace-nowrap tabular-nums [&_svg]:size-3.5",
        small ? "h-4 px-1.5 text-caption-sm [&_svg]:size-3" : "h-5 px-2 text-caption",
        PILL_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** The status dot: green while a thread works, grey otherwise. */
export function StatusDot({ live }: { live: boolean }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", live ? "bg-cf-success" : "bg-cf-border-strong")} data-live={live || undefined} aria-hidden />;
}

/** A section's overline title with its muted detail ("Checkouts · main plus 5 worktrees") and something at the right. */
export function SectionHeader({ label, detail, right, testId }: { label: string; detail?: React.ReactNode; right?: React.ReactNode; testId?: string }) {
  return (
    <div className="mb-2 flex min-h-6 items-center gap-2" data-testid={testId}>
      <span className="text-overline text-cf-text-muted">{label}</span>
      {detail !== undefined && detail !== "" && <span className="min-w-0 truncate text-caption text-cf-text-muted">· {detail}</span>}
      {right !== undefined && <span className="ml-auto flex items-center">{right}</span>}
    </div>
  );
}

/** A text link that runs an action (no navigation): Details' Open in Finder, Copy, Edit. */
export function LinkButton({ children, onClick, testId, className }: { children: React.ReactNode; onClick: () => void; testId?: string; className?: string }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      data-testid={testId}
      className={cn("inline-flex items-center gap-1 text-link hover:underline [&_svg]:size-3.5", className)}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

