import { createContext, type FocusEvent, type PointerEvent, useContext, useSyncExternalStore } from "react";

/**
 * Which turn the pointer is over and which one holds the keyboard focus, in a thread's
 * timeline (docs/notes/turn-gutter.md): an older turn's gutter shows only then. A turn's
 * rows are separate rows of the virtualized list, so no CSS :hover spans them; the list
 * marks each row with its turn (`data-turn`, lib/threadTimeline rowTurns) and reports
 * pointer and focus moves here. One store per list; a gutter subscribes to whether its
 * own turn is active, so a move re-renders only the two gutters it changes.
 */
export interface TurnActivity {
  /** The turn the pointer is over; "" for none. */
  hovered: () => string;
  /** The turn whose control has the keyboard focus; "" for none. */
  focused: () => string;
  setHovered: (turn: string) => void;
  setFocused: (turn: string) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createTurnActivity(): TurnActivity {
  let hovered = "";
  let focused = "";
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const l of listeners) l();
  };
  return {
    hovered: () => hovered,
    focused: () => focused,
    setHovered: (turn) => {
      if (turn === hovered) return;
      hovered = turn;
      emit();
    },
    setFocused: (turn) => {
      if (turn === focused) return;
      focused = turn;
      emit();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The list's activity; null outside a thread's timeline (a gutter there is never hovered). */
export const TurnActivityContext = createContext<TurnActivity | null>(null);

const never = () => () => undefined;

/** Whether the pointer is over a turn or one of its controls has the keyboard focus. */
export function useTurnActive(turn: string): boolean {
  const a = useContext(TurnActivityContext);
  return useSyncExternalStore(a ? a.subscribe : never, () => (a !== null && turn !== "" && (a.hovered() === turn || a.focused() === turn)));
}

/** The turn of the row an event happened in ("" outside any). */
function turnAt(target: EventTarget | null): string {
  return target instanceof Element ? (target.closest<HTMLElement>("[data-turn]")?.dataset.turn ?? "") : "";
}

/** Whether a focused element shows the keyboard focus (a click on a button in some engines focuses it too). */
function keyboardFocus(el: EventTarget): boolean {
  if (!(el instanceof Element)) return false;
  try {
    return el.matches(":focus-visible");
  } catch {
    return true; // an engine without :focus-visible
  }
}

/** The handlers for the element holding the rows (the list's column). */
export function turnActivityHandlers(a: TurnActivity) {
  return {
    onPointerOver: (e: PointerEvent<HTMLElement>) => {
      a.setHovered(turnAt(e.target));
    },
    onPointerLeave: () => {
      a.setHovered("");
    },
    onFocus: (e: FocusEvent<HTMLElement>) => {
      a.setFocused(keyboardFocus(e.target) ? turnAt(e.target) : "");
    },
    onBlur: () => {
      a.setFocused("");
    },
  };
}
