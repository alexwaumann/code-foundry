import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRight, Check, Loader2, MessageCircleQuestionMark, ShieldAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { PlaceIcon } from "@/components/sidebar/SidebarRow";
import { TokenSpans } from "@/components/thread/Code";
import { PromptDiff } from "@/components/thread/PromptDiff";
import { useThreadPlace } from "@/components/thread/useThreadPlace";
import { shellTokens } from "@/lib/highlight";
import { askTarget } from "@/lib/needsAsk";
import { statusLine } from "@/lib/statusLine";
import { statusBadge } from "@/lib/statusRegistry";
import { permissionTitle, questionsOf } from "@/lib/threadRequest";
import { parseObject } from "@/lib/toolSummary";
import { cn } from "@/lib/utils";
import { dismissNeedsCard, goToNeedsThread, openNeedsPopup, rehoverNeedsAnchor, requestOpen, useAskView, useNeedsStore } from "@/stores/needs";
import { respondThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import "@/components/thread/thread.css";

/**
 * The Needs-you hover card (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-17-needs-you.md):
 * the whole ask of a thread that waits on the user. A permission shows the tool, the full command
 * or file (for an edit or a write, its +/− summary and the diff too, open, as the pane's card has
 * them), the thread and the last line Claude wrote, with Allow, Deny and Go to thread, and only
 * once that whole request is known: while it is read the card says so, and when it cannot be read
 * it shows the one-line summary with Open… (the popup) and Go to thread. A question is never
 * answered here: it offers the popup and the thread. Quick actions only; the popup has today's
 * cards (the deny reason, the options).
 *
 * The card is sized by its content up to a maximum and scrolls beyond it; today's command box
 * cap is lifted inside it (thread.css `.cf-needs-card`). The pointer can move from the anchor into
 * it. The same card serves a Needs you row, a row of the top bar's popover and a pane's ask strip.
 */

/** The thread the ask comes from: its place's icon, the project (or "No project"), its name. */
function ThreadOf({ threadId }: { threadId: string }) {
  const { project, noProject, set, inFolder } = useThreadPlace(threadId);
  const name = useThreadsStore((s) => s.byId[threadId]?.name ?? "");
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-body-sm text-cf-text-muted" data-testid="needs-card-thread">
      <PlaceIcon id={threadId} noProject={noProject} set={set !== null} />
      <span className="shrink-0">{noProject ? "No project" : inFolder ? set : project}</span>
      <span aria-hidden>·</span>
      <span className="min-w-0 truncate font-medium text-cf-text">{name || threadId}</span>
    </span>
  );
}

/** The last line Claude wrote before the ask, quoted. */
function Context({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p className="mt-1 text-body-sm text-cf-text-muted italic" data-testid="needs-card-context">
      “{text}”
    </p>
  );
}

function GoToThread({ threadId, anchor }: { threadId: string; anchor: string }) {
  return (
    <button
      type="button"
      className="ml-auto inline-flex items-center gap-1 rounded-sm px-1 text-body-sm text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
      data-testid="needs-card-go"
      onClick={() => {
        dismissNeedsCard(anchor);
        goToNeedsThread(threadId);
      }}
    >
      Go to thread
      <ArrowUpRight className="size-3.5" aria-hidden />
    </button>
  );
}

/**
 * The card's body: the ask by kind, the thread, the context, the actions. `requestId` is a Needs
 * you line's request (docs/notes/needs-you-line-items.md): the card shows that one, not the oldest.
 */
export function NeedsCardBody({ threadId, anchor, read = true, requestId = null }: { threadId: string; anchor: string; read?: boolean; requestId?: string | null }) {
  const ask = useAskView(threadId, read, requestId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const line = useThreadsStore(useShallow((s) => statusLine(s.byId[threadId])));
  const { pending, request } = ask;
  const question = pending?.question ?? false;
  // A line's card is one of the lines on screen: no "+N more" there.
  const more = ask.count > 1 && requestId === null ? (
    <span className="chip muted" data-testid="needs-card-more">
      +{ask.count - 1} more
    </span>
  ) : null;

  // The buttons answer the request whose command is on screen (`request`, the shown request's
  // own), and only while it is still open: a click never lands on another request.
  const answer = (requestId: string, decision: "allow" | "deny") => {
    if (!requestOpen(threadId, requestId)) return;
    dismissNeedsCard(anchor);
    void respondThread(threadId, requestId, decision);
  };

  let head: ReactNode;
  let body: ReactNode;
  if (pending && question) {
    const questions = request ? questionsOf(request.inputJson) : [];
    head = (
      <>
        <MessageCircleQuestionMark aria-hidden />
        <span>{questions.length > 1 ? `Claude has ${String(questions.length)} questions` : "Claude has a question"}</span>
        {more}
      </>
    );
    body =
      questions.length > 0 ? (
        questions.map((q, i) => (
          <div key={i} className="q-text selectable" data-testid="needs-card-question">
            {q.header && <span className="q-hdr">{q.header}</span>} {q.question}
            {q.options.length > 0 && <span className="mt-0.5 block text-body-sm text-cf-text-muted">{q.options.map((o) => o.label).join(" · ")}</span>}
          </div>
        ))
      ) : (
        <div className="q-text selectable" data-testid="needs-card-question">
          {pending.summary}
        </div>
      );
  } else if (pending && request) {
    // The whole request is known: the only state with Allow and Deny.
    const input = parseObject(request.inputJson);
    const target = askTarget(request, cwd);
    head = (
      <>
        <ShieldAlert aria-hidden />
        <span>{permissionTitle(request, input, cwd)}</span>
        <span className="chip tool" data-testid="needs-card-tool">
          {request.displayName || request.toolName}
        </span>
        {more}
      </>
    );
    body = (
      <>
        <div className="cmdbox selectable" data-testid="needs-card-target" data-kind={target?.kind ?? "none"}>
          {target?.kind === "command" ? (
            <>
              <span className="text-cf-text-muted">$ </span>
              <TokenSpans tokens={shellTokens(target.text)} />
            </>
          ) : (
            (target?.text ?? "")
          )}
        </div>
        {/* An edit or a write: the change itself, shown whole (the card scrolls), as the pane's card has it. */}
        <PromptDiff r={request} cwd={cwd} open />
      </>
    );
  } else if (pending) {
    // Not known (yet): the summary at most, never Allow or Deny under a command not shown whole.
    head = (
      <>
        <ShieldAlert aria-hidden />
        <span>Claude asks for permission</span>
        <span className="chip tool" data-testid="needs-card-tool">
          {pending.toolName}
        </span>
        {more}
      </>
    );
    body =
      ask.state === "loading" ? (
        <p className="mt-2 flex items-center gap-1.5 text-body-sm text-cf-text-muted" role="status" data-testid="needs-card-loading">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Reading the request…
        </p>
      ) : (
        <>
          <div className="cmdbox selectable" data-testid="needs-card-target" data-kind="summary">
            {pending.summary}
          </div>
          <p className="text-body-sm text-cf-text-muted" data-testid="needs-card-unavailable">
            {ask.state === "failed" ? "The full request could not be read." : "The full request is not among the thread's latest items."} Open it to see it whole.
          </p>
        </>
      );
  } else {
    // An ask with no request (a woken snooze): its status, then the thread.
    const badge = statusBadge(line);
    const Icon = badge.icon ?? ShieldAlert;
    head = (
      <>
        <Icon aria-hidden />
        <span>{badge.word || "Needs you"}</span>
      </>
    );
    body = line.detail ? <div className="q-text">{line.detail}</div> : null;
  }

  return (
    <div
      className="cf-thread cf-needs-card"
      data-testid="needs-card-body"
      data-thread-id={threadId}
      data-ask={pending ? (question ? "question" : "permission") : "other"}
      data-ask-state={ask.state}
      data-request-id={request?.requestId}
    >
      <div className={cn("pend", question ? "ask" : "perm")}>
        <div className="pend-h">{head}</div>
        {body}
        <div className="mt-2.5 flex min-w-0 flex-col">
          <ThreadOf threadId={threadId} />
          <Context text={ask.context} />
        </div>
        <div className="acts mt-3">
          {request && !question && (
            <>
              <button
                type="button"
                className="btn primary"
                data-testid="needs-card-allow"
                onClick={() => {
                  answer(request.requestId, "allow");
                }}
              >
                <Check aria-hidden />
                Allow
              </button>
              <button
                type="button"
                className="btn outline"
                data-testid="needs-card-deny"
                onClick={() => {
                  answer(request.requestId, "deny");
                }}
              >
                Deny
              </button>
            </>
          )}
          {!(request && !question) && (
            <button
              type="button"
              className="btn primary"
              data-testid="needs-card-open"
              onClick={() => {
                openNeedsPopup(threadId, anchor, requestId);
              }}
            >
              {question ? "Answer…" : "Open…"}
            </button>
          )}
          <GoToThread threadId={threadId} anchor={anchor} />
        </div>
      </div>
    </div>
  );
}

interface NeedsHoverCardProps {
  threadId: string;
  /** A Needs you line's request: the card shows it rather than the oldest (NeedsCardBody). */
  requestId?: string | null;
  /** Which anchor this is ("sidebar:<id>", "popover:<id>", "strip:<pane>"): the popup it opens shuts its card until it is hovered again. */
  anchor: string;
  /** Open without the pointer: the anchor has the keyboard's focus (the sidebar list's cursor). */
  keyboardOpen?: boolean;
  /** False keeps it shut (the row's context menu is open). */
  enabled?: boolean;
  side?: "right" | "top" | "bottom" | "left";
  align?: "start" | "center" | "end";
  children: ReactNode;
}

/**
 * Marks a Needs you line and its own card (docs/notes/needs-you-line-items.md). A card whose anchor
 * holds lines stays shut while the pointer is on one of them or in a line's card: the line's card
 * shows instead. React's pointer events reach the row through the line card's portal, so the row
 * sees the pointer there too.
 */
export const NEEDS_LINE_ZONE = "data-needs-line-zone";

/** A card's open and close delay (Radix's): the pointer crosses the gap into the card within it. */
const LINE_CARD_DELAY = 200;

/** The line zone the pointer is over, below `anchor` (never the anchor itself). */
function lineZoneUnder(target: EventTarget, anchor: Element): boolean {
  const zone = target instanceof Element ? target.closest(`[${NEEDS_LINE_ZONE}]`) : null;
  return zone !== null && zone !== anchor;
}

/** A line card sits inside its row in React's tree: its presses, keys and menus stay in it, never the row's (open, drag, rename, menu). */
const stop = (e: { stopPropagation: () => void }) => {
  e.stopPropagation();
};

/** The card around its anchor (the trigger, `children`): hovering anywhere on it, or focusing it, opens it. */
export function NeedsHoverCard({ threadId, requestId = null, anchor, keyboardOpen = false, enabled = true, side = "right", align = "start", children }: NeedsHoverCardProps) {
  const [hover, setHover] = useState(false);
  const [onLine, setOnLine] = useState(false);
  // Off a line, the row's card waits out the line card's close delay: never two cards at once.
  const offLine = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lineZone = (under: boolean) => {
    // Already leaving: crossing more of the row does not restart the wait.
    if (!under && offLine.current !== null) return;
    if (offLine.current !== null) clearTimeout(offLine.current);
    offLine.current = null;
    if (under) setOnLine(true);
    else if (onLine)
      offLine.current = setTimeout(() => {
        offLine.current = null;
        setOnLine(false);
      }, LINE_CARD_DELAY);
  };
  useEffect(
    () => () => {
      if (offLine.current !== null) clearTimeout(offLine.current);
    },
    [],
  );
  const dismissed = useNeedsStore((s) => s.dismissed === anchor);
  const popupOpen = useNeedsStore((s) => s.popup !== null);
  const open = enabled && (hover || keyboardOpen) && !onLine && !dismissed && !popupOpen;
  const nested = requestId !== null;
  return (
    <HoverCard open={open} onOpenChange={setHover} openDelay={LINE_CARD_DELAY} closeDelay={LINE_CARD_DELAY}>
      <HoverCardTrigger
        asChild
        onPointerEnter={() => {
          rehoverNeedsAnchor(anchor);
        }}
        onPointerOver={(e) => {
          lineZone(lineZoneUnder(e.target, e.currentTarget));
        }}
        onPointerLeave={() => {
          lineZone(false);
        }}
        // A press on the anchor acts (opens the thread or the popup): the card goes until the next hover.
        onPointerDown={() => {
          setHover(false);
        }}
      >
        {children}
      </HoverCardTrigger>
      <HoverCardContent
        side={side}
        align={align}
        // Within the room Radix measures beside the row (screen px, so divided by the page zoom):
        // at 200% the room right of the sidebar can be under 320 layout px.
        className="w-max max-w-[min(560px,calc(var(--radix-hover-card-content-available-width)/var(--cf-zoom)))] min-w-[min(320px,calc(var(--radix-hover-card-content-available-width)/var(--cf-zoom)))] overflow-y-auto overscroll-contain p-0 max-h-[min(560px,calc(var(--radix-hover-card-content-available-height)/var(--cf-zoom)))]"
        data-testid="needs-card"
        data-thread-id={threadId}
        data-anchor={anchor}
        data-request-id={requestId ?? undefined}
        {...(nested ? { [NEEDS_LINE_ZONE]: "", onClick: stop, onPointerDown: stop, onDoubleClick: stop, onContextMenu: stop, onKeyDown: stop } : {})}
      >
        <NeedsCardBody threadId={threadId} anchor={anchor} requestId={requestId} />
      </HoverCardContent>
    </HoverCard>
  );
}
