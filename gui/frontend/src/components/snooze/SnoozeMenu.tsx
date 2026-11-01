import { useState, type ComponentType, type ReactNode } from "react";
import { snoozePresets } from "@/lib/snooze";
import { snoozeThread } from "@/stores/threadActions";
import { openSnoozeDialog } from "@/stores/snoozeDialog";

/** A menu item as the snooze items need it: a context menu's or a dropdown's. */
type MenuItem = ComponentType<{ onSelect: () => void; children?: ReactNode; "data-testid"?: string; "data-preset"?: string }>;

/**
 * The snooze presets (lib/snooze.ts snoozePresets, computed when the menu opens), each with
 * its resolved time on the right, then "Pick a date and time" (the custom dialog). A
 * preset invokes thread.snooze with the absolute time (snoozeThread); the daemon asks
 * for confirmation only mid-turn. The Snooze submenu of a thread's menu
 * (components/thread/ThreadMenuItems.tsx).
 */
export function SnoozePresetItems({ id, Item, Separator, onPreset }: { id: string; Item: MenuItem; Separator: ComponentType; onPreset?: () => void }) {
  // Mounted when the menu opens: the times are as of then.
  const [now] = useState(() => Date.now());
  return (
    <>
      {snoozePresets(now).map((p) => (
        <Item
          key={p.id}
          data-testid="snooze-preset"
          data-preset={p.id}
          onSelect={() => {
            onPreset?.();
            void snoozeThread(id, p.untilMs);
          }}
        >
          {p.label}
          <span className="ml-auto pl-6 text-caption tabular-nums" data-testid="snooze-preset-time">
            {p.hint}
          </span>
        </Item>
      ))}
      <Separator />
      <Item
        data-testid="snooze-pick"
        onSelect={() => {
          openSnoozeDialog(id);
        }}
      >
        Pick a date and time
      </Item>
    </>
  );
}
