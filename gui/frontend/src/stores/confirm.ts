/**
 * Confirmation prompts for destructive commands. The daemon refuses such a command with
 * a ConfirmationRequired detail; runCommand asks here and re-invokes with confirmed set.
 * One prompt at a time: a second request while one is open cancels the first.
 */
import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** Centered in the window instead of near the top (questions about the content under it). */
  centered?: boolean;
}

interface ConfirmState {
  pending: (ConfirmRequest & { resolve: (yes: boolean) => void }) | null;
}

export const useConfirmStore = create<ConfirmState>()(() => ({ pending: null }));

/** Opens the confirm dialog; resolves true on confirm, false on cancel or dismissal. */
export function requestConfirm(req: ConfirmRequest): Promise<boolean> {
  useConfirmStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { ...req, resolve } });
  });
}

/** Answers the open prompt. */
export function answerConfirm(yes: boolean): void {
  const p = useConfirmStore.getState().pending;
  if (!p) return;
  useConfirmStore.setState({ pending: null });
  p.resolve(yes);
}
