import { useState, useSyncExternalStore } from "react";

/**
 * What a thread's timeline tells the row above its composer (ComposerRow,
 * docs/notes/composer-row-pill.md): whether the list is scrolled away from its bottom, how to
 * jump back there, and the live turn's message (the turn header's `since`, for the elapsed
 * time). One per thread view, made by the view and handed to both; a value only, so the view
 * itself does not re-render when the list scrolls.
 */
export class TimelineBridge {
  private away = false;
  private since = "";
  private jumpTo: (() => void) | null = null;
  private readonly listeners = new Set<() => void>();

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** The list is away from its bottom (the Jump to bottom segment shows). */
  setAway(away: boolean): void {
    if (away === this.away) return;
    this.away = away;
    this.emit();
  }

  getAway = (): boolean => this.away;

  /** The live turn header's message id ("" when no turn runs or it has none). */
  setSince(id: string): void {
    if (id === this.since) return;
    this.since = id;
    this.emit();
  }

  getSince = (): string => this.since;

  /** The list's own jump (pin and scroll to the end); null when it unmounts. */
  setJump(fn: (() => void) | null): void {
    this.jumpTo = fn;
  }

  jump(): void {
    this.jumpTo?.();
  }
}

/** A bridge for the life of the calling view. */
export function useTimelineBridge(): TimelineBridge {
  const [bridge] = useState(() => new TimelineBridge());
  return bridge;
}

export function useBridgeAway(bridge: TimelineBridge): boolean {
  return useSyncExternalStore(bridge.subscribe, bridge.getAway);
}

export function useBridgeSince(bridge: TimelineBridge): string {
  return useSyncExternalStore(bridge.subscribe, bridge.getSince);
}
