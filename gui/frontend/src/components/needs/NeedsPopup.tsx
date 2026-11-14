import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
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
      <Tip label={name} whenTruncated>
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
      className="h-[min(900px,calc(100vh/var(--cf-zoom)-80px))] w-[min(980px,calc(100vw/var(--cf-zoom)-96px))]"
      aria-describedby={undefined}
      data-testid="needs-popup"
      data-thread-id={threadId}
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
      {/* Clipped: in a short window (200% zoom) the thread's dock (the ask and the composer) is
          taller than this box and would cover the header, Go to thread and Close with it. */}
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <InlineThread threadId={threadId} />
      </div>
    </DialogContent>
  );
}
