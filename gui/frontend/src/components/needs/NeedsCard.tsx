import { useState, type ReactNode } from "react";
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

/** The card's body: the ask by kind, the thread, the context, the actions. */
export function NeedsCardBody({ threadId, anchor, read = true }: { threadId: string; anchor: string; read?: boolean }) {
  const ask = useAskView(threadId, read);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const line = useThreadsStore(useShallow((s) => statusLine(s.byId[threadId])));
  const { pending, request } = ask;
  const question = pending?.question ?? false;
  const more = ask.count > 1 ? (
    <span className="chip muted" data-testid="needs-card-more">
      +{ask.count - 1} more
    </span>
  ) : null;

  // The buttons answer the request whose command is on screen (`request`, the oldest open one's
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
    // An ask with no request (a woken snooze, a plugin's flag): its status, then the thread.
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
                openNeedsPopup(threadId, anchor);
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

/** The card around its anchor (the trigger, `children`): hovering anywhere on it, or focusing it, opens it. */
export function NeedsHoverCard({ threadId, anchor, keyboardOpen = false, enabled = true, side = "right", align = "start", children }: NeedsHoverCardProps) {
  const [hover, setHover] = useState(false);
  const dismissed = useNeedsStore((s) => s.dismissed === anchor);
  const popupOpen = useNeedsStore((s) => s.popup !== null);
  const open = enabled && (hover || keyboardOpen) && !dismissed && !popupOpen;
  return (
    <HoverCard open={open} onOpenChange={setHover} openDelay={200} closeDelay={200}>
      <HoverCardTrigger
        asChild
        onPointerEnter={() => {
          rehoverNeedsAnchor(anchor);
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
        className="w-max max-w-[min(560px,calc(100vw/var(--cf-zoom)-32px))] min-w-[320px] overflow-y-auto overscroll-contain p-0 max-h-[min(560px,var(--radix-hover-card-content-available-height))]"
        data-testid="needs-card"
        data-thread-id={threadId}
        data-anchor={anchor}
      >
        <NeedsCardBody threadId={threadId} anchor={anchor} />
      </HoverCardContent>
    </HoverCard>
  );
}
