/**
 * The app's one way to show a toast (docs/notes/toast-levels.md). Every toast has a level
 * and a short title; anything that explains (an error's reason, a path, the daemon's
 * sentence) is the description. design/toastGuard.test.ts keeps sonner's `toast` out of every
 * other file under src (components/ui/sonner.tsx re-exports it for pages).
 *
 *   notify({ level: "error", title: "Could not delete api", description: errorMessage(err) });
 *
 * In progress is a state, not a level: notifyProgress shows a neutral card with a spinner,
 * and a later notify with the same id turns it into its result in place.
 */
import { createElement, type ReactNode } from "react";
import { toast } from "sonner";

export type NoticeLevel = "success" | "info" | "warning" | "error";

/** A toast's id: one given (to update or dismiss it later) or the one notify returns. */
export type NoticeId = string | number;

/** A button on a toast. Pressing it runs onClick, then closes the toast. */
export interface NoticeButton {
  label: string;
  onClick: () => void;
}

interface NoticeContent {
  /** Short, and never variable long text (an error message, a path): that is the description. */
  title: string;
  /** What explains the title: plain text, or a node (a git op's result with its output). */
  description?: ReactNode;
  /** Replaces the toast already up with this id (in place), else names the new one. */
  id?: NoticeId;
}

export interface Notice extends NoticeContent {
  level: NoticeLevel;
  /** The strong button (Open, Undo). */
  action?: NoticeButton;
  /** The quiet button before it (Show in Finder, Edit). */
  cancel?: NoticeButton;
  /** Milliseconds before it closes; the Toaster's default when left out. */
  duration?: number;
  /** Stays until closed, with a close button: a failure the user may need to read. */
  sticky?: boolean;
  /** A close button on a toast that still times out (a bell notification's arrival). */
  closable?: boolean;
  /**
   * A row of buttons in order, the first the strong one, in place of `action` and `cancel`: for
   * more than two (a bell notification's actions, docs/notes/notifications-3-bell.md). Each runs
   * its onClick, then closes the toast.
   */
  buttons?: NoticeButton[];
}

/** The card's button look (components/ui/sonner.tsx's action and cancel), for a `buttons` row. */
const BUTTON = "inline-flex h-6 items-center rounded-sm px-2 text-body-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/50";
const STRONG = `${BUTTON} bg-cf-text text-cf-surface-overlay hover:opacity-90`;
const QUIET = `${BUTTON} bg-cf-text/10 text-cf-text hover:bg-cf-text/15`;

let buttonRows = 0;

/** A `buttons` row: sonner draws an element given as the action as it is, on the card's button row. */
function buttonRow(buttons: NoticeButton[], id: NoticeId): ReactNode {
  return createElement(
    "div",
    { className: "row-start-2 col-start-2 col-end-5 mt-2 flex flex-wrap gap-1.5", "data-notice-buttons": "" },
    buttons.map((b, i) =>
      createElement(
        "button",
        {
          key: `${String(i)}:${b.label}`,
          type: "button",
          className: i === 0 ? STRONG : QUIET,
          "data-button": "",
          onClick: () => {
            b.onClick();
            toast.dismiss(id);
          },
        },
        b.label,
      ),
    ),
  );
}

/** Shows a toast; returns its id. Showing one again with the same id replaces it in place. */
export function notify(n: Notice): NoticeId {
  let id = n.id;
  let action: ReactNode | NoticeButton | undefined = n.action;
  let cancel = n.cancel;
  if (n.buttons && n.buttons.length > 0) {
    // The row's buttons close their own toast, so it needs its id before sonner makes one.
    const rowId = n.id ?? `notice-row-${String(++buttonRows)}`;
    id = rowId;
    action = buttonRow(n.buttons, rowId);
    cancel = undefined;
  }
  // Every option is passed, set or not: sonner merges an update into the toast it replaces,
  // so a result that replaces a progress toast must clear what it does not set.
  return toast[n.level](n.title, {
    id,
    description: n.description,
    action,
    cancel,
    duration: n.sticky ? Infinity : n.duration,
    closeButton: (n.sticky ?? false) || (n.closable ?? false),
  });
}

/** A neutral toast with a spinner, up until a notify with its id replaces it or it is dismissed. */
export function notifyProgress(p: NoticeContent): NoticeId {
  return toast.loading(p.title, { id: p.id, description: p.description });
}

/** Takes a toast down; with no id, every toast. */
export function dismissNotice(id?: NoticeId): void {
  toast.dismiss(id);
}
