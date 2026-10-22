/** The pieces Settings → Skills' rows share: pills, the version line, a plugin's skills, a failure under a row. */
import { ChevronDown, ChevronRight, X } from "lucide-react";
import type { SkillKindView } from "@/api/skill";
import { tonePill } from "@/components/plugin/tones";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { dismissSkillFailure, useSkillFailure } from "@/stores/skill";
import { skillCount, versionWords, type SkillPill } from "./model";

/** A tinted pill (state, tier) or an outlined one (kind). */
export function Pill({ pill, outline = false, className, testId }: { pill: SkillPill | null; outline?: boolean; className?: string; testId?: string }) {
  if (!pill?.label) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 text-caption-sm font-medium whitespace-nowrap",
        outline ? "border border-cf-border text-cf-text-muted" : tonePill[pill.tone],
        className,
      )}
      data-testid={testId}
      data-tone={pill.tone || undefined}
    >
      {pill.label}
    </span>
  );
}

/** A plugin's version, or a skill's YYYYMMDD and how long ago (re-reads the clock once a minute). */
export function VersionText({ kind, version, lastUpdatedMs, className }: { kind: SkillKindView; version: string; lastUpdatedMs: number | null; className?: string }) {
  const now = useNow(60_000);
  const words = versionWords({ kind, version, lastUpdatedMs }, now);
  if (!words) return null;
  return (
    <span className={cn("shrink-0 font-mono text-caption-sm tabular-nums", className)} data-testid="skill-version">
      {words}
    </span>
  );
}

/** "N skills ▸": a plugin's skills, expanding in place to their names. */
export function PluginSkills({ skills, open, onToggle }: { skills: readonly string[]; open: boolean; onToggle: () => void }) {
  if (skills.length === 0) return null;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <button
        type="button"
        className="flex w-fit items-center gap-0.5 rounded-sm text-caption-sm outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
        aria-expanded={open}
        onClick={onToggle}
        data-testid="skill-plugin-skills"
      >
        {skillCount(skills.length)}
        <Chevron className="size-3" aria-hidden />
      </button>
      {open && (
        <ul className="flex min-w-0 flex-wrap gap-1" data-testid="skill-plugin-skill-list">
          {skills.map((s) => (
            <li key={s} className="rounded-sm bg-cf-surface-sunken px-1.5 font-mono text-caption-sm">
              {s}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The last failed action on a row (the daemon's words), red under it, with a dismiss ×. */
export function FailureLine({ itemKey }: { itemKey: string }) {
  const f = useSkillFailure(itemKey);
  if (!f) return null;
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-error" role="alert" data-testid="skill-failure" data-action={f.action}>
      <span className="min-w-0 flex-1 break-words">{f.message}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="shrink-0 text-cf-text-muted hover:text-cf-text"
        aria-label="Dismiss"
        onClick={() => {
          dismissSkillFailure(itemKey);
        }}
        data-testid="skill-failure-dismiss"
      >
        <X aria-hidden />
      </Button>
    </p>
  );
}

/** The amber-outlined main action of a row (no filled buttons), as the plugin page's. */
export const mainAction = "bg-transparent dark:bg-transparent border-cf-warning/40 text-cf-warning hover:bg-cf-warning-surface hover:text-cf-warning dark:border-cf-warning/40";

/** A muted ghost action. */
export const quietAction = "text-cf-text-muted hover:text-cf-text";
