import { Check, Ellipsis, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FETCH_AGE } from "@/components/prs/format";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { useNow } from "@/lib/clock";
import { formatAge } from "@/lib/duration";
import { cn } from "@/lib/utils";
import { openUrl, pullRequestKey, useFreshness, useViewerLogin } from "@/stores/gh";
import { copyPullRequestLink, linkPullRequestToThread, refreshPullRequest, setPullRequestDraft, usePrPanelStore, usePullRequestChange } from "@/stores/prPanel";
import { canClosePullRequest, canReopenPullRequest, closePullRequest, copyPullRequestBranch, reopenPullRequest, usePullRequestClosing } from "@/stores/prClose";
import { startingKey, startPrThread, usePrThreadsStore, type PrThreadKind } from "@/stores/prThreads";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { spaceTabs } from "@/shell/linked";
import { samePullRequest } from "./model";
import { toneText } from "./tones";
import { sameLogin } from "./review";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { COPY_LINK_CHORD, POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";

/**
 * A menu item's body: its title and a one-line hint under it (the Review menu shares it). Text only, like
 * every menu; a spinner at the right while `busy`.
 */
export function Item({ title, hint, busy, children }: { title: string; hint?: ReactNode; busy?: boolean; children?: ReactNode }) {
  return (
    <>
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{title}</span>
        {hint && <span className="text-caption">{hint}</span>}
      </span>
      {busy && <Loader2 className="animate-spin" aria-hidden data-testid="pr-menu-busy" />}
      {children}
    </>
  );
}

function RefreshHint({ fetchedAtMs, lastError, busy }: { fetchedAtMs: number | null; lastError: string; busy: boolean }) {
  const now = useNow(1000);
  const f = useFreshness(fetchedAtMs, lastError, false);
  if (busy) return <span data-testid="pr-menu-refresh-hint">Refreshing…</span>;
  const when = f.fetchedAtMs === null ? "Not fetched yet" : `Updated ${formatAge(f.fetchedAtMs, now, FETCH_AGE)}`;
  return (
    <Tip label={f.lastError} side="left">
      <span data-testid="pr-menu-refresh-hint" className={f.lastError ? "text-cf-warning-text" : undefined}>
        {when}
        {f.lastError && " · last fetch failed"}
      </span>
    </Tip>
  );
}

/** Whether kind's command is running for ref (its menu item shows a spinner). */
function useStarting(prRef: PrRef, kind: PrThreadKind): boolean {
  return usePrThreadsStore((s) => s.starting[startingKey(prRef, kind)] ?? false);
}

/**
 * The threads with a tab in the current space (the shell's layout, not the sidebar), in the
 * panes' order, each once: the rows of Link to thread. One string in the selector, so the
 * menu re-renders only when that list changes.
 */
function useSpaceThreads(): readonly string[] {
  const joined = useLayoutStore((s) => [...new Set(spaceTabs(s, s.currentSpaceId).flatMap((t) => (t.kind === "thread" && t.thread ? [t.thread] : [])))].join("\n"));
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}

/** Whether a thread's linked pull requests include ref (any case of the slug). */
function links(byId: ReturnType<typeof useThreadsStore.getState>["byId"], threadId: string, ref: PrRef): boolean {
  return (byId[threadId]?.linkedPullRequests ?? []).some((l) => samePullRequest(l, ref));
}

function useLinks(threadId: string, ref: PrRef): boolean {
  return useThreadsStore((s) => links(s.byId, threadId, ref));
}

/** Calls `then` once the thread lists ref (now, or when the daemon publishes it). Returns the cancel. */
function whenLinked(threadId: string, ref: PrRef, then: () => void): () => void {
  if (links(useThreadsStore.getState().byId, threadId, ref)) {
    then();
    return () => undefined;
  }
  const off = useThreadsStore.subscribe((s) => {
    if (!links(s.byId, threadId, ref)) return;
    off();
    then();
  });
  return off;
}

/**
 * One thread of Link to thread: its name, and a tick when it links ref already. Picking an
 * unticked one runs thread.pr.link and spins until the thread lists the pull request (the
 * tick is the result); a ticked one is inert: there is no unlink.
 */
function LinkThreadRow({ threadId, prRef, linking, onLink }: { threadId: string; prRef: PrRef; linking: boolean; onLink: () => void }) {
  const name = useThreadsStore((s) => s.byId[threadId]?.name || threadId);
  const linked = useLinks(threadId, prRef);
  return (
    <DropdownMenuItem
      data-testid="pr-menu-link-thread"
      data-thread={threadId}
      data-linked={linked || undefined}
      aria-busy={linking || undefined}
      aria-disabled={linked || linking || undefined}
      onSelect={(e) => {
        e.preventDefault();
        if (!linked && !linking) onLink();
      }}
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {linking ? (
        <Loader2 className="animate-spin" aria-hidden data-testid="pr-menu-busy" />
      ) : (
        linked && (
          <>
            <Check className={toneText.success} aria-hidden data-testid="pr-menu-link-tick" />
            <span className="sr-only">Linked</span>
          </>
        )
      )}
    </DropdownMenuItem>
  );
}

/**
 * This pull request → Link to thread: the app's shared submenu (DropdownMenuSub, as the
 * pane's + menu and the thread info card use) listing the threads open as tabs in the
 * current space, each by name, ticked when it links the pull request already (the readiness
 * cards' "Address in …" menus list exactly those threads, taskRouting.ts). Picking an
 * unticked thread links it (thread.pr.link) and keeps the menu open, its row spinning,
 * until the thread shows the link; then the menu closes (`onDone`). With no thread tabs in
 * the space the row is disabled and opens nothing. Keys and collisions are Radix's.
 */
function LinkToThread({ prRef, onDone }: { prRef: PrRef; onDone: () => void }) {
  const threads = useSpaceThreads();
  const [linking, setLinking] = useState<string | null>(null);
  // The wait for the thread to show a link, stopped if the menu goes first.
  const waiting = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      waiting.current?.();
    },
    [],
  );
  const link = (id: string) => {
    if (linking !== null) return;
    setLinking(id);
    void linkPullRequestToThread(id, prRef).then((ok) => {
      if (!ok) {
        setLinking(null);
        return;
      }
      waiting.current = whenLinked(id, prRef, () => {
        waiting.current = null;
        setLinking(null);
        onDone();
      });
    });
  };
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="pr-menu-link" disabled={threads.length === 0}>
        <Item title="Link to thread" />
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className={cn("w-64", POPUP_FIT)} data-testid="pr-menu-link-threads">
        <DropdownMenuLabel>Threads open in this space</DropdownMenuLabel>
        {threads.map((id) => (
          <LinkThreadRow
            key={id}
            threadId={id}
            prRef={prRef}
            linking={linking === id}
            onLink={() => {
              link(id);
            }}
          />
        ))}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * The header's ⋯ menu: Start a thread (Ask a question, Explain this PR, Fix findings), This
 * pull request (Convert to draft, Close or Reopen pull request, each when allowed, and Link
 * to thread), Open on GitHub, Copy link and Copy branch name, then Refresh with how fresh the
 * copy is. Every action is a registry command or a store action. Ask a question opens the
 * surface's composer (onAsk), or focuses it again when it is open; Explain, Fix findings,
 * Convert to draft, Close (after pr.close's own confirmation), Reopen and a link run at
 * once, keeping the menu open with a spinner until the pull request or the thread shows the
 * result. The ⋯ button spins while a Convert to draft, Close or Reopen whose menu was closed
 * runs. A running item is aria-disabled
 * (it stays focusable; a second select sends nothing) wherever the pull request is shown.
 */
export function PrMenu({ prRef, detail, onAsk }: { prRef: PrRef; detail: PullRequestDetailView; onAsk: () => void }) {
  const viewer = useViewerLogin();
  const busy = usePrPanelStore((s) => s.refreshing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const explaining = useStarting(prRef, "explain");
  const fixing = useStarting(prRef, "fix");
  const change = usePullRequestChange(prRef);
  const drafting = change === "draft";
  const closing = usePullRequestClosing(prRef);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => {
    setOpen(false);
  }, []);
  // Ask hands focus to the composer, so the menu must not take it back to its button.
  const keepFocus = useRef(false);
  const start = (kind: PrThreadKind) => {
    void startPrThread(kind, prRef).then((id) => {
      if (id !== null) setOpen(false);
    });
  };
  const pr = detail.pullRequest;
  const url = pr.url || `https://github.com/${prRef.slug}/pull/${String(prRef.number)}`;
  // GitHub lets the author or anyone with write access convert an open pull request.
  const canDraft = pr.state === "open" && !pr.draft && (detail.viewerCanUpdate || sameLogin(pr.author, viewer));
  const canClose = canClosePullRequest(detail);
  const canReopen = canReopenPullRequest(detail);
  const { ref: boundaryRef, boundary } = usePanelBoundary();
  const trigger = useRef<HTMLButtonElement | null>(null);
  // The last press outside the menu was on the ⋯ button (see onPointerDownOutside).
  const pressedTrigger = useRef(false);
  const ref = useCallback(
    (el: HTMLButtonElement | null) => {
      trigger.current = el;
      boundaryRef(el);
    },
    [boundaryRef],
  );
  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        // Reopened before the last close's focus handling ran: that close is over.
        if (next) {
          keepFocus.current = false;
          pressedTrigger.current = false;
        }
        setOpen(next);
      }}
    >
      <Tip label="Pull request actions">
        <DropdownMenuTrigger asChild>
          <button
            ref={ref}
            type="button"
            aria-label="Pull request actions"
            data-testid="pr-menu-button"
            className="flex size-7 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover"
          >
            {drafting || closing !== null ? <Loader2 className="size-4 animate-spin" aria-hidden data-testid="pr-menu-button-busy" /> : <Ellipsis className="size-4" aria-hidden />}
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        className={cn("w-80", POPUP_FIT)}
        data-testid="pr-menu"
        onKeyDown={stopPlainKeys}
        onPointerDownOutside={(e) => {
          // The ⋯ button toggles the menu itself. While the menu fades out its layer is
          // still mounted, and would take a reopening press as an outside one and shut it.
          pressedTrigger.current = e.target instanceof Node && (trigger.current?.contains(e.target) ?? false);
          if (pressedTrigger.current) e.preventDefault();
        }}
        onCloseAutoFocus={(e) => {
          if (keepFocus.current) {
            keepFocus.current = false;
            e.preventDefault();
          } else if (pressedTrigger.current) {
            // Radix counts that press as an outside interaction and would leave focus
            // wherever it is; it was on the button, so focus goes back there.
            e.preventDefault();
            trigger.current?.focus();
          }
          pressedTrigger.current = false;
        }}
      >
        <DropdownMenuLabel>Start a thread</DropdownMenuLabel>
        <DropdownMenuItem
          data-testid="pr-menu-ask"
          onSelect={() => {
            keepFocus.current = true;
            onAsk();
          }}
        >
          <Item title="Ask a question" />
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="pr-menu-explain"
          aria-busy={explaining || undefined}
          aria-disabled={explaining || undefined}
          onSelect={(e) => {
            // Stay open with a spinner until the thread has started.
            e.preventDefault();
            start("explain");
          }}
        >
          <Item busy={explaining} title="Explain this PR" />
        </DropdownMenuItem>
        <DropdownMenuItem
          data-testid="pr-menu-fix"
          aria-busy={fixing || undefined}
          aria-disabled={fixing || undefined}
          onSelect={(e) => {
            e.preventDefault();
            start("fix");
          }}
        >
          <Item busy={fixing} title="Fix findings" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>This pull request</DropdownMenuLabel>
        {canDraft && (
          <DropdownMenuItem
            data-testid="pr-menu-draft"
            aria-busy={drafting || undefined}
            aria-disabled={change !== null || undefined}
            onSelect={(e) => {
              // Stay open with a spinner until the detail shows the draft, which is the
              // result: no success toast.
              e.preventDefault();
              void setPullRequestDraft(prRef, true, { inView: true }).then((ok) => {
                if (ok) setOpen(false);
              });
            }}
          >
            <Item busy={drafting} title="Convert to draft" hint={drafting ? "Converting to draft…" : undefined} />
          </DropdownMenuItem>
        )}
        {canClose && (
          <DropdownMenuItem
            data-testid="pr-menu-close"
            aria-busy={closing === "close" || undefined}
            aria-disabled={closing !== null || undefined}
            onSelect={(e) => {
              // pr.close asks first (the confirm dialog); then a spinner until the detail
              // shows it closed.
              e.preventDefault();
              if (closing !== null) return;
              void closePullRequest(prRef).then((ok) => {
                if (ok) setOpen(false);
              });
            }}
          >
            <Item busy={closing === "close"} title="Close pull request" hint={closing === "close" ? "Closing…" : undefined} />
          </DropdownMenuItem>
        )}
        {canReopen && (
          <DropdownMenuItem
            data-testid="pr-menu-reopen"
            aria-busy={closing === "reopen" || undefined}
            aria-disabled={closing !== null || undefined}
            onSelect={(e) => {
              e.preventDefault();
              if (closing !== null) return;
              void reopenPullRequest(prRef).then((ok) => {
                if (ok) setOpen(false);
              });
            }}
          >
            <Item busy={closing === "reopen"} title="Reopen pull request" hint={closing === "reopen" ? "Reopening…" : undefined} />
          </DropdownMenuItem>
        )}
        <LinkToThread prRef={prRef} onDone={close} />
        <DropdownMenuSeparator />
        <DropdownMenuItem data-testid="pr-menu-open" onSelect={() => void openUrl(url)}>
          <Item title="Open on GitHub" />
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="pr-menu-copy" onSelect={() => void copyPullRequestLink(prRef, url)}>
          <Item title="Copy link">
            <DropdownMenuShortcut>{formatChord(COPY_LINK_CHORD)}</DropdownMenuShortcut>
          </Item>
        </DropdownMenuItem>
        <DropdownMenuItem data-testid="pr-menu-copy-branch" onSelect={() => void copyPullRequestBranch(pr.headRef)}>
          <Item title="Copy branch name" />
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          data-testid="pr-menu-refresh"
          onSelect={(e) => {
            // Stay open: the item shows the refresh's progress and then its time.
            e.preventDefault();
            void refreshPullRequest(prRef);
          }}
        >
          <Item title="Refresh" hint={<RefreshHint fetchedAtMs={detail.fetchedAtMs} lastError={detail.fetchFailed ? detail.lastError : ""} busy={busy} />} />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
