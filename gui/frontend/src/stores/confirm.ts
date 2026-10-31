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
  /** The command being confirmed and its args, when a command asks (runCommand). */
  command?: string;
  args?: Readonly<Record<string, string>>;
  /** Who asked to run it, when not the user ("Hello", a plugin's InvokeCommand). */
  caller?: string;
}

/** Asks for a command's confirmation in a dialog of its own (resolves the user's answer). */
export type ConfirmPresenter = (req: ConfirmRequest) => Promise<boolean>;

const presenters = new Map<string, ConfirmPresenter>();

/**
 * Lets a command confirm in its own dialog instead of the generic one (the plugin
 * consent dialog for plugin.enable and plugin.dev). Returns the unregister function.
 */
export function registerConfirmPresenter(command: string, p: ConfirmPresenter): () => void {
  presenters.set(command, p);
  return () => {
    if (presenters.get(command) === p) presenters.delete(command);
  };
}

/** A command's own confirm presenter, if one is registered. */
export function confirmPresenter(command: string): ConfirmPresenter | undefined {
  return presenters.get(command);
}

const secondStage = new Map<string, ConfirmPresenter>();

/**
 * Lets a command answer its second-stage confirmation (one with args, e.g. removing a
 * worktree turned out to delete uncommitted work) in its own dialog: the remove-worktree
 * dialog already named the files that go, so a yes there answers this one too. The
 * request carries the original args. Returns the unregister function.
 */
export function registerSecondStagePresenter(command: string, p: ConfirmPresenter): () => void {
  secondStage.set(command, p);
  return () => {
    if (secondStage.get(command) === p) secondStage.delete(command);
  };
}

/** A command's own second-stage presenter, if one is registered. */
export function secondStagePresenter(command: string): ConfirmPresenter | undefined {
  return secondStage.get(command);
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
