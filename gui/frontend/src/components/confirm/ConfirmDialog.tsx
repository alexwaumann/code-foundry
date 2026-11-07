import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { answerAlternate, answerConfirm, useConfirmStore } from "@/stores/confirm";

/** How long a guarded request's Confirm stays off, from its content showing and from each press. */
export const CONFIRM_ARM_MS = 600;

/** The buttons a guarded request's wait keeps off: a press on one, once on, is the answer. */
const ANSWER = "[data-confirm-answer]";

/**
 * Whether a request's Confirm can be pressed: at once for the app's own; for a guarded one,
 * once CONFIRM_ARM_MS have passed with no key or pointer pressed or let go and nothing still
 * down, so neither a press begun on something else nor a run of presses can end on it. Once
 * on, a pointer press anywhere but the answers starts the wait again. Keys do not: Tab
 * has to reach Confirm, and the focus starts on Cancel.
 */
function useArmed(guarded: boolean): boolean {
  const [armed, setArmed] = useState(!guarded);
  useEffect(() => {
    if (!guarded) return;
    const held = new Set<string>();
    let on = false;
    let wait: ReturnType<typeof setTimeout> | undefined;
    const restart = () => {
      clearTimeout(wait);
      on = false;
      setArmed(false);
      wait = setTimeout(() => {
        if (held.size > 0) return;
        on = true;
        setArmed(true);
      }, CONFIRM_ARM_MS);
    };
    const released = () => {
      if (!on) restart();
    };
    const keyDown = (e: KeyboardEvent) => {
      held.add(e.code);
      if (!on) restart();
    };
    const keyUp = (e: KeyboardEvent) => {
      // macOS sends no keyup for a key released while Command is down.
      if (e.key === "Meta") held.clear();
      held.delete(e.code);
      released();
    };
    const pointerDown = (e: Event) => {
      held.add("pointer");
      if (!on || !(e.target instanceof Element && e.target.closest(ANSWER))) restart();
    };
    const pointerUp = () => {
      held.delete("pointer");
      released();
    };
    // A press begun outside the window's documents (in a page) shows only in `buttons`.
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) pointerDown(e);
      else if (held.has("pointer")) pointerUp();
    };
    const lost = () => {
      held.clear();
      released();
    };
    const listen: [string, EventListener][] = [
      ["keydown", keyDown as EventListener],
      ["keyup", keyUp as EventListener],
      ["pointerdown", pointerDown],
      ["pointerup", pointerUp],
      ["pointercancel", pointerUp],
      ["pointermove", pointerMove as EventListener],
    ];
    for (const [type, fn] of listen) window.addEventListener(type, fn, true);
    window.addEventListener("blur", lost);
    restart();
    return () => {
      clearTimeout(wait);
      for (const [type, fn] of listen) window.removeEventListener(type, fn, true);
      window.removeEventListener("blur", lost);
    };
  }, [guarded]);
  return armed;
}

type Pending = NonNullable<ReturnType<typeof useConfirmStore.getState>["pending"]>;

/** The dialog's content, one per request: a new request starts over with its focus and its wait. */
function ConfirmBody({ pending }: { pending: Pending | null }) {
  const guarded = pending?.guarded === true;
  const armed = useArmed(guarded);
  return (
    <>
      <div className="flex gap-3">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-cf-error-text" aria-hidden />
        <div className="min-w-0 space-y-2">
          <DialogTitle>{pending?.title}</DialogTitle>
          <DialogDescription className="max-h-96 overflow-y-auto break-words whitespace-pre-wrap">{pending?.message}</DialogDescription>
          {pending?.caller && (
            <p className="text-caption-sm" data-testid="confirm-caller">
              Asked by {pending.caller}
            </p>
          )}
          {pending?.callerDetail && (
            <p className="text-caption-sm break-words" data-testid="confirm-caller-detail">
              {pending.callerDetail}
            </p>
          )}
        </div>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          autoFocus={guarded}
          onClick={() => {
            answerConfirm(false);
          }}
          data-testid="confirm-cancel"
        >
          {pending?.cancelLabel ?? "Cancel"}
        </Button>
        {pending?.alternateLabel && (
          <Button variant="destructive" size="sm" disabled={!armed} onClick={answerAlternate} data-confirm-answer data-testid="confirm-alternate">
            {pending.alternateLabel}
          </Button>
        )}
        <Button
          variant={pending?.alternateLabel ? "default" : "destructive"}
          size="sm"
          autoFocus={pending !== null && !guarded}
          disabled={!armed}
          onClick={() => {
            answerConfirm(true);
          }}
          data-confirm-answer
          data-testid="confirm-ok"
        >
          {pending?.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </>
  );
}

/**
 * Asks before a destructive command runs (Command.requires_confirmation). The confirm
 * button has focus, so Enter confirms and Escape cancels. A three-way prompt
 * (requestChoice) also has its alternate, which is then the destructive one. A guarded
 * request (stores/confirm.ts) has Cancel focused instead, so Enter and Space say no, its
 * Confirm waits (useArmed), and its colours are fixed (.cf-guarded in index.css): what asked
 * may be able to change the theme, and the question has to stay readable.
 */
export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answerConfirm(false);
      }}
    >
      <DialogContent className={cn("max-w-md p-5", pending?.centered && "top-1/2 -translate-y-1/2", pending?.guarded && "cf-guarded")} data-testid="confirm-dialog">
        <ConfirmBody key={pending?.seq} pending={pending} />
      </DialogContent>
    </Dialog>
  );
}
