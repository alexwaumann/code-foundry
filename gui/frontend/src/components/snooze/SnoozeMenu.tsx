import { useState, type ComponentType, type ReactNode } from "react";
import { snoozePresets } from "@/lib/snooze";
import { saveThreadForLater, snoozeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { openSnoozeDialog, openSnoozeDialogFor } from "@/stores/snoozeDialog";
import { saveThreadsForLater, snoozeThreads } from "@/stores/bulkThreadActions";

/** A menu item as the snooze items need it: a context menu's or a dropdown's. */
type MenuItem = ComponentType<{ onSelect: () => void; children?: ReactNode; "data-testid"?: string; "data-preset"?: string }>;

/**
 * The snooze presets (lib/snooze.ts snoozePresets, computed when the menu opens), each with
 * its resolved time on the right, then "Pick a date and time" (the custom dialog) and
 * "Save for later" (no wake time; left out of a thread already saved). A preset invokes thread.snooze with the absolute time (snoozeThread); the daemon asks
 * for confirmation only mid-turn. The Snooze submenu of a thread's menu
 * (components/thread/ThreadMenuItems.tsx) and the row's Snooze button. The row shows the
 * snooze (it leaves for Snoozed), so no success toast from the row's button and menu
 * (`inView`, the default); the thread header's menu passes false: the snooze closes the
 * thread's tab and the sidebar may be hidden, so it toasts (docs/notes/toast-success-rule.md).
 * `ids`: the sidebar's selection (its bulk menu): every item is one thread.snooze --ids for all
 * of them, and Save for later is left out once one of them is saved.
 */
export function SnoozePresetItems({ id, ids, Item, Separator, onPreset, inView = true }: { id: string; ids?: readonly string[]; Item: MenuItem; Separator: ComponentType; onPreset?: () => void; inView?: boolean }) {
  // Mounted when the menu opens: the times are as of then.
  const [now] = useState(() => Date.now());
  const list = ids ?? [id];
  const many = list.length > 1;
  const saved = useThreadsStore((s) => list.some((t) => (s.byId[t]?.savedAtMs ?? null) !== null));
  return (
    <>
      {snoozePresets(now).map((p) => (
        <Item
          key={p.id}
          data-testid="snooze-preset"
          data-preset={p.id}
          onSelect={() => {
            onPreset?.();
            void (many ? snoozeThreads(list, p.untilMs) : snoozeThread(id, p.untilMs, { inView }));
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
          if (many) openSnoozeDialogFor(list);
          else openSnoozeDialog(id);
        }}
      >
        Pick a date and time
      </Item>
      {!saved && (
        <Item
          data-testid="snooze-save"
          onSelect={() => {
            onPreset?.();
            void (many ? saveThreadsForLater(list) : saveThreadForLater(id, { inView }));
          }}
        >
          Save for later
          <span className="ml-auto pl-6 text-caption" data-testid="snooze-save-hint">
            No alarm
          </span>
        </Item>
      )}
    </>
  );
}
