/**
 * Confirmation prompts for destructive commands. The daemon refuses such a command with
 * a ConfirmationRequired detail; runCommand asks here and re-invokes with confirmed set.
 * One prompt at a time: a second request while one is open cancels the first. A guarded
 * request (one the user did not make: a page's) never does: it waits its turn, behind this
 * dialog and the app's own dialogs (registerOwnDialog).
 */
import { create } from "zustand";

export interface ConfirmRequest {
  title: string;
  message: string;
  confirmLabel: string;
  /** The way out, when "Cancel" does not say what it keeps. */
  cancelLabel?: string;
  /**
   * A third answer between the two (requestChoice), drawn destructive; the confirm button
   * then is the plain default, since Enter on it is the safe answer.
   */
  alternateLabel?: string;
  /** Centered in the window instead of near the top (questions about the content under it). */
  centered?: boolean;
  /** The command being confirmed and its args, when a command asks (runCommand). */
  command?: string;
  args?: Readonly<Record<string, string>>;
  /** Who asked to run it, when not the user ("Hello", a plugin's InvokeCommand). */
  caller?: string;
  /** Names under `caller` that its asker can choose, quoted, so they do not read as the app's words. */
  callerDetail?: string;
  /**
   * Asked by something that is not the user, which can time the question to land under a
   * press meant for something else: it queues, Cancel has the focus, and Confirm stays off
   * for a moment each time the dialog's content changes (ConfirmDialog).
   */
  guarded?: boolean;
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
  pending: (ConfirmRequest & { resolve: (yes: boolean) => void; alternate?: () => void; seq?: number; asked?: ConfirmRequest }) | null;
}

export const useConfirmStore = create<ConfirmState>()(() => ({ pending: null }));

/** Each opened prompt's number: the dialog starts over on a new one. */
let seq = 0;
/** Guarded requests waiting their turn, oldest first. */
const waiting: { req: ConfirmRequest; resolve: (yes: boolean) => void }[] = [];
/** The app's dialogs that are not this one, each answering whether it is open. */
const ownDialogs = new Set<() => boolean>();

/** Opens the oldest guarded request, if nothing else is open. */
function showWaiting(): void {
  if (useConfirmStore.getState().pending !== null || [...ownDialogs].some((open) => open())) return;
  const next = waiting.shift();
  if (next) useConfirmStore.setState({ pending: { ...next.req, resolve: next.resolve, seq: ++seq, asked: next.req } });
}

useConfirmStore.subscribe(showWaiting);

/**
 * A dialog of the app's own that asks in its own store (Remove Worktree, plugin consent): a
 * guarded request waits for it too. Returns the unregister function.
 */
export function registerOwnDialog<S>(store: { getState: () => S; subscribe: (fn: () => void) => () => void }, open: (s: S) => boolean): () => void {
  const isOpen = () => open(store.getState());
  ownDialogs.add(isOpen);
  const stop = store.subscribe(showWaiting);
  return () => {
    stop();
    ownDialogs.delete(isOpen);
  };
}

/** Opens the confirm dialog; resolves true on confirm, false on cancel or dismissal. */
export function requestConfirm(req: ConfirmRequest): Promise<boolean> {
  if (req.guarded) {
    return new Promise((resolve) => {
      waiting.push({ req, resolve });
      showWaiting();
    });
  }
  useConfirmStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({ pending: { ...req, resolve, seq: ++seq } });
  });
}

/** Takes back a guarded request, open or waiting, as a no; anything else's dialog stays. */
export function withdrawConfirm(req: ConfirmRequest): void {
  const i = waiting.findIndex((w) => w.req === req);
  if (i >= 0) {
    waiting.splice(i, 1)[0]?.resolve(false);
    return;
  }
  if (useConfirmStore.getState().pending?.asked === req) answerConfirm(false);
}

/** How a three-way prompt was answered: its confirm button, its alternate one, or dismissed. */
export type ConfirmChoice = "confirm" | "alternate" | "cancel";

/** Opens the confirm dialog with `alternateLabel`'s third button. */
export function requestChoice(req: ConfirmRequest & { alternateLabel: string }): Promise<ConfirmChoice> {
  useConfirmStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useConfirmStore.setState({
      pending: {
        ...req,
        seq: ++seq,
        resolve: (yes) => {
          resolve(yes ? "confirm" : "cancel");
        },
        alternate: () => {
          resolve("alternate");
        },
      },
    });
  });
}

/** Answers the open prompt with its alternate button. */
export function answerAlternate(): void {
  const p = useConfirmStore.getState().pending;
  if (!p?.alternate) return;
  useConfirmStore.setState({ pending: null });
  p.alternate();
}

/** Answers the open prompt. */
export function answerConfirm(yes: boolean): void {
  const p = useConfirmStore.getState().pending;
  if (!p) return;
  useConfirmStore.setState({ pending: null });
  p.resolve(yes);
}
