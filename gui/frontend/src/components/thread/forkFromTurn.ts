import { useState } from "react";
import { forkThreadAt } from "@/stores/threadActions";

/**
 * A finished turn's Fork from here (docs/notes/fork-from-here-button.md): thread.fork with `at`
 * set to the turn's turn end. `held` while the command runs, so a second click does not fork
 * twice (and the gutter keeps showing meanwhile).
 */
export function useForkFromTurn(threadId: string, at: string): { held: boolean; fork: () => void } {
  const [held, setHeld] = useState(false);
  const fork = () => {
    if (held) return;
    setHeld(true);
    // The fork's row comes in and the daemon selects it, as for the menu's Fork; a refusal toasts.
    void forkThreadAt(threadId, at, { inView: true }).finally(() => {
      setHeld(false);
    });
  };
  return { held, fork };
}
