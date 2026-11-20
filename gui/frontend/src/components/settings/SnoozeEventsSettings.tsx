import { useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { SnoozeEventIcon } from "@/components/snooze/SnoozeEventIcon";
import { formatSnoozeEventsSetting, parseSnoozeEventsSetting, pluginEventKey, PR_EVENTS, SNOOZE_EVENTS_KEY } from "@/lib/snoozeEvents";
import { cn } from "@/lib/utils";
import { usePluginsStore } from "@/stores/plugins";
import { saveSettings, useSettingValue } from "@/stores/settings";
import type { SectionFields } from "./model";
import { SectionCard } from "./SectionCard";

/** A row of the card: a checkbox and its words, the plugin's name on the right for a plugin source. */
function EventCheck({ word, label, hint, checked, busy, onChange, className }: { word: string; label: string; hint?: string; checked: boolean; busy: boolean; onChange: (on: boolean) => void; className?: string }) {
  const id = useId();
  return (
    <div className={cn("flex items-center gap-2.5 px-3 py-2", className)} data-testid="snooze-events-row" data-event={word}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={busy}
        onCheckedChange={(c) => {
          onChange(c === true);
        }}
        data-testid="snooze-events-check"
      />
      <Label htmlFor={id} className="min-w-0 flex-1 font-normal">
        <span className="truncate">{label}</span>
      </Label>
      {hint && <span className="shrink-0 text-caption text-cf-text-muted">{hint}</span>}
    </div>
  );
}

/** Every installed plugin's wake sources, by target ("<plugin>/<source>"), sorted: title and the plugin's name. */
function usePluginSources(): { target: string; title: string; pluginName: string }[] {
  const flat = usePluginsStore(useShallow((s) => s.order.flatMap((n) => (s.byName[n]?.wakes ?? []).map((w) => `${n}/${w.name}\t${w.title}\t${s.byName[n]?.displayName ?? n}`))));
  return useMemo(
    () =>
      flat
        .map((line) => {
          const [target = "", title = "", pluginName = ""] = line.split("\t");
          return { target, title, pluginName };
        })
        .sort((a, b) => a.target.localeCompare(b.target)),
    [flat],
  );
}

/**
 * threads.snooze_events as checkboxes (docs/notes/snooze-until-event.md): what is checked, the
 * installed plugins' wake sources, and a change saving the whole list at once. One save at a
 * time (`busy`); a refused one leaves its message.
 */
function useSnoozeEvents() {
  const value = useSettingValue(SNOOZE_EVENTS_KEY);
  const checked = useMemo(() => parseSnoozeEventsSetting(value), [value]);
  const sources = usePluginSources();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (word: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(word);
    else next.delete(word);
    setBusy(true);
    void saveSettings({ [SNOOZE_EVENTS_KEY]: formatSnoozeEventsSetting(next) }).then((res) => {
      setBusy(false);
      setError(res.ok ? null : (res.issues[SNOOZE_EVENTS_KEY] ?? res.error));
    });
  };
  return { checked, sources, busy, error, set };
}

type Events = ReturnType<typeof useSnoozeEvents>;

/**
 * The pull request events (Checks finish, Reviewed and Merged on by default), then each
 * installed plugin's wake sources (off by default), each under its heading.
 */
function EventRows({ events }: { events: Events }) {
  const { checked, sources, busy, set } = events;
  return (
    <>
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1 text-caption text-cf-text-muted">
        <SnoozeEventIcon kind="pull_request" className="size-3.5 shrink-0" />
        Pull requests
      </div>
      {PR_EVENTS.map((e) => (
        <EventCheck
          key={e.condition}
          word={e.condition}
          label={e.label}
          checked={checked.has(e.condition)}
          busy={busy}
          onChange={(on) => {
            set(e.condition, on);
          }}
        />
      ))}
      {sources.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-cf-border px-3 pt-2.5 pb-1 text-caption text-cf-text-muted">
          <SnoozeEventIcon kind="plugin" className="size-3.5 shrink-0" />
          Plugins
        </div>
      )}
      {sources.map((s) => (
        <EventCheck
          key={s.target}
          word={pluginEventKey(s.target)}
          label={s.title}
          hint={s.pluginName}
          checked={checked.has(pluginEventKey(s.target))}
          busy={busy}
          onChange={(on) => {
            set(pluginEventKey(s.target), on);
          }}
        />
      ))}
    </>
  );
}

function EventsError({ message, className }: { message: string | null; className?: string }) {
  if (!message) return null;
  return (
    <p className={cn("text-caption text-cf-error-text", className)} data-testid="snooze-events-error">
      {message}
    </p>
  );
}

/**
 * Settings › General › Events in “Until event”, drawn as the setting's own section
 * (sectionBodies): the checkboxes in the section's card. What is checked is what a Snooze
 * menu's Until event offers; the rest stay under More events.
 */
export function SnoozeEventsSection({ section }: { section: SectionFields }) {
  const events = useSnoozeEvents();
  return (
    <>
      <SectionCard id={section.section.id} heading={section.section.title} description={section.section.description}>
        <div data-setting={SNOOZE_EVENTS_KEY} data-testid="snooze-events-setting">
          <EventRows events={events} />
        </div>
      </SectionCard>
      <EventsError message={events.error} className="mt-1.5 ml-0.5" />
    </>
  );
}

/** The same checkboxes as the setting's editor in a search result's row (keyEditors), in a box of their own. */
export function SnoozeEventsEditor() {
  const events = useSnoozeEvents();
  return (
    <div className="flex flex-col gap-1.5" data-testid="snooze-events-setting">
      <div className="overflow-hidden rounded-md border border-cf-border">
        <EventRows events={events} />
      </div>
      <EventsError message={events.error} />
    </div>
  );
}
