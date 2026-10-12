import { useState } from "react";
import { ArrowRight, Check, MessageCircleQuestionMark, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import type { ThreadPendingView, ThreadRequestView } from "@/api/thread";
import { shellTokens } from "@/lib/highlight";
import { questionsOf, suggestedRules } from "@/lib/threadRequest";
import { parseObject, relPath, str, type Json } from "@/lib/toolSummary";
import { useThreadItem } from "@/stores/thread";
import { TokenSpans } from "./Code";
import { useThreadCtx } from "./context";

/**
 * NOT WIRED YET (rendered threads PR 3): answering from the app. The buttons are here so
 * the docked prompt is complete; until PR 3 calls thread.respond (allow / allow-session /
 * deny, a question's answers) a click says how to answer from the CLI.
 */
function notWiredYet(sessionId: string): void {
  toast.info("Answering from the app is coming next", { description: `For now: code-foundry thread respond --id ${sessionId} [allow|allow-session|deny]` });
}

/** The question the permission prompt asks. */
function permissionTitle(r: ThreadRequestView, input: Json, cwd: string): string {
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
      return r.title || `Allow Claude to use ${r.displayName || r.toolName}?`;
  }
}

function Kbd({ k }: { k: string }) {
  return <kbd>{k}</kbd>;
}

/** A pending permission prompt, docked into the top of the composer card (variant A). */
function PermissionPrompt({ r }: { r: ThreadRequestView }) {
  const { sessionId, cwd } = useThreadCtx();
  const input = parseObject(r.inputJson);
  const command = str(input, "command");
  const path = str(input, "file_path") || str(input, "notebook_path") || str(input, "url");
  const rules = suggestedRules(r.suggestionsJson);
  const description = str(input, "description") || r.description;
  const why = r.decisionReason || (r.blockedPath ? `Outside the working directories: ${r.blockedPath}` : "");
  return (
    <div className="pend perm" data-testid="thread-permission" data-request-id={r.requestId}>
      <div className="pend-h">
        <ShieldAlert aria-hidden />
        <span>{permissionTitle(r, input, cwd)}</span>
        <span className="chip tool">{r.displayName || r.toolName}</span>
        {why && <span className="why">{why}</span>}
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
      {(description || rules.length > 0) && (
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
        </div>
      )}
      <div className="acts">
        <button type="button" className="btn primary" data-testid="thread-permission-allow" onClick={() => {
            notWiredYet(sessionId);
          }}>
          <Check aria-hidden />
          Allow <Kbd k="1" />
        </button>
        {rules.length > 0 && (
          <button type="button" className="btn outline" data-testid="thread-permission-allow-session" onClick={() => {
            notWiredYet(sessionId);
          }}>
            Allow for session <Kbd k="2" />
          </button>
        )}
        <button type="button" className="btn outline" data-testid="thread-permission-deny" onClick={() => {
            notWiredYet(sessionId);
          }}>
          Deny <Kbd k={rules.length > 0 ? "3" : "2"} />
        </button>
      </div>
    </div>
  );
}

/** A pending AskUserQuestion, docked into the composer card: a pager, the options as radio rows, Other. */
function QuestionPrompt({ r }: { r: ThreadRequestView }) {
  const { sessionId } = useThreadCtx();
  const questions = questionsOf(r.inputJson);
  const [page, setPage] = useState(0);
  const [picked, setPicked] = useState<Record<number, number>>({});
  const q = questions[page];
  if (!q) return null;
  const last = page === questions.length - 1;
  return (
    <div className="pend ask" data-testid="thread-question" data-request-id={r.requestId}>
      <div className="pend-h">
        <MessageCircleQuestionMark aria-hidden />
        <span>{questions.length === 1 ? "Claude has a question" : `Claude has ${String(questions.length)} questions`}</span>
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
      </div>
      <div className="opts" role="radiogroup" aria-label={q.question}>
        {q.options.map((o, i) => {
          const sel = (picked[page] ?? 0) === i;
          return (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={sel}
              className={sel ? "opt sel" : "opt"}
              onClick={() => {
                setPicked((p) => ({ ...p, [page]: i }));
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
        <div className="opt">
          <span className="on" />
          <span style={{ flex: 1 }}>
            <b>Other</b>
            <input className="mt-1.5 h-[26px] w-full rounded-md border bg-transparent px-2 text-xs" placeholder="Type your own answer" aria-label="Other answer" />
          </span>
          <span className="kn">{q.options.length + 1}</span>
        </div>
      </div>
      <div className="acts">
        <button
          type="button"
          className="btn primary"
          data-testid="thread-question-next"
          onClick={() => {
            if (last) notWiredYet(sessionId);
            else setPage(page + 1);
          }}
        >
          {last ? "Submit" : "Next"}
          {!last && <ArrowRight aria-hidden />}
        </button>
        <button type="button" className="btn outline" onClick={() => {
            notWiredYet(sessionId);
          }}>
          Skip questions
        </button>
      </div>
    </div>
  );
}

/** The oldest pending request, docked into the composer card. */
export function PendingPrompt({ pending }: { pending: ThreadPendingView }) {
  const { sessionId } = useThreadCtx();
  const item = useThreadItem(sessionId, pending.itemId);
  if (!item || (item.kind !== "permission" && item.kind !== "question")) return null;
  return item.kind === "question" ? <QuestionPrompt key={item.id} r={item.request} /> : <PermissionPrompt r={item.request} />;
}
