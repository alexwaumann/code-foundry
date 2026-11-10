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

/**
 * A section's title on the Projects pages (the index, a project's page, a workspace's page):
 * the heading, its row count in parentheses (`count`, left out when undefined), a muted
 * "· hint" (`detail`, truncating) and something at the right (`right`).
 */
export function SectionHeader({ label, count, detail, right, testId }: { label: string; count?: number; detail?: React.ReactNode; right?: React.ReactNode; testId?: string }) {
  return (
    <div className="mb-2 flex min-h-7 items-center gap-2" data-testid={testId}>
      <h2 className="shrink-0 text-title">{label}</h2>
      {count !== undefined && (
        <span className="shrink-0 text-caption text-cf-text-muted tabular-nums" data-testid="section-count">
          ({count})
        </span>
      )}
      {detail !== undefined && detail !== "" && (
        <span className="min-w-0 truncate text-caption text-cf-text-muted" data-testid="section-hint">
          · {detail}
        </span>
      )}
      {right !== undefined && <span className="ml-auto flex shrink-0 items-center gap-1.5 [--wails-draggable:no-drag]">{right}</span>}
    </div>
  );
}

/**
 * The first thing on a project's or workspace's page: its icon (20px), its name and a muted
 * meta line under it, and at the right the page's ⋯ (`right`).
 */
export function TitleBlock({ icon, name, meta, right, testId }: { icon: React.ReactNode; name: string; meta: React.ReactNode; right: React.ReactNode; testId: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3" data-testid={testId}>
      <span className="flex shrink-0 [&_svg]:size-5" aria-hidden>
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <h1 className="truncate text-title" data-testid={`${testId}-name`}>
          {name}
        </h1>
        <div className="flex min-h-5 min-w-0 items-center gap-1.5 text-caption whitespace-nowrap text-cf-text-muted" data-testid={`${testId}-meta`}>
          {meta}
        </div>
      </div>
      <span className="flex shrink-0 items-center">{right}</span>
    </div>
  );
}

/** The meta line's separator. */
export const MetaDot = () => <span aria-hidden>·</span>;
