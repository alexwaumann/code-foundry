/** The pieces Settings → Skills' rows share: pills, a failure under a row, and what the details say. */
import { X } from "lucide-react";
import { tonePill } from "@/components/plugin/tones";
import { Button } from "@/components/ui/button";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { dismissSkillFailure, useSkillFailure } from "@/stores/skill";
import { versionWords, type SkillPill } from "./model";
import type { SkillKindView } from "@/api/skill";

/** A tinted pill (state, tier) or an outlined one (kind). */
export function Pill({ pill, outline = false, className, testId }: { pill: SkillPill | null; outline?: boolean; className?: string; testId?: string }) {
  if (!pill?.label) return null;
  return (
    <span
      className={cn("shrink-0 rounded-sm px-1.5 text-caption-sm font-medium whitespace-nowrap", outline ? "border border-cf-border text-cf-text-muted" : tonePill[pill.tone], className)}
      data-testid={testId}
      data-tone={pill.tone || undefined}
    >
      {pill.label}
    </span>
  );
}

/** "from X · by Y · 1.3.2, 1.4.0 available": where a row comes from, who by and its version (re-reads the clock once a minute). */
export function SourceLine({
  source,
  by,
  kind,
  version,
  lastUpdatedMs,
  available,
}: {
  source: string;
  by: string;
  kind: SkillKindView;
  version: string;
  lastUpdatedMs: number | null;
  available?: string | undefined;
}) {
  const now = useNow(60_000);
  const ver = versionWords({ kind, version, lastUpdatedMs }, now);
  const words = [source, by ? `by ${by}` : "", ver && available ? `${ver}, ${available} available` : ver || (available ? `${available} available` : "")].filter(Boolean);
  if (words.length === 0) return null;
  return (
    <p className="text-caption-sm break-words" data-testid="skill-source">
      {words.join(" · ")}
    </p>
  );
}

/** A plugin's skills by name. */
export function SkillNames({ skills }: { skills: readonly string[] }) {
  if (skills.length === 0) return null;
  return (
    <p className="text-caption-sm break-words" data-testid="skill-plugin-skills">
      Skills: {skills.join(", ")}
    </p>
  );
}

/** The last failed action on a row (the daemon's words), red under it, with a dismiss ×. */
export function FailureLine({ itemKey }: { itemKey: string }) {
  const f = useSkillFailure(itemKey);
  if (!f) return null;
  return (
    <p className="flex min-w-0 items-start gap-1.5 text-caption-sm text-cf-error-text" role="alert" data-testid="skill-failure" data-action={f.action}>
      <span className="min-w-0 flex-1 break-words">{f.message}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        className="-my-1 shrink-0 text-cf-text-muted hover:text-cf-text"
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
