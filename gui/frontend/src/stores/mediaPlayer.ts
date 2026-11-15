/**
 * The File tab's video and audio player (components/files/previews/media): volume, mute and
 * playback speed, one choice for every file and every player, so the next file plays as the
 * last one did. Persisted (localStorage "code-foundry.mediaPlayer"); not settings: they are not
 * in the file.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bool, finite, oneOf, persistedRecord } from "./persisted";

/** The speed menu's choices, slowest first. */
export const PLAYBACK_RATES = [0.5, 1, 1.25, 1.5, 2] as const;
export type PlaybackRate = (typeof PLAYBACK_RATES)[number];

/** How much Up and Down change the volume. */
export const VOLUME_STEP = 0.1;

interface MediaPlayerState {
  /** 0 to 1, as HTMLMediaElement.volume. */
  volume: number;
  muted: boolean;
  rate: PlaybackRate;
}

const clampVolume = (v: number) => Math.min(1, Math.max(0, Math.round(v * 100) / 100));

export const useMediaPlayerStore = create<MediaPlayerState>()(
  persist((): MediaPlayerState => ({ volume: 1, muted: false, rate: 1 }), {
    name: "code-foundry.mediaPlayer",
    version: 1,
    // Only known fields of the right type (stores/persisted.ts).
    merge: (persisted, current) => {
      const p = persistedRecord(persisted);
      const volume = finite(p.volume);
      return {
        ...current,
        volume: volume === undefined ? current.volume : clampVolume(volume),
        muted: bool(p.muted, current.muted),
        rate: oneOf<PlaybackRate>(p.rate, PLAYBACK_RATES, current.rate),
      };
    },
  }),
);

/** Sets the volume (clamped to 0..1). Raising it above 0 unmutes, as a player's slider does; 0 leaves mute alone. */
export function setVolume(volume: number): void {
  const v = clampVolume(volume);
  useMediaPlayerStore.setState((s) => ({ volume: v, muted: v > 0 ? false : s.muted }));
}

/** Up or Down: the volume one step louder or quieter, unmuting on the way up. */
export function stepVolume(direction: 1 | -1): void {
  setVolume(useMediaPlayerStore.getState().volume + direction * VOLUME_STEP);
}

export function setMuted(muted: boolean): void {
  useMediaPlayerStore.setState({ muted });
}

/** The speaker's click: mute, or unmute; unmuting at volume 0 brings it back to half so it is audible. */
export function toggleMuted(): void {
  useMediaPlayerStore.setState((s) => (s.muted || s.volume === 0 ? { muted: false, volume: s.volume === 0 ? 0.5 : s.volume } : { muted: true }));
}

export function setPlaybackRate(rate: PlaybackRate): void {
  useMediaPlayerStore.setState({ rate });
}
