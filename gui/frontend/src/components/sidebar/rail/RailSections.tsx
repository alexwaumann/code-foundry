import { AlarmClock, Check, CircleDashed, type LucideIcon } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { rowToneClasses, statusRegistry } from "@/lib/statusRegistry";
import type { FooterSection } from "@/lib/tree";
import { cn } from "@/lib/utils";

/**
 * The rail's Working, Snoozed and Archived (docs/notes/sidebar-rail.md): one icon each, shown
 * while the expanded sidebar shows that section, no count on the rail. Each is its own small
 * component so it can grow a hover card listing its rows; until then the tooltip names the
 * section and its count. Their icons: Working the working status's, in its colour; Snoozed and
 * Archived those of the row's own Snooze and Archive actions (SidebarRow RowActions).
 */

const LABELS: Readonly<Record<FooterSection, string>> = { working: "Working", snoozed: "Snoozed", archived: "Archived" };

function RailSectionIcon({ section, count, icon: Icon, tone }: { section: FooterSection; count: number; icon: LucideIcon; tone: string }) {
  const label = `${LABELS[section]} · ${String(count)}`;
  return (
    <Tip label={label} side="right">
      <span role="img" aria-label={label} className="flex h-[26px] w-7 shrink-0 items-center justify-center rounded-md" data-testid={`rail-${section}`} data-count={count}>
        <Icon className={cn("size-4 shrink-0", tone)} aria-hidden />
      </span>
    </Tip>
  );
}

export function RailWorking({ count }: { count: number }) {
  return <RailSectionIcon section="working" count={count} icon={statusRegistry.working.icon ?? CircleDashed} tone={rowToneClasses[statusRegistry.working.tone]} />;
}

export function RailSnoozed({ count }: { count: number }) {
  return <RailSectionIcon section="snoozed" count={count} icon={AlarmClock} tone="text-cf-icon-muted" />;
}

export function RailArchived({ count }: { count: number }) {
  return <RailSectionIcon section="archived" count={count} icon={Check} tone="text-cf-icon-muted" />;
}
