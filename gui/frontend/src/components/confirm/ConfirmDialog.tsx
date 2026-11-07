import { TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { answerAlternate, answerConfirm, useConfirmStore } from "@/stores/confirm";

/** How long a guarded request's Confirm stays off once its content is on screen. */
export const CONFIRM_ARM_MS = 600;
/** How long after a release it stays off: the release's own click must not find it on. */
const RELEASE_MS = 50;

/**
 * Whether a request's Confirm can be pressed: at once for the app's own; for a guarded one,
 * once CONFIRM_ARM_MS have passed and no key or pointer seen is still down, so a press
 * begun on something else cannot end on it.
 */
function useArmed(guarded: boolean): boolean {
  const [armed, setArmed] = useState(!guarded);
  useEffect(() => {
    if (!guarded) return;
    const held = new Set<string>();
    let waited = false;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(settle);
      if (!waited || held.size > 0) return;
      settle = setTimeout(() => {
        setArmed(true);
      }, RELEASE_MS);
    };
    const wait = setTimeout(() => {
      waited = true;
      arm();
    }, CONFIRM_ARM_MS);
    const keyDown = (e: KeyboardEvent) => {
      held.add(e.code);
      clearTimeout(settle);
    };
    const keyUp = (e: KeyboardEvent) => {
      // macOS sends no keyup for a key released while Command is down.
      if (e.key === "Meta") held.clear();
      held.delete(e.code);
      arm();
    };
    const pointerDown = () => {
      held.add("pointer");
      clearTimeout(settle);
    };
    const pointerUp = () => {
      held.delete("pointer");
      arm();
    };
    // A press begun outside the window's documents (in a page) shows only in `buttons`.
    const pointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) pointerDown();
      else if (held.has("pointer")) pointerUp();
    };
    const lost = () => {
      held.clear();
      arm();
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
    return () => {
      clearTimeout(wait);
      clearTimeout(settle);
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
          <Button variant="destructive" size="sm" disabled={!armed} onClick={answerAlternate} data-testid="confirm-alternate">
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
 * request (stores/confirm.ts) has Cancel focused instead, so Enter and Space say no, and
 * its Confirm waits (useArmed).
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
      <DialogContent className={cn("max-w-md p-5", pending?.centered && "top-1/2 -translate-y-1/2")} data-testid="confirm-dialog">
        <ConfirmBody key={pending?.seq} pending={pending} />
      </DialogContent>
    </Dialog>
  );
}
