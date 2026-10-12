import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronRight, MessageCircleQuestionMark, ShieldAlert } from "lucide-react";
import type { ThreadPendingView, ThreadRequestView } from "@/api/thread";
import { diffStats } from "@/lib/diff";
import { shellTokens } from "@/lib/highlight";
import {
  answerOf,
  answersOf,
  modeHint,
  NO_PICK,
  permissionChoices,
  pickOption,
  promptKey,
  questionsOf,
  suggestedMode,
  suggestedRules,
  suggestionCount,
  type PermissionDecision,
  type PromptKey,
  type PromptKeyAction,
  type PromptShape,
  type QuestionPick,
} from "@/lib/threadRequest";
import { parseObject, relPath, str, toolHunks, type Json } from "@/lib/toolSummary";
import { useSessionsStore } from "@/stores/sessions";
import { useThreadItem } from "@/stores/thread";
import { respondThread } from "@/stores/threadActions";
import { TokenSpans } from "./Code";
import { useThreadCtx } from "./context";
import { DiffView } from "./DiffView";

/**
 * The docked prompts (rendered threads PR 3, docs/notes/rendered-threads-3-interaction.md):
 * every pending permission request and question, oldest first, stacked at the top of the
 * composer card. Each is answerable by click or keyboard while it has focus; the oldest
 * also takes digits (and a question's Enter) from the composer's editor while the editor
 * is empty (`keysRef`, lib/threadRequest promptKey). An answer goes out through
 * thread.respond and the prompt leaves at once; it comes back if the answer fails.
 */

/** Hands a key from the composer's editor to the oldest prompt; true when it took it. */
export type PromptKeys = (k: PromptKey) => boolean;

interface PromptProps {
  r: ThreadRequestView;
  /** Set on the oldest prompt only: the editor's keys reach it through this. */
  keysRef: RefObject<PromptKeys | null> | null;
  /** Focus back to the composer's editor. */
  refocus: () => void;
}

function plainKey(e: ReactKeyboardEvent): boolean {
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

/** Wires a prompt's key handling: its own keydown (focus inside it, not in a text field) and the editor's (keysRef). */
function usePromptKeys(shape: PromptShape, act: (a: PromptKeyAction) => void, keysRef: RefObject<PromptKeys | null> | null) {
  const latest = useRef({ shape, act });
  useLayoutEffect(() => {
    latest.current = { shape, act };
  });
  useLayoutEffect(() => {
    if (!keysRef) return;
    const handler: PromptKeys = (k) => {
      const a = promptKey(latest.current.shape, k);
      if (!a) return false;
      latest.current.act(a);
      return true;
    };
    keysRef.current = handler;
    return () => {
      if (keysRef.current === handler) keysRef.current = null;
    };
  }, [keysRef]);
  return (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.defaultPrevented || (e.target instanceof HTMLInputElement && e.target.type === "text")) return;
    const a = promptKey(latest.current.shape, { key: e.key, plain: plainKey(e), from: "prompt", editorEmpty: false });
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    latest.current.act(a);
  };
}

/** The question the permission prompt asks. */
function permissionTitle(r: ThreadRequestView, input: Json, cwd: string): string {
  if (r.title) return r.title;
  const path = str(input, "file_path") || str(input, "notebook_path");
  switch (r.toolName) {
    case "Bash":
      return "Allow Claude to run this command?";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path ? `Allow Claude to edit ${relPath(path, cwd)}?` : "Allow Claude to edit this file?";
    case "Write":
      return path ? `Allow Claude to write ${relPath(path, cwd)}?` : "Allow Claude to write this file?";
    case "WebFetch":
      return "Allow Claude to fetch this page?";
    default:
      return `Allow Claude to use ${r.displayName || r.toolName}?`;
  }
}

function Kbd({ k }: { k: string }) {
  return <kbd>{k}</kbd>;
}

/** An Edit/Write waiting for permission: its +/− summary, and the diff on demand. */
function PromptDiff({ r }: { r: ThreadRequestView }) {
  const { cwd } = useThreadCtx();
  const hunks = useMemo(() => toolHunks({ name: r.toolName, inputJson: r.inputJson, resultJson: "" }), [r.toolName, r.inputJson]);
  const [open, setOpen] = useState(false);
  if (hunks.length === 0) return null;
  const { added, removed } = diffStats(hunks);
  const input = parseObject(r.inputJson);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="pdiff" data-testid="thread-permission-diff">
      <button type="button" className="pdiff-t" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <Chevron aria-hidden />
        {open ? "Hide the change" : "Show the change"}
        <span className="n add">+{added}</span>
        {removed > 0 && <span className="n del">−{removed}</span>}
      </button>
      {open && (
        <div className="pdiff-body">
          <DiffView path={str(input, "file_path") || str(input, "notebook_path")} hunks={hunks} cwd={cwd} />
        </div>
      )}
    </div>
  );
}

/** A pending permission prompt: what Claude wants to do and why it asks; Allow / Allow for session / Deny (with an optional reason). */
function PermissionPrompt({ r, keysRef, refocus }: PromptProps) {
  const { sessionId, cwd } = useThreadCtx();
  const permissionMode = useSessionsStore((s) => s.byId[sessionId]?.permissionMode ?? "");
  const input = parseObject(r.inputJson);
  const command = str(input, "command");
  const path = str(input, "file_path") || str(input, "notebook_path") || str(input, "url");
  const rules = suggestedRules(r.suggestionsJson);
  const sessionMode = suggestedMode(r.suggestionsJson);
  const sessionRule = suggestionCount(r.suggestionsJson) > 0;
  const description = str(input, "description") || r.description;
  const why = r.decisionReason || (r.blockedPath ? `Outside the working directories: ${relPath(r.blockedPath, cwd)}` : "");
  const hint = modeHint(permissionMode, r.toolName);
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const choices = permissionChoices(sessionRule);
  const numberOf = (d: PermissionDecision) => String(choices.indexOf(d) + 1);

  const answer = (decision: PermissionDecision, message = "") => {
    refocus();
    void respondThread(sessionId, r.requestId, decision, { message });
  };
  const decide = (decision: PermissionDecision) => {
    if (decision !== "deny") {
      answer(decision);
      return;
    }
    setDenying(true);
    requestAnimationFrame(() => reasonRef.current?.focus());
  };
  const onKeyDown = usePromptKeys(
    { kind: "permission", sessionRule },
    (a) => {
      if (a.kind === "decide") decide(a.decision);
      else if (a.kind === "editor") refocus();
    },
    keysRef,
  );

  return (
    <div className="pend perm" ref={rootRef} tabIndex={-1} data-keys-local="" data-testid="thread-permission" data-request-id={r.requestId} onKeyDown={onKeyDown}>
      <div className="pend-h">
        <ShieldAlert aria-hidden />
        <span>{permissionTitle(r, input, cwd)}</span>
        <span className="chip tool">{r.displayName || r.toolName}</span>
        {r.agentId && <span className="chip">subagent</span>}
        {hint && (
          <span className="why" data-testid="thread-permission-hint">
            {hint}
          </span>
        )}
      </div>
      {command ? (
        <div className="cmdbox selectable">
          <span className="text-muted-foreground">$ </span>
          <TokenSpans tokens={shellTokens(command)} />
        </div>
      ) : path ? (
        <div className="cmdbox selectable">{relPath(path, cwd)}</div>
      ) : (
        r.inputJson && <div className="cmdbox selectable">{JSON.stringify(input, null, 2)}</div>
      )}
      <PromptDiff r={r} />
      {(description || rules.length > 0 || sessionMode || why) && (
        <div className="desc">
          {description}
          {rules.length > 0 && (
            <span style={{ opacity: 0.8 }}>
              {description ? " " : ""}Allow for session adds{" "}
              {rules.map((rule, i) => (
                <span key={rule}>
                  {i > 0 && ", "}
                  <code>{rule}</code>
                </span>
              ))}
              .
            </span>
          )}
          {sessionMode && (
            <span style={{ opacity: 0.8 }}>
              {description || rules.length > 0 ? " " : ""}Allow for session switches the thread to {sessionMode}.
            </span>
          )}
          {why && (
            <span className="reason" data-testid="thread-permission-why">
              {why}
            </span>
          )}
        </div>
      )}
      {denying ? (
        <form
          className="acts deny"
          onSubmit={(e) => {
            e.preventDefault();
            answer("deny", reason);
          }}
        >
          <input
            ref={reasonRef}
            type="text"
            className="reason-in"
            value={reason}
            placeholder="Tell Claude why or what to do instead (optional)"
            aria-label="Reason for denying"
            data-testid="thread-deny-reason"
            onChange={(e) => {
              setReason(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setDenying(false);
                setReason("");
                rootRef.current?.focus();
              }
            }}
          />
          <button type="submit" className="btn primary" data-testid="thread-deny-submit">
            Deny <Kbd k="↵" />
          </button>
          <button
            type="button"
            className="btn outline"
            onClick={() => {
              setDenying(false);
              setReason("");
              rootRef.current?.focus();
            }}
          >
            Cancel <Kbd k="esc" />
          </button>
        </form>
      ) : (
        <div className="acts">
          <button type="button" className="btn primary" data-testid="thread-permission-allow" onClick={() => { decide("allow"); }}>
            <Check aria-hidden />
            Allow <Kbd k={numberOf("allow")} />
          </button>
          {sessionRule && (
            <button type="button" className="btn outline" data-testid="thread-permission-allow-session" onClick={() => { decide("allow-session"); }}>
              Allow for session <Kbd k={numberOf("allow-session")} />
            </button>
          )}
          <button type="button" className="btn outline" data-testid="thread-permission-deny" onClick={() => { decide("deny"); }}>
            Deny <Kbd k={numberOf("deny")} />
          </button>
        </div>
      )}
    </div>
  );
}

/** A pending AskUserQuestion: a pager over its questions, options as radios (checkboxes for a multi-select), Other, Submit or Skip. */
function QuestionPrompt({ r, keysRef, refocus }: PromptProps) {
  const { sessionId } = useThreadCtx();
  const questions = useMemo(() => questionsOf(r.inputJson), [r.inputJson]);
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<QuestionPick[]>(() => questions.map(() => NO_PICK));
  const otherRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const q = questions[page];
  const pick = picks[page] ?? NO_PICK;
  const last = page >= questions.length - 1;
  const answered = q ? answerOf(q, pick) !== "" : false;

  const setPick = (p: QuestionPick) => {
    setPicks((all) => all.map((x, i) => (i === page ? p : x)));
  };
  const choose = (index: number) => {
    if (!q) return;
    const next = pickOption(q, pick, index);
    setPick(next);
    if (index === q.options.length && next.other) requestAnimationFrame(() => otherRef.current?.focus());
  };
  const submit = () => {
    if (!answered) return;
    if (!last) {
      setPage(page + 1);
      rootRef.current?.focus();
      return;
    }
    const answers = answersOf(questions, picks);
    if (!answers) {
      // An earlier page is unanswered: go back to it.
      setPage(Math.max(0, questions.findIndex((x, i) => answerOf(x, picks[i] ?? NO_PICK) === "")));
      return;
    }
    refocus();
    void respondThread(sessionId, r.requestId, "allow", { answers });
  };
  const skip = () => {
    refocus();
    void respondThread(sessionId, r.requestId, "deny");
  };
  const onKeyDown = usePromptKeys(
    { kind: "question", options: q?.options.length ?? 0 },
    (a) => {
      if (a.kind === "pick") choose(a.index);
      else if (a.kind === "submit") submit();
      else if (a.kind === "skip") skip();
    },
    keysRef,
  );
  if (!q) return null;
  const role = q.multiSelect ? "checkbox" : "radio";
  return (
    <div className="pend ask" ref={rootRef} tabIndex={-1} data-keys-local="" data-testid="thread-question" data-request-id={r.requestId} onKeyDown={onKeyDown}>
      <div className="pend-h">
        <MessageCircleQuestionMark aria-hidden />
        <span>{questions.length === 1 ? "Claude has a question" : `Claude has ${String(questions.length)} questions`}</span>
        {r.agentId && <span className="chip">subagent</span>}
        {questions.length > 1 && (
          <span className="pager" aria-label={`Question ${String(page + 1)} of ${String(questions.length)}`}>
            {questions.map((_, i) => (
              <i key={i} className={i === page ? "on" : undefined} />
            ))}
            <span style={{ marginLeft: 4 }}>
              {page + 1} of {questions.length}
            </span>
          </span>
        )}
      </div>
      <div className="q-text selectable">
        {q.header && <span className="q-hdr">{q.header}</span>} {q.question}
        {q.multiSelect && <span className="q-multi"> Pick any.</span>}
      </div>
      <div className={q.multiSelect ? "opts multi" : "opts"} role={q.multiSelect ? "group" : "radiogroup"} aria-label={q.question}>
        {q.options.map((o, i) => {
          const sel = pick.selected.includes(i);
          return (
            <button
              key={o.label}
              type="button"
              role={role}
              aria-checked={sel}
              className={sel ? "opt sel" : "opt"}
              onClick={() => {
                choose(i);
              }}
            >
              <span className="on" />
              <span>
                <b>{o.label}</b>
                {o.description && <small>{o.description}</small>}
              </span>
              <span className="kn">{i + 1}</span>
            </button>
          );
        })}
        <div
          className={pick.other ? "opt sel" : "opt"}
          role={role}
          aria-checked={pick.other}
          aria-label="Other"
          data-testid="thread-question-other"
          onClick={(e) => {
            if (e.target !== otherRef.current) choose(q.options.length);
          }}
        >
          <span className="on" />
          <span style={{ flex: 1 }}>
            <b>Other</b>
            <input
              ref={otherRef}
              type="text"
              className="mt-1.5 h-[26px] w-full rounded-md border bg-transparent px-2 text-xs"
              placeholder="Type your own answer"
              aria-label="Other answer"
              value={pick.otherText}
              onFocus={() => {
                if (!pick.other) setPick({ ...pickOption(q, pick, q.options.length), otherText: pick.otherText });
              }}
              onChange={(e) => {
                setPick({ ...pick, other: true, ...(q.multiSelect ? {} : { selected: [] }), otherText: e.target.value });
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  rootRef.current?.focus();
                }
              }}
            />
          </span>
          <span className="kn">{q.options.length + 1}</span>
        </div>
      </div>
      <div className="acts">
        {page > 0 && (
          <button
            type="button"
            className="btn outline"
            data-testid="thread-question-back"
            aria-label="Previous question"
            onClick={() => {
              setPage(page - 1);
            }}
          >
            <ArrowLeft aria-hidden />
          </button>
        )}
        <button type="button" className="btn primary" data-testid="thread-question-next" disabled={!answered} onClick={submit}>
          {last ? "Submit" : "Next"}
          {last ? <Kbd k="↵" /> : <ArrowRight aria-hidden />}
        </button>
        <button type="button" className="btn outline" data-testid="thread-question-skip" onClick={skip}>
          Skip {questions.length === 1 ? "question" : "questions"} <Kbd k="esc" />
        </button>
      </div>
    </div>
  );
}

/** One pending request, docked. */
function PendingPrompt({ pending, keysRef, refocus }: { pending: ThreadPendingView; keysRef: RefObject<PromptKeys | null> | null; refocus: () => void }) {
  const { sessionId } = useThreadCtx();
  const item = useThreadItem(sessionId, pending.itemId);
  if (!item || (item.kind !== "permission" && item.kind !== "question")) return null;
  return item.kind === "question" ? (
    <QuestionPrompt key={item.id} r={item.request} keysRef={keysRef} refocus={refocus} />
  ) : (
    <PermissionPrompt key={item.id} r={item.request} keysRef={keysRef} refocus={refocus} />
  );
}

/** Every pending request, oldest first; the oldest takes the editor's keys. */
export function PendingPrompts({ pending, keysRef, refocus }: { pending: readonly ThreadPendingView[]; keysRef: RefObject<PromptKeys | null>; refocus: () => void }) {
  return (
    <div className="pend-stack" data-testid="thread-prompts" data-count={pending.length}>
      {pending.map((p, i) => (
        <PendingPrompt key={p.requestId} pending={p} keysRef={i === 0 ? keysRef : null} refocus={refocus} />
      ))}
    </div>
  );
}
