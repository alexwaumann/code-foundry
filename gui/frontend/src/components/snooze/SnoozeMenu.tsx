import { useState, type ComponentType, type ReactNode } from "react";
import { snoozePresets } from "@/lib/snooze";
import { saveThreadForLater, snoozeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { openSnoozeDialog, openSnoozeDialogFor } from "@/stores/snoozeDialog";
import { saveThreadsForLater, snoozeThreads } from "@/stores/bulkThreadActions";
import { useDefaultSnooze } from "@/stores/snoozeDefault";
import { useCommandChord } from "@/stores/commands";
import { formatChord } from "@/keys/chord";
import type { MenuKit } from "@/components/thread/menuKit";
import { UntilEventMenu } from "./UntilEventMenu";

/** A menu item as the snooze items need it: a context menu's or a dropdown's. */
type MenuItem = ComponentType<{ onSelect: () => void; children?: ReactNode; "data-testid"?: string; "data-preset"?: string }>;

/**
 * The snooze presets (lib/snooze.ts snoozePresets, computed when the menu opens), each with
 * its resolved time on the right, then "Pick a date and time" (the custom dialog) and
 * "Save for later" (no wake time; left out of a thread already saved). A preset invokes thread.snooze with the absolute time (snoozeThread), which never
 * asks for confirmation. The Snooze submenu of a thread's menu
 * (components/thread/ThreadMenuItems.tsx) and the row's Snooze button. The row shows the
 * snooze (it leaves for Snoozed), so no success toast from the row's button and menu
 * (`inView`, the default); the thread header's menu passes false: the snooze closes the
 * thread's tab and the sidebar may be hidden, so it toasts (docs/notes/toast-success-rule.md).
 * `ids`: the sidebar's selection (its bulk menu): every item is one thread.snooze --ids for all
 * of them, and Save for later is left out once one of them is saved. Given `kit`, a single
 * thread's menu ends with Until event (UntilEventMenu, docs/notes/snooze-until-event.md); the
 * bulk menu stays with times, since each thread waits on its own pull requests.
 * The default snooze's item (Settings, threads.default_snooze) says "default" after its label,
 * with Snooze to Default's chord in a single thread's menu (the chord acts on the thread in view,
 * not on a selection; docs/notes/put-away-chords.md).
 */
export function SnoozePresetItems({
  id,
  ids,
  Item,
  Separator,
  kit,
  onPreset,
  inView = true,
}: {
  id: string;
  ids?: readonly string[];
  Item: MenuItem;
  Separator: ComponentType;
  /** The menu's parts for a submenu: given, a single thread's menu offers Until event (UntilEventMenu). The bulk menu leaves it out. */
  kit?: MenuKit;
  onPreset?: () => void;
  inView?: boolean;
}) {
  // Mounted when the menu opens: the times are as of then.
  const [now] = useState(() => Date.now());
  const list = ids ?? [id];
  const many = list.length > 1;
  // A thread snoozed until an event is saved too (no wake time), but not "saved for later".
  const saved = useThreadsStore((s) => list.some((t) => (s.byId[t]?.savedAtMs ?? null) !== null && !s.byId[t]?.snoozeEvent));
  const byDefault = useDefaultSnooze();
  const chord = useCommandChord("thread.snooze.default");
  const mark = <DefaultMark chord={many ? "" : chord} />;
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
          {p.id === byDefault && mark}
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
          {byDefault === "save" && mark}
          <span className="ml-auto pl-6 text-caption" data-testid="snooze-save-hint">
            No alarm
          </span>
        </Item>
      )}
      {kit && !many && <UntilEventMenu id={id} kit={kit} inView={inView} {...(onPreset ? { onPreset } : {})} />}
    </>
  );
}

/** The default snooze's quiet mark after an item's label: "default" and the chord that snoozes there, if bound. */
function DefaultMark({ chord }: { chord: string }) {
  return (
    <span className="text-caption text-cf-text-muted" data-testid="snooze-default">
      default{chord && <span className="ml-1.5 tracking-widest">{formatChord(chord)}</span>}
    </span>
  );
}
