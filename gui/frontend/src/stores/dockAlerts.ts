/**
 * The Dock badge and attention alerts (docs/notes/dock-alerts.md). macOS notification
 * banners are not available to the bare GUI executable, so the Dock is the channel: the
 * badge counts the threads that need the user, and an alert (a bounce, a sound or both)
 * fires when a thread starts needing them while the user is not looking at the app
 * (another app is active, or its window is covered or minimized).
 *
 * stepDockAlerts is the whole decision, pure: state + inputs -> state + effects.
 * startDockAlerts feeds it from the threads and settings stores and runs the effects
 * against the Wails host (api/app.ts; no-ops without one).
 */
import { bounceDock, playAlertSound, setDockBadge } from "@/api/app";
import type { SettingsSnapshotView } from "@/api/settings";
import { isPageAttended } from "@/api/stream";
import { attentionIds, useThreadsStore } from "./threads";
import { KEYS, showCreatedThreadsOf, useSettingsStore } from "./settings";

/** The notifications.* settings (internal/store/settings/schema.go). */
export const NOTIFY_KEYS = {
  dockBadge: "notifications.dock_badge",
  bounce: "notifications.bounce",
  sound: "notifications.sound",
  soundVolume: "notifications.sound_volume",
  cooldown: "notifications.cooldown_seconds",
} as const;

/** notifications.cooldown_seconds' default in the daemon's schema. */
const DEFAULT_COOLDOWN_SECONDS = 60;
/** notifications.sound_volume's default in the daemon's schema. */
const DEFAULT_SOUND_VOLUME = 50;

export interface AlertSettings {
  dockBadge: boolean;
  bounce: boolean;
  sound: boolean;
  /** The sound's volume in percent of the Mac's output volume, 0–100. */
  soundVolume: number;
  /** Minimum gap between alerts; 0 = none. */
  cooldownMs: number;
}

/**
 * The notifications settings from a snapshot (the daemon fills in every default), or null
 * before the first snapshot: nothing is shown or fired until the user's choices are known,
 * so a badge they turned off never flashes on at startup.
 */
export function alertSettings(snap: SettingsSnapshotView | null): AlertSettings | null {
  if (!snap) return null;
  const v = snap.values;
  // An older daemon without the keys gets the schema's defaults.
  const cooldown = Number(v[NOTIFY_KEYS.cooldown] ?? DEFAULT_COOLDOWN_SECONDS);
  const volume = Number(v[NOTIFY_KEYS.soundVolume] ?? DEFAULT_SOUND_VOLUME);
  return {
    dockBadge: v[NOTIFY_KEYS.dockBadge] !== "false",
    bounce: v[NOTIFY_KEYS.bounce] !== "false",
    sound: v[NOTIFY_KEYS.sound] === "true",
    soundVolume: Number.isFinite(volume) ? Math.min(Math.max(Math.round(volume), 0), 100) : DEFAULT_SOUND_VOLUME,
    cooldownMs: Number.isFinite(cooldown) && cooldown > 0 ? cooldown * 1000 : 0,
  };
}

export interface DockAlertsState {
  /** The threads epoch `attention` was taken in; null before the first evaluation. */
  epoch: number | null;
  /** Thread ids that needed attention at the last evaluation. */
  attention: ReadonlySet<string>;
  /** The badge count last sent to the host; null when none was sent yet. */
  badge: number | null;
  /** When the last alert fired (epoch ms); null when none has. */
  lastAlertAtMs: number | null;
}

export const initialDockAlerts: DockAlertsState = { epoch: null, attention: new Set(), badge: null, lastAlertAtMs: null };

export interface DockAlertsInput {
  /** useThreadsStore's epoch: a change means the set was replaced (startup, reconnect). */
  epoch: number;
  /**
   * attentionIds of the current threads: what the window title counts. Threads hidden
   * from the sidebar (lib/inSidebar.ts) are not in it: they neither badge nor alert.
   */
  attention: readonly string[];
  /**
   * The user is looking at the app: its window is visible and key (isPageAttended). Not
   * when another app is active, nor when Code Foundry's window is covered or minimized.
   */
  attended: boolean;
  nowMs: number;
  settings: AlertSettings | null;
}

/**
 * An alert does every enabled part at once; the cooldown covers it as a whole. `volume`
 * is the sound's (0 when it does not play).
 */
export type DockEffect = { kind: "badge"; count: number } | { kind: "alert"; bounce: boolean; sound: boolean; volume: number };

/**
 * One evaluation. The badge follows the attention count (0 when the badge is off),
 * whatever the focus or cooldown. An alert fires when a thread enters the attention set
 * (absent at the previous evaluation of the same epoch) while the app is not attended,
 * at least one of bounce and sound is on (a sound at volume 0 counts as off), and the
 * cooldown since the last alert has passed. Inside the cooldown the trigger is dropped,
 * not queued. With bounce and sound both off nothing fires and the cooldown is not
 * consumed. The first evaluation, and the first after the epoch changes, only takes the
 * baseline.
 */
export function stepDockAlerts(state: DockAlertsState, input: DockAlertsInput): { state: DockAlertsState; effects: DockEffect[] } {
  const effects: DockEffect[] = [];
  const { settings } = input;
  let badge = state.badge;
  if (settings) {
    const count = settings.dockBadge ? input.attention.length : 0;
    if (count !== badge) {
      effects.push({ kind: "badge", count });
      badge = count;
    }
  }
  let lastAlertAtMs = state.lastAlertAtMs;
  const baseline = state.epoch !== input.epoch;
  const sound = settings !== null && settings.sound && settings.soundVolume > 0;
  if (!baseline && settings && !input.attended && (settings.bounce || sound)) {
    const entered = input.attention.some((id) => !state.attention.has(id));
    const cooled = lastAlertAtMs === null || input.nowMs - lastAlertAtMs >= settings.cooldownMs;
    if (entered && cooled) {
      effects.push({ kind: "alert", bounce: settings.bounce, sound, volume: sound ? settings.soundVolume : 0 });
      lastAlertAtMs = input.nowMs;
    }
  }
  return { state: { epoch: input.epoch, attention: new Set(input.attention), badge, lastAlertAtMs }, effects };
}

export interface DockAlertsDeps {
  setBadge: (count: number) => void;
  bounce: () => void;
  /** Plays the alert sound at volume percent (host-side NSSound, gui/notify_darwin.go). */
  playSound: (volume: number) => void;
  /** Whether the user is looking at the app now (DockAlertsInput.attended). */
  attended: () => boolean;
  now: () => number;
}

const hostDeps: DockAlertsDeps = {
  setBadge: (count) => void setDockBadge(count),
  bounce: () => void bounceDock(),
  playSound: (volume) => void playAlertSound(volume),
  // Visible and key: the same rule as the daemon's attended presence, so the thread
  // open in the main pane, which the daemon no longer acknowledges while the user is
  // away, enters the attention set and alerts (docs/notes/alerts-foreground.md).
  attended: isPageAttended,
  now: () => Date.now(),
};

function sameAlertSettings(a: SettingsSnapshotView | null, b: SettingsSnapshotView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  // threads.show_created_threads moves threads in or out of the attention set.
  return [...Object.values(NOTIFY_KEYS), KEYS.showCreatedThreads].every((k) => a.values[k] === b.values[k]);
}

/** Starts the badge and alerts; returns the stop function. */
export function startDockAlerts(deps: DockAlertsDeps = hostDeps): () => void {
  let state = initialDockAlerts;
  const evaluate = () => {
    const threads = useThreadsStore.getState();
    const next = stepDockAlerts(state, {
      epoch: threads.epoch,
      attention: attentionIds(threads, showCreatedThreadsOf(useSettingsStore.getState().snapshot)),
      attended: deps.attended(),
      nowMs: deps.now(),
      settings: alertSettings(useSettingsStore.getState().snapshot),
    });
    state = next.state;
    for (const e of next.effects) {
      if (e.kind === "badge") {
        deps.setBadge(e.count);
        continue;
      }
      if (e.bounce) deps.bounce();
      if (e.sound) deps.playSound(e.volume);
    }
  };
  evaluate();
  const stops = [
    useThreadsStore.subscribe((s, prev) => {
      if (s.byId !== prev.byId || s.order !== prev.order || s.epoch !== prev.epoch) evaluate();
    }),
    useSettingsStore.subscribe((s, prev) => {
      if (!sameAlertSettings(s.snapshot, prev.snapshot)) evaluate();
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}
