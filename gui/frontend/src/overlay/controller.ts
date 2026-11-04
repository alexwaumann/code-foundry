import type { DictationEndView } from "@/api/dictation";
import { LevelFollower } from "./levels";
import { HIDDEN, reduceOverlay, type OverlayEvent, type OverlayState } from "./phases";
import { Scope, SCOPE_STEP, type ScopeColours } from "./scope";

/** How often a showing plate rereads the theme, so a change reaches it while it shows. */
export const THEME_POLL_MS = 1_000;
/** The longest step taken after a stall (a frame the system held back), ms. */
const MAX_FRAME_MS = 100;

/** What the controller needs from the page: the DOM, the host and the daemon. */
export interface OverlayDeps {
  requestFrame: (cb: (nowMs: number) => void) => number;
  /** Follows a session until the returned stop is called. */
  follow: (
    sessionId: string,
    h: { onStopping: () => void; onLevel: (rms: number) => void; onEnded: (reason: DictationEndView) => void; onLost: () => void },
  ) => () => void;
  /** The theme's colours now; null when it cannot say. */
  colours: () => Promise<ScopeColours | null>;
  paint: (scope: Scope, colours: ScopeColours) => void;
  /** Leaves the canvas empty, for the next show. */
  clear: () => void;
  /** Asks the host to hide the panel. */
  done: (sessionId: string) => void;
}

/**
 * Plays sessions on the plate. While hidden it holds no stream, no timer and no animation
 * frame; `begin` starts all three and the plate fading out ends them.
 */
export class OverlayController {
  private state: OverlayState = HIDDEN;
  private scope = new Scope();
  private levels = new LevelFollower();
  private colours: ScopeColours | null = null;
  private stopFollowing: (() => void) | null = null;
  private frame: number | null = null;
  private lastMs: number | null = null;
  private owedSeconds = 0;
  private themePoll: ReturnType<typeof setInterval> | null = null;
  private readonly deps: OverlayDeps;

  constructor(deps: OverlayDeps) {
    this.deps = deps;
  }

  /** The host showed the panel for a session. A second call for the same one is nothing. */
  begin(sessionId: string): void {
    if (this.state.sessionId === sessionId) return;
    this.stopFollowing?.();
    if (this.state.phase === "hidden") {
      this.scope = new Scope();
      this.levels = new LevelFollower();
      this.owedSeconds = 0;
      this.lastMs = null;
    }
    this.apply({ kind: "begin", sessionId });
    this.stopFollowing = this.deps.follow(sessionId, {
      onStopping: () => {
        this.apply({ kind: "stopping", sessionId });
      },
      onLevel: (rms) => {
        if (this.state.sessionId === sessionId) this.levels.push(rms);
      },
      onEnded: (reason) => {
        this.apply({ kind: "ended", sessionId, reason });
        this.unfollow();
      },
      onLost: () => {
        this.apply({ kind: "lost", sessionId });
        this.unfollow();
      },
    });
    this.refreshColours();
    this.themePoll ??= setInterval(() => {
      this.refreshColours();
    }, THEME_POLL_MS);
    this.frame ??= this.deps.requestFrame(this.onFrame);
  }

  private apply(ev: OverlayEvent): void {
    this.state = reduceOverlay(this.state, ev);
    if (this.state.phase !== "hidden") this.scope.setPhase(this.state.phase);
  }

  private unfollow(): void {
    this.stopFollowing?.();
    this.stopFollowing = null;
  }

  private refreshColours(): void {
    this.deps.colours().then(
      (c) => {
        if (c) this.colours = c;
      },
      (err: unknown) => {
        // The last colours stand; the next poll tries again.
        console.warn("overlay theme", err);
      },
    );
  }

  private readonly onFrame = (nowMs: number): void => {
    this.frame = null;
    const dtMs = this.lastMs === null ? 0 : Math.min(MAX_FRAME_MS, nowMs - this.lastMs);
    this.lastMs = nowMs;
    const input = this.levels.advance(dtMs);
    this.owedSeconds += dtMs / 1000;
    while (this.owedSeconds >= SCOPE_STEP) {
      this.owedSeconds -= SCOPE_STEP;
      this.scope.step(this.state.phase === "listening" ? input : 0);
    }
    if (this.scope.gone) {
      this.finish();
      return;
    }
    if (this.colours) this.deps.paint(this.scope, this.colours);
    this.frame = this.deps.requestFrame(this.onFrame);
  };

  private finish(): void {
    const { sessionId } = this.state;
    this.unfollow();
    if (this.themePoll !== null) clearInterval(this.themePoll);
    this.themePoll = null;
    this.apply({ kind: "finished" });
    this.deps.clear();
    this.deps.done(sessionId);
  }
}
