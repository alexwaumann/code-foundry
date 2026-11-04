import { decayLevels, easeLevels, LEVEL_GAP_MS, levelOf } from "@/lib/dictation";

/**
 * The microphone's level for the scope. Levels arrive about 10 a second, so the scope
 * follows them eased, on the composers' dBFS scale; once they stop it falls back.
 */
export class LevelFollower {
  private target = 0;
  private shown = 0;
  private sinceMs = Infinity;

  /** A level event's rms, 0..1 of full scale. */
  push(rms: number): void {
    this.target = levelOf(rms);
    this.sinceMs = 0;
  }

  /** The level `dtMs` after the last call, 0..1. */
  advance(dtMs: number): number {
    this.sinceMs += dtMs;
    if (this.sinceMs > LEVEL_GAP_MS) this.target = decayLevels([this.target], dtMs)[0] ?? 0;
    this.shown = easeLevels([this.shown], [this.target], dtMs)[0] ?? 0;
    return this.shown;
  }
}
