import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpRight, ChevronLeft, ChevronRight, X } from "lucide-react";
import type { ThreadPendingView } from "@/api/thread";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { reconcileStep, requestLine, stepBy, stepKey } from "@/lib/needsAsk";
import { cn } from "@/lib/utils";
import { PlaceIcon } from "@/components/sidebar/SidebarRow";
import { InlineThread } from "@/components/thread/InlineThread";
import { useThreadPlace } from "@/components/thread/useThreadPlace";
import { closeNeedsPopup, goToNeedsThread, useNeedsStore } from "@/stores/needs";
import { useOpenRequests } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";

/**
 * The Needs-you popup (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md): a
 * limited view of one thread over the window, from a Needs you row's title, a card's Answer, the
 * strip above a short pane's composer or cmd+shift+a. Its recent messages scroll above the ask,
 * drawn with today's cards in the thread's own composer (a permission with its deny-reason field,
 * a question with its options), and "Go to thread" switches to the thread's space and focuses or
 * opens its tab. It is a visible thread view: it holds the thread's Watch (InlineThread, shared
 * with a pane showing the same thread) and lets go of it on close. It closes once the thread no
 * longer waits on an answer (answered here or anywhere else).
 *
 * A thread with several open requests docks one at a time, under a stepper (arrows, a dot per
 * request, "2 of 3"; the left and right keys): it opens on a Needs you line's request, else the
 * oldest, and answering one moves to the next (docs/notes/needs-you-line-items.md).
 */
export function NeedsPopup() {
  const threadId = useNeedsStore((s) => s.popup);
  const exists = useThreadsStore((s) => threadId !== null && threadId in s.byId);
  const open = threadId !== null && exists;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) closeNeedsPopup();
      }}
    >
      {open && <PopupContent key={threadId} threadId={threadId} />}
    </Dialog>
  );
}

/** Whether an Escape belongs to the field it was pressed in (the deny reason, Other, the prompt). */
function fieldKeepsEscape(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

/**
 * Whether the arrows belong to where the keyboard is: a field (the deny reason, Other), or the
 * composer with something typed. An empty composer hands its keys to the ask, as digits do there.
 */
function arrowsInText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  const editor = target.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
  return editor !== null && editor.textContent.trim() !== "";
}

interface Stepper {
  /** The thread's open requests, oldest first. */
  open: readonly ThreadPendingView[];
  /** The request on screen; null when none is open. */
  current: string | null;
  go: (requestId: string) => void;
}

/**
 * The popup's request: the one it opened on (a line's), else the oldest; once it is answered (here
 * or anywhere) the next still open; a request that arrives is listed without moving off the
 * current one (lib/needsAsk reconcileStep).
 */
function useStepper(threadId: string): Stepper {
  const open = useOpenRequests(threadId);
  const ids = useMemo(() => open.map((p) => p.requestId), [open]);
  const asked = useNeedsStore((s) => s.popupRequest);
  const [step, setStep] = useState(() => ({ ids, current: reconcileStep([], ids, asked) }));
  let current = step.current;
  if (step.ids !== ids) {
    current = reconcileStep(step.ids, ids, step.current);
    setStep({ ids, current });
  }
  return {
    open,
    current,
    go: (requestId) => {
      setStep({ ids, current: requestId });
    },
  };
}

/** The stepper over the popup's ask: previous, a dot per open request (the current one wide), next, "2 of 3", the keys. */
function NeedsStepper({ open, current, go }: Stepper) {
  const ids = open.map((p) => p.requestId);
  const at = current === null ? -1 : ids.indexOf(current);
  const step = (dir: -1 | 1) => {
    const id = stepBy(ids, current, dir);
    if (id !== null) go(id);
  };
  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b pr-4 pl-2" data-testid="needs-stepper" data-index={at} data-count={ids.length}>
      <Tip label="Previous request" side="bottom">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous request"
          data-testid="needs-stepper-prev"
          disabled={at <= 0}
          onClick={() => {
            step(-1);
          }}
        >
          <ChevronLeft />
        </Button>
      </Tip>
      <span className="flex items-center gap-1.5" role="group" aria-label="Requests">
        {open.map((p, i) => {
          const line = requestLine(p);
          const on = p.requestId === current;
          return (
            // The dot hides which request it is: its tooltip says (not on the current one, shown below).
            <Tip key={p.requestId} label={on ? null : line.text} side="bottom">
              <button
                type="button"
                aria-label={`${String(i + 1)} of ${String(ids.length)}: ${line.text}`}
                aria-current={on || undefined}
                className={cn("h-[7px] shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-cf-focus", on ? "w-[18px] bg-cf-warning" : "w-[7px] bg-cf-border-strong hover:bg-cf-icon-muted")}
                data-testid="needs-stepper-dot"
                data-request-id={p.requestId}
                data-current={on || undefined}
                onClick={() => {
                  go(p.requestId);
                }}
              />
            </Tip>
          );
        })}
      </span>
      <Tip label="Next request" side="bottom">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next request"
          data-testid="needs-stepper-next"
          disabled={at < 0 || at >= ids.length - 1}
          onClick={() => {
            step(1);
          }}
        >
          <ChevronRight />
        </Button>
      </Tip>
      <span className="text-caption text-cf-text-secondary tabular-nums" data-testid="needs-stepper-count">
        {at + 1} of {ids.length}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-caption text-cf-text-muted">
        <Kbd size="sm">←</Kbd>
        <Kbd size="sm">→</Kbd>
        switch
      </span>
    </div>
  );
}

/** Closes the popup once the thread's open requests go from some to none. */
function useCloseWhenAnswered(threadId: string): void {
  const count = useOpenRequests(threadId).length;
  const had = useRef(false);
  useEffect(() => {
    if (count > 0) had.current = true;
    else if (had.current) closeNeedsPopup();
  }, [count]);
}

/** The popup's crumb: the place and the project, then the thread's name as the dialog's title. */
function Crumb({ threadId }: { threadId: string }) {
  const { project, noProject, set, inFolder } = useThreadPlace(threadId);
  const name = useThreadsStore((s) => s.byId[threadId]?.name ?? "");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="flex shrink-0 items-center gap-1.5 text-body text-cf-text-muted">
        <PlaceIcon id={threadId} noProject={noProject} set={set !== null} />
        {noProject ? "No project" : inFolder ? set : project}
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-cf-icon-muted" aria-hidden />
      <Tip label={name || threadId} whenTruncated>
        <DialogTitle className="min-w-0 truncate text-heading" data-testid="needs-popup-title">
          {name || threadId}
        </DialogTitle>
      </Tip>
    </span>
  );
}

function PopupContent({ threadId }: { threadId: string }) {
  // A state, not a ref object: the portal mounts the content a pass after this component.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  useCloseWhenAnswered(threadId);
  const stepper = useStepper(threadId);
  const { open, current, go } = stepper;
  const several = open.length > 1;
  // Each switch (an arrow, a dot, an answer moving on) puts the keyboard on the new ask, unless the
  // user put it in a field or typed in the composer: digits then answer what is on screen.
  const shown = useRef(current);
  useEffect(() => {
    if (!root || shown.current === current) return;
    shown.current = current;
    const at = document.activeElement;
    if (at !== null && at !== document.body && at !== root && root.contains(at) && arrowsInText(at)) return;
    root.querySelector<HTMLElement>('[data-testid="thread-prompts"] .pend')?.focus({ preventScroll: true });
  }, [root, current]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!several || e.defaultPrevented) return;
    const dir = stepKey(e, arrowsInText(e.target));
    if (dir === 0) return;
    e.preventDefault();
    const id = stepBy(open.map((p) => p.requestId), current, dir);
    if (id !== null && id !== current) go(id);
  };
  // The keyboard starts on the ask once the Watch has drawn it: digits answer, as in a pane.
  // Only while it waits on the dialog itself: once the user put it somewhere (the prompt, the
  // deny reason), a late ask must not take it, or the next digit typed there would answer it.
  useEffect(() => {
    if (!root) return;
    const focusAsk = () => {
      const ask = root.querySelector<HTMLElement>('[data-testid="thread-prompts"] .pend');
      if (!ask) return false;
      ask.focus({ preventScroll: true });
      return true;
    };
    if (focusAsk()) return;
    root.focus({ preventScroll: true });
    const mo = new MutationObserver(() => {
      if (document.activeElement !== root) mo.disconnect();
      else if (focusAsk()) mo.disconnect();
    });
    mo.observe(root, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
    };
  }, [root]);
  return (
    <DialogContent
      ref={setRoot}
      size="sheet"
      className="h-[min(900px,calc(100vh-80px))] w-[min(980px,calc(100vw-96px))]"
      aria-describedby={undefined}
      data-testid="needs-popup"
      data-thread-id={threadId}
      data-request-id={current ?? undefined}
      onKeyDown={onKeyDown}
      // The effect above puts the keyboard on the ask, or on the dialog until the ask is drawn.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
      }}
      // Escape closes the popup, except in a text field, which keeps its own (the deny reason cancels).
      onEscapeKeyDown={(e) => {
        if (fieldKeepsEscape(e.target)) e.preventDefault();
      }}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <Crumb threadId={threadId} />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="needs-popup-go"
          onClick={() => {
            goToNeedsThread(threadId);
          }}
        >
          Go to thread
          <ArrowUpRight aria-hidden />
        </Button>
        <Tip label="Close" side="bottom">
          <DialogClose asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Close" data-testid="needs-popup-close">
              <X />
            </Button>
          </DialogClose>
        </Tip>
      </div>
      {several && <NeedsStepper {...stepper} />}
      {/* Clipped: in a short window (200% zoom) the thread's dock (the ask and the composer) is
          taller than this box and would cover the header, Go to thread and Close with it. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <InlineThread threadId={threadId} ask={several ? (current ?? undefined) : undefined} />
      </div>
    </DialogContent>
  );
}
