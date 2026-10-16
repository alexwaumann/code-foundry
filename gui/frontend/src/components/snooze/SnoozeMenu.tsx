import { useState, type ComponentType, type ReactNode } from "react";
import { AlarmClock, AlarmClockOff, Calendar, CalendarClock, Clock, Sun, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { isStartable } from "@/keys/bindings";
import { snoozePresets, type SnoozePresetId } from "@/lib/snooze";
import { useCommandsStore } from "@/stores/commands";
import { SESSION_COMMANDS, snoozeSession } from "@/stores/sessionActions";
import { useSessionsStore } from "@/stores/sessions";
import { openSnoozeDialog } from "@/stores/snoozeDialog";

const presetIcons: Readonly<Record<SnoozePresetId, LucideIcon>> = { "1h": Clock, "3h": Clock, tomorrow: Sun, "next-week": Calendar };

/** A menu item as the snooze items need it: a context menu's or a dropdown's. */
type MenuItem = ComponentType<{ onSelect: () => void; children: ReactNode; "data-testid"?: string; "data-preset"?: string }>;

/**
 * The snooze presets (lib/snooze.ts snoozePresets, computed when the menu opens), each with
 * its resolved time on the right, then "Pick a date and time…" (the custom dialog). A
 * preset invokes session.snooze with the absolute time (snoozeSession); the daemon asks
 * for confirmation only mid-turn. Shared by the row menu's Snooze submenu and the thread
 * header's Snooze button.
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
              void snoozeSession(id, p.untilMs);
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

/**
 * The row menu's snooze items: the Snooze submenu (presets), and Unsnooze for a snoozed
 * thread.
 */
export function SnoozeRowItems({ id, snoozed }: { id: string; snoozed: boolean }) {
  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger data-testid="menu-snooze">
          <AlarmClock />
          Snooze
        </ContextMenuSubTrigger>
        <ContextMenuSubContent data-testid="menu-snooze-presets">
          <SnoozePresetItems id={id} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
        </ContextMenuSubContent>
      </ContextMenuSub>
      {snoozed && (
        <ContextMenuItem
          data-testid="menu-unsnooze"
          onSelect={() => {
            void snoozeSession(id, null);
          }}
        >
          <AlarmClockOff />
          Unsnooze
        </ContextMenuItem>
      )}
    </>
  );
}

/**
 * The thread header's snooze button (icon-only, `AlarmClock`, "Snooze Thread"): opens the
 * presets as a dropdown. While the thread is snoozed it is "Unsnooze Thread"
 * (`AlarmClockOff`) and unsnoozes on click. Hidden when the daemon does not list
 * session.snooze here (an older daemon), like a CommandButton. Keeps focus where it is.
 */
export function SnoozeButton({ sessionId }: { sessionId: string }) {
  const available = useCommandsStore((s) => s.commands.some((c) => c.name === SESSION_COMMANDS.snooze && isStartable(c)));
  const snoozed = useSessionsStore((s) => (s.byId[sessionId]?.snoozedUntilMs ?? null) !== null);
  if (!available) return null;
  const keepFocus = (e: React.MouseEvent) => {
    e.preventDefault();
  };
  if (snoozed)
    return (
      <Tip label="Unsnooze Thread">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Unsnooze Thread"
          tabIndex={-1}
          data-testid="pane-unsnooze"
          onMouseDown={keepFocus}
          onClick={() => {
            void snoozeSession(sessionId, null);
          }}
        >
          <AlarmClockOff aria-hidden className="size-3.5" />
        </Button>
      </Tip>
    );
  return (
    <DropdownMenu modal={false}>
      <Tip label="Snooze Thread">
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="icon-xs" aria-label="Snooze Thread" tabIndex={-1} data-testid="pane-snooze" onMouseDown={keepFocus}>
            <AlarmClock aria-hidden className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" data-testid="pane-snooze-presets">
        <SnoozePresetItems id={sessionId} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
