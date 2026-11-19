import { Fragment } from "react";
import type { MenuKit } from "@/components/thread/menuKit";
import { SnoozeEventIcon } from "./SnoozeEventIcon";
import { hasSnoozeEvents, parseSnoozeEventsSetting, SNOOZE_EVENTS_KEY, untilEventMenu } from "@/lib/snoozeEvents";
import { openSnoozeEventPicker, snoozeThreadUntilEvent, useSnoozeEvents } from "@/stores/snoozeEvents";
import { openSnoozeEventsSettings } from "@/stores/snoozeEventsSettings";
import { useSettingValue } from "@/stores/settings";

/**
 * "Until event" in a thread's Snooze menu (docs/notes/snooze-until-event.md): a submenu of the
 * events the thread can wait on now (thread.snooze.events, read as the menu opens), as the
 * setting threads.snooze_events and the recent plugin events pick them (lib/snoozeEvents.ts
 * untilEventMenu): up to three pull requests, each a label line "#812 Title" over its events,
 * then up to three plugin events with the plugin's name on the right; then More events… (the
 * searchable list of all of them) and Choose what shows here… (Settings at its section).
 * Nothing while the read is out, or when the thread has nothing to wait on. A pick is
 * thread.snooze --until-pr/--until-plugin.
 */
export function UntilEventMenu({ id, kit, inView, onPreset }: { id: string; kit: MenuKit; inView: boolean; onPreset?: () => void }) {
  const evs = useSnoozeEvents(id);
  const setting = useSettingValue(SNOOZE_EVENTS_KEY);
  if (!evs || !hasSnoozeEvents(evs)) return null;
  const menu = untilEventMenu(evs, parseSnoozeEventsSetting(setting));
  const listed = menu.pullRequests.length > 0 || menu.plugins.length > 0;
  return (
    <kit.Sub>
      <kit.SubTrigger data-testid="snooze-until-event">Until event</kit.SubTrigger>
      <kit.SubContent className="max-w-80 min-w-56" data-testid="snooze-events">
        {menu.pullRequests.map((pr) => (
          <Fragment key={pr.target}>
            <kit.Label className="flex min-w-0 items-center gap-1.5 text-caption text-cf-text-muted">
              <SnoozeEventIcon kind="pull_request" className="size-3.5 shrink-0" />
              <span className="shrink-0 tabular-nums">#{pr.number}</span>
              <span className="truncate" data-testid="snooze-event-pr-title">
                {pr.title}
              </span>
            </kit.Label>
            {pr.events.map((e) => (
              <kit.Item
                key={e.condition}
                data-testid="snooze-event"
                data-event={`${pr.target} ${e.condition}`}
                onSelect={() => {
                  onPreset?.();
                  void snoozeThreadUntilEvent(id, { kind: "pull_request", target: pr.target, condition: e.condition }, { inView });
                }}
              >
                {e.label}
              </kit.Item>
            ))}
          </Fragment>
        ))}
        {menu.plugins.length > 0 && (
          <kit.Label className="flex items-center gap-1.5 text-caption text-cf-text-muted">
            <SnoozeEventIcon kind="plugin" className="size-3.5 shrink-0" />
            Plugins
          </kit.Label>
        )}
        {menu.plugins.map((p) => (
          <kit.Item
            key={p.target}
            data-testid="snooze-event"
            data-event={p.target}
            onSelect={() => {
              onPreset?.();
              void snoozeThreadUntilEvent(id, { kind: "plugin", target: p.target, args: p.args }, { inView });
            }}
          >
            <span className="truncate">{p.title}</span>
            <span className="ml-auto shrink-0 pl-6 text-caption text-cf-text-muted" data-testid="snooze-event-plugin">
              {p.pluginName}
            </span>
          </kit.Item>
        ))}
        {listed && <kit.Separator />}
        <kit.Item
          data-testid="snooze-more-events"
          onSelect={() => {
            openSnoozeEventPicker(id, inView);
          }}
        >
          More events…
        </kit.Item>
        <kit.Item data-testid="snooze-choose-events" onSelect={openSnoozeEventsSettings}>
          Choose what shows here…
        </kit.Item>
      </kit.SubContent>
    </kit.Sub>
  );
}
