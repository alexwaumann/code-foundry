/**
 * What the overlay's plate shows, from what the daemon says
 * (docs/notes/dictate-anywhere-overlay.md). Pure: the controller feeds it the events of one
 * session and gives the phase to the scope.
 */
import type { DictationEndView } from "@/api/dictation";
import type { ScopePhase } from "./scope";

export interface OverlayState {
  phase: ScopePhase | "hidden";
  /** The session on the plate; "" while hidden. */
  sessionId: string;
}

export const HIDDEN: OverlayState = { phase: "hidden", sessionId: "" };

export type OverlayEvent =
  /** The host showed the window for a session. */
  | { kind: "begin"; sessionId: string }
  /** Watch says this session is stopping with a flush. */
  | { kind: "stopping"; sessionId: string }
  | { kind: "ended"; sessionId: string; reason: DictationEndView }
  /** The session's stream gave up without an end (the daemon restarted). */
  | { kind: "lost"; sessionId: string }
  /** The plate has faded out. */
  | { kind: "finished" };

/** How a session's end looks. Only a flush reports done, seen as working or not: Stop's reply can beat Watch's snapshot. */
const endPhase: Record<DictationEndView, ScopePhase> = {
  stopped: "done",
  error: "failed",
  discarded: "collapsing",
  silence: "collapsing",
  disabled: "collapsing",
};

export function reduceOverlay(s: OverlayState, ev: OverlayEvent): OverlayState {
  if (ev.kind === "begin") return s.sessionId === ev.sessionId ? s : { phase: "listening", sessionId: ev.sessionId };
  if (ev.kind === "finished") return HIDDEN;
  // Events of a session that has been replaced.
  if (ev.sessionId !== s.sessionId) return s;
  const open = s.phase === "listening" || s.phase === "working";
  if (!open) return s;
  switch (ev.kind) {
    case "stopping":
      return { ...s, phase: "working" };
    case "ended":
      return { ...s, phase: endPhase[ev.reason] };
    case "lost":
      return { ...s, phase: "collapsing" };
  }
}
