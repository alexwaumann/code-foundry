import { useState, type ComponentType, type ReactNode } from "react";
import { Calendar, CalendarClock, Clock, Sun, type LucideIcon } from "lucide-react";
import { snoozePresets, type SnoozePresetId } from "@/lib/snooze";
import { snoozeThread } from "@/stores/threadActions";
import { openSnoozeDialog } from "@/stores/snoozeDialog";

const presetIcons: Readonly<Record<SnoozePresetId, LucideIcon>> = { "1h": Clock, "3h": Clock, tomorrow: Sun, "next-week": Calendar };

/** A menu item as the snooze items need it: a context menu's or a dropdown's. */
type MenuItem = ComponentType<{ onSelect: () => void; children?: ReactNode; "data-testid"?: string; "data-preset"?: string }>;

/**
 * The snooze presets (lib/snooze.ts snoozePresets, computed when the menu opens), each with
 * its resolved time on the right, then "Pick a date and time…" (the custom dialog). A
 * preset invokes thread.snooze with the absolute time (snoozeThread); the daemon asks
 * for confirmation only mid-turn. The Snooze submenu of a thread's menu
 * (components/thread/ThreadMenuItems.tsx).
 */
export function SnoozePresetItems({ id, Item, Separator }: { id: string; Item: MenuItem; Separator: ComponentType }) {
  // Mounted when the menu opens: the times are as of then.
  const [now] = useState(() => Date.now());
  return (
    <>
      {snoozePresets(now).map((p) => {
        const Icon = presetIcons[p.id];
        return (
          <Item
            key={p.id}
            data-testid="snooze-preset"
            data-preset={p.id}
            onSelect={() => {
              void snoozeThread(id, p.untilMs);
            }}
          >
            <Icon />
            {p.label}
            <span className="ml-auto pl-6 text-caption tabular-nums" data-testid="snooze-preset-time">
              {p.hint}
            </span>
          </Item>
        );
      })}
      <Separator />
      <Item
        data-testid="snooze-pick"
        onSelect={() => {
          openSnoozeDialog(id);
        }}
      >
        <CalendarClock />
        Pick a date and time…
      </Item>
    </>
  );
}
