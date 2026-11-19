/**
 * "Choose what shows here…" in the Until event menu (docs/notes/snooze-until-event.md): Settings
 * on General, scrolled to the section of threads.snooze_events with its first checkbox focused
 * (components/settings/focus.ts focusSetting, once the page has drawn it).
 */
import { focusSetting } from "@/components/settings/focus";
import { SNOOZE_EVENTS_KEY } from "@/lib/snoozeEvents";
import { openSettingsPage } from "./views";

/** How many frames to wait for the settings page to draw the section. */
const FRAMES = 30;

export function openSnoozeEventsSettings(): void {
  openSettingsPage("general");
  let left = FRAMES;
  const tryFocus = () => {
    if (focusSetting(SNOOZE_EVENTS_KEY) || --left <= 0) return;
    requestAnimationFrame(tryFocus);
  };
  requestAnimationFrame(tryFocus);
}
