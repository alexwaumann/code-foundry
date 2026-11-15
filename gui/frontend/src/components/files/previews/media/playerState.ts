/**
 * The player's state as the media element reports it, and what it does with an error. Pure:
 * the player (MediaPlayer.tsx) dispatches the element's events here and acts on the outcome
 * of `errorOutcome` itself (asks for a new URL, or shows the cannot-play state).
 */
import { bufferedEnd, type MediaFacts, type Range } from "./mediaFormat";

export type PlayerStatus = "loading" | "ready" | "unplayable" | "failed";

export interface PlayerState {
  status: PlayerStatus;
  /**
   * The URL on the element is a new grant that has not loaded metadata yet. An error now is
   * the file's (WebKit cannot decode it, or the daemon refuses it), not an expired URL's: an
   * older grant that loaded once and then fails is asked for again first.
   */
  fresh: boolean;
  playing: boolean;
  /** The element's currentTime as last reported, in seconds. */
  time: number;
  /** Where the buffered stretch at the playhead ends (mediaFormat.ts bufferedEnd). */
  buffered: number;
  /** From the first loadedmetadata of the file; kept across a re-grant so the meta does not flicker. */
  facts: MediaFacts | null;
  /** The scrubber's value while it is dragged: timeupdate moves `time`, never the thumb under the pointer. */
  scrub: number | null;
}

export const initialPlayerState: PlayerState = { status: "loading", fresh: true, playing: false, time: 0, buffered: 0, facts: null, scrub: null };

export type PlayerEvent =
  /** A new URL is on the element (a first grant, a re-grant, a reload). */
  | { type: "source" }
  | { type: "meta"; facts: MediaFacts }
  | { type: "duration"; duration: number }
  | { type: "time"; time: number; ranges: readonly Range[] }
  | { type: "progress"; ranges: readonly Range[] }
  | { type: "play" }
  | { type: "pause" }
  | { type: "ended" }
  /** A seek from the keyboard or the end of a drag: the clock shows it before timeupdate does. */
  | { type: "seek"; time: number }
  | { type: "scrub"; value: number }
  | { type: "scrubEnd" }
  | { type: "unplayable" }
  | { type: "failed" };

export function playerReducer(s: PlayerState, e: PlayerEvent): PlayerState {
  switch (e.type) {
    case "source":
      return { ...s, status: "loading", fresh: true, playing: false, scrub: null };
    case "meta":
      return { ...s, status: "ready", fresh: false, facts: e.facts };
    case "duration":
      return s.facts ? { ...s, facts: { ...s.facts, duration: e.duration } } : s;
    case "time":
      return { ...s, time: e.time, buffered: bufferedEnd(e.ranges, e.time) };
    case "progress":
      return { ...s, buffered: bufferedEnd(e.ranges, s.time) };
    case "play":
      return { ...s, playing: true };
    case "pause":
      return { ...s, playing: false };
    case "ended":
      return { ...s, playing: false, time: s.facts && Number.isFinite(s.facts.duration) ? s.facts.duration : s.time };
    case "seek":
      return { ...s, time: e.time };
    case "scrub":
      return { ...s, scrub: e.value };
    case "scrubEnd":
      return s.scrub === null ? s : { ...s, time: s.scrub, scrub: null };
    case "unplayable":
      return { ...s, status: "unplayable", playing: false };
    case "failed":
      return { ...s, status: "failed", playing: false };
  }
}

/** MediaError.code values (the element's error). */
export const MEDIA_ERR = { aborted: 1, network: 2, decode: 3, srcNotSupported: 4 } as const;

/**
 * What an element error means:
 *  - "ignore": the load was stopped on purpose (a new URL replaced it, the player let go).
 *  - "regrant": a URL that loaded before failed: the daemon restarted (its grants die with it,
 *    and the route answers 404, which WebKit reports as "not supported") or the connection
 *    dropped. Ask for a new URL and pick up where it was.
 *  - "unplayable": a new URL failed before its metadata loaded: WebKit cannot play this file.
 *  - "failed": a new URL's connection failed: the daemon is not answering.
 */
export function errorOutcome(s: Pick<PlayerState, "fresh">, code: number): "ignore" | "regrant" | "unplayable" | "failed" {
  if (code === MEDIA_ERR.aborted) return "ignore";
  if (!s.fresh) return "regrant";
  return code === MEDIA_ERR.network ? "failed" : "unplayable";
}

/** The scrubber's position: the drag's value while dragging, else the clock. */
export function scrubberValue(s: Pick<PlayerState, "scrub" | "time">): number {
  return s.scrub ?? s.time;
}
