import { useEffect, useId, useLayoutEffect, useRef, type RefObject } from "react";
import {
  flushDictationIn,
  micAvailability,
  registerDictationTarget,
  stopDictationIn,
  useDictationSettingOn,
  useDictationStore,
  useHoldDictation,
  type DictationPhase,
  type MicAvailability,
} from "@/stores/dictation";

/** One composer's dictation: what its mic shows, and the hooks its prompt and Send use. */
export interface ComposerDictation {
  clientId: string;
  availability: MicAvailability;
  /** This composer's session phase; null while another composer (or nobody) dictates. */
  phase: DictationPhase | null;
  /** Starting or listening here: the placeholder says "Listening…". */
  listening: boolean;
  /** Escape in the prompt: stops this composer's dictation; true when it did. */
  onEscape: () => boolean;
  /** Send: waits for the last phrase when this composer dictates (resolves at once otherwise). */
  flush: () => Promise<void>;
}

/**
 * A composer's dictation (docs/notes/dictation-4-gui.md): holds the snapshot while
 * dictation is on, registers the composer for phrases and ⌘⇧M, and shows the marker in
 * the prompt while it listens. `insert` puts a phrase at the caret; `setMarker` shows the
 * dot where the next one lands. `primary`: the content pane's composer (⌘⇧M dictates
 * there when no composer has the keyboard).
 */
export function useComposerDictation({
  draftKey,
  rootRef,
  primary,
  insert,
  setMarker,
}: {
  draftKey: string;
  rootRef: RefObject<HTMLElement | null>;
  primary: boolean;
  insert: (text: string) => void;
  setMarker?: (on: boolean) => void;
}): ComposerDictation {
  const id = useId();
  const clientId = `${draftKey}@${id}`;
  const on = useDictationSettingOn();
  useHoldDictation(on, "inline");
  const availability = useDictationStore((s) => (on ? micAvailability(s.snapshot) : "hidden"));
  const phase = useDictationStore((s) => (s.active?.clientId === clientId ? s.active.phase : null));
  const cb = useRef({ insert, setMarker });
  useLayoutEffect(() => {
    cb.current = { insert, setMarker };
  });

  useEffect(
    () =>
      registerDictationTarget({
        clientId,
        root: () => rootRef.current,
        primary,
        insert: (t) => {
          cb.current.insert(t);
        },
      }),
    [clientId, primary, rootRef],
  );

  const listening = phase === "starting" || phase === "listening";
  useEffect(() => {
    cb.current.setMarker?.(phase === "listening");
  }, [phase]);

  return {
    clientId,
    availability,
    phase,
    listening,
    onEscape: () => stopDictationIn(clientId),
    flush: () => flushDictationIn(clientId),
  };
}
