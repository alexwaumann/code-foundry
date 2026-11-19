import { AlarmClock, Check } from "lucide-react";
import { WorkingCircle } from "@/components/status/StatusCircle";
import type { ShellRow } from "@/lib/shellSections";
import { rowToneClasses, statusRegistry } from "@/lib/statusRegistry";
import type { HeaderRow } from "@/lib/tree";
import { RailSectionCard } from "./RailSectionCard";

/**
 * The rail's Working, Snoozed and Archived (docs/notes/sidebar-rail.md): one icon each, shown
 * while the expanded sidebar shows that section, no count on the rail. Hovering one opens its
 * card listing the section's rows (RailSectionCard). Their icons: Working the working status's,
 * in its colour; Snoozed and Archived those of the row's own Snooze and Archive actions
 * (SidebarRow RowActions).
 */

interface RailSectionProps {
  header: HeaderRow;
  rows: readonly ShellRow[];
}

export function RailWorking({ header, rows }: RailSectionProps) {
  return <RailSectionCard section="working" header={header} rows={rows} icon={statusRegistry.working.icon ?? WorkingCircle} tone={rowToneClasses[statusRegistry.working.tone]} />;
}

export function RailSnoozed({ header, rows }: RailSectionProps) {
  return <RailSectionCard section="snoozed" header={header} rows={rows} icon={AlarmClock} tone="text-cf-icon-muted" />;
}

export function RailArchived({ header, rows }: RailSectionProps) {
  return <RailSectionCard section="archived" header={header} rows={rows} icon={Check} tone="text-cf-icon-muted" />;
}
