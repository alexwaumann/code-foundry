import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  FilePen,
  FilePlus,
  FileText,
  FoldVertical,
  Globe,
  Lightbulb,
  ListTodo,
  LoaderCircle,
  MessageCircleQuestionMark,
  Plug,
  Search,
  ShieldAlert,
  SquareChevronRight,
  SquareTerminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import type { AgentRunView } from "@/api/agents";
import type { ThreadItemView, ToolCallView } from "@/api/thread";
import { agentElapsedMs, fmtElapsed, parseAgentNote } from "@/lib/agents";
import { copyText } from "@/lib/clipboard";
import { useNow } from "@/lib/clock";
import { canonicalModelName } from "@/lib/models";
import { formatAgo } from "@/lib/session";
import { questionsOf } from "@/lib/threadRequest";
import { groupLabel, turnCostLabel, type TimelineRow, type WorkNode } from "@/lib/threadTimeline";
import { formatDuration, parseObject, splitPath, str, toolSummary, type Tense } from "@/lib/toolSummary";
import { useAgentRunOfCall, useAgentRunOfNote } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";
import { useModelChoices } from "@/stores/settings";
import { getThreadItems, setRowExpanded, setTurnFolded, useRowExpanded, useThreadItem, useThreadStore } from "@/stores/thread";
import { ThreadMarkdown } from "./Code";
import { CodeRunContext } from "./codeContext";
import { useThreadCtx } from "./context";
import { AgentReport, ToolDetail } from "./ToolDetail";
import { UserBubble } from "./UserBubble";

const TOOL_ICONS: Readonly<Record<string, LucideIcon>> = {
  Bash: SquareTerminal,
  Read: FileText,
  Edit: FilePen,
  MultiEdit: FilePen,
  NotebookEdit: FilePen,
  Write: FilePlus,
  Grep: Search,
  Glob: Search,
  LS: Search,
  Agent: Bot,
  Task: Bot,
  WebFetch: Globe,
  WebSearch: Search,
  TodoWrite: ListTodo,
};

function toolIcon(name: string): LucideIcon {
  return TOOL_ICONS[name] ?? (name.startsWith("mcp__") ? Plug : Wrench);
}

/**
 * One work-log row (24px): a muted icon, a label, meta on the right, and a chevron when it
 * expands. A button when it expands, else a plain row.
 */
function Row({
  icon: Icon,
  label,
  meta,
  expanded,
  onToggle,
  testId,
  data,
}: {
  icon: LucideIcon;
  label: ReactNode;
  meta?: ReactNode;
  /** undefined: the row does not expand. */
  expanded?: boolean;
  onToggle?: () => void;
  testId: string;
  data?: Record<string, string | undefined>;
}) {
  const body = (
    <>
      <span className="ico">
        <Icon aria-hidden />
      </span>
      <span className="lbl">{label}</span>
      {meta && <span className="meta">{meta}</span>}
      {expanded === undefined ? <span className="nochev" /> : <ChevronRight className="chev" aria-hidden />}
    </>
  );
  if (expanded === undefined) {
    return (
      <div className="row" data-testid={testId} {...data}>
        {body}
      </div>
    );
  }
  return (
    <button type="button" className="row" aria-expanded={expanded} data-testid={testId} onClick={onToggle} {...data}>
      {body}
    </button>
  );
}

/** Whether a row is open, with its toggle (the user's choice per thread, else `fallback`). */
function useToggle(rowKey: string, fallback: boolean): [boolean, () => void] {
  const { sessionId } = useThreadCtx();
  const open = useRowExpanded(sessionId, rowKey, fallback);
  return [
    open,
    () => {
      setRowExpanded(sessionId, rowKey, !open);
    },
  ];
}

function durationOf(it: { createdAtMs: number | null; updatedAtMs: number | null }): number | undefined {
  return it.createdAtMs !== null && it.updatedAtMs !== null ? it.updatedAtMs - it.createdAtMs : undefined;
}

/** A tool call's label: verb, then the target (bold, or mono for commands and patterns), then muted detail. */
function ToolLabel({ t, tense, cwd }: { t: ToolCallView; tense: Tense; cwd: string }) {
  const s = toolSummary(t, { tense, cwd });
  return (
    <>
      {s.verb}{" "}
      {s.target &&
        (s.targetStyle === "mono" ? <span className="mono cmd">{s.target}</span> : s.targetStyle === "bold" ? <b>{s.target}</b> : <span>{s.target}</span>)}
      {s.detail && (
        <>
          {" "}
          <span className={s.detailMono ? "mono text-muted-foreground" : "text-muted-foreground"}>{s.detail}</span>
        </>
      )}
    </>
  );
}

/** File edits: while one waits for permission its diff shows, so the user sees what they allow. */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** A run's elapsed time, live (1 s clock) while it runs. */
function AgentElapsed({ run }: { run: AgentRunView }) {
  const now = useNow(1000);
  const ms = agentElapsedMs(run, now);
  return ms === null ? null : <span data-testid="thread-agent-elapsed">{fmtElapsed(ms)}</span>;
}

/**
 * An Agent call's meta from its run: a "background" chip; while running, the activity
 * after a "·" and the live elapsed time with the spinner (also while the daemon keeps a
 * background call's item running); a failed run's "failed" chip; else the call's own meta
 * ("4 tools · 41s"), or the run's duration when the call has none.
 */
function AgentMeta({ run, itemRunning, fallback }: { run: AgentRunView; itemRunning: boolean; fallback: string }) {
  const running = run.status === "running";
  const ended = agentElapsedMs(run, 0);
  return (
    <>
      {run.background && (
        <span className="chip bg" data-testid="thread-agent-bg">
          background
        </span>
      )}
      {running && run.activity && (
        <span className="act" data-testid="thread-agent-activity">
          {run.activity}
        </span>
      )}
      {run.status === "failed" && (
        <span className="chip fail" data-testid="thread-agent-failed">
          failed
        </span>
      )}
      {running ? <AgentElapsed run={run} /> : fallback ? <span>{fallback}</span> : ended !== null && <span>{fmtElapsed(ended)}</span>}
      {(running || itemRunning) && <LoaderCircle className="size-3.5 animate-spin text-sky-500" aria-label="Running" />}
    </>
  );
}

/**
 * A tool call: its row, and when open its detail (a subagent: its nested rows and report).
 * Open by default: a running subagent, and a file edit waiting for permission.
 */
const ToolRow = memo(function ToolRow({ node }: { node: Extract<WorkNode, { type: "tool" }> }) {
  const { sessionId, cwd } = useThreadCtx();
  const item = useThreadItem(sessionId, node.id);
  const perm = useThreadItem(sessionId, node.permissionId);
  const t = item?.kind === "tool" ? item : null;
  const agent = node.name === "Agent" || node.name === "Task";
  // The run the daemon follows for this Agent call (docs/notes/agents-1-daemon.md); a
  // background call's item stays running until the run ends.
  const run = useAgentRunOfCall(sessionId, agent ? node.id : "");
  const request = perm?.kind === "permission" ? perm.request : null;
  const waiting = request?.state === "pending";
  // A running foreground subagent opens to show its work; a background one stays a line
  // (its progress is the activity on the row, the strip and the Agents tab).
  const [open, toggle] = useToggle(node.key, (agent && t?.status === "running" && !run?.background) || (waiting && EDIT_TOOLS.has(node.name)));
  if (!t) return null;
  const tense: Tense = waiting ? "pending" : t.status === "running" ? "running" : "done";
  const s = toolSummary(t, { tense, durationMs: durationOf(t), cwd });
  const denied = request?.state === "denied";
  const meta = waiting ? (
    <span className="t-amber" data-testid="thread-waiting">
      waiting for you
    </span>
  ) : run ? (
    <AgentMeta run={run} itemRunning={t.status === "running"} fallback={s.meta} />
  ) : (
    <>
      {denied && <span className="chip fail">denied</span>}
      {s.chip && !denied && <span className={`chip ${s.chip.tone}`}>{s.chip.text}</span>}
      {(s.added > 0 || s.removed > 0) && (
        <span>
          {s.added > 0 && <span className="add">+{s.added}</span>}
          {s.removed > 0 && <span className="del">{s.added > 0 ? " " : ""}−{s.removed}</span>}
        </span>
      )}
      {s.meta && <span>{s.meta}</span>}
      {t.status === "running" && <LoaderCircle className="size-3.5 animate-spin text-sky-500" aria-label="Running" />}
    </>
  );
  return (
    <div data-tool={t.name} data-status={t.status}>
      <Row
        icon={toolIcon(t.name)}
        label={<ToolLabel t={t} tense={tense} cwd={cwd} />}
        meta={meta}
        expanded={waiting && !EDIT_TOOLS.has(t.name) ? undefined : open}
        onToggle={toggle}
        testId="thread-tool"
        data={{ "data-waiting": waiting ? "true" : undefined }}
      />
      {open &&
        (!waiting || EDIT_TOOLS.has(t.name)) &&
        (agent ? (
          <div className="children">
            {node.children.map((c) => (
              <WorkNodeView key={c.key} node={c} nested />
            ))}
            {t.status !== "running" && <AgentReport t={t} />}
          </div>
        ) : (
          <div className="detail">
            {request && request.state !== "allowed" && request.message && <p className="mb-1 text-xs text-muted-foreground">{request.message}</p>}
            <ToolDetail t={t} cwd={cwd} />
          </div>
        ))}
    </div>
  );
});

/** Base names of a group's files and patterns, for its meta ("poller.go, poller_test.go, gh/client.go"). */
function useGroupTargets(ids: readonly string[]): string[] {
  const { sessionId } = useThreadCtx();
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[sessionId];
      return ids.flatMap((id) => {
        const it = log?.byId[id];
        if (it?.kind !== "tool" || it.name !== "Read") return [];
        const { base } = splitPath(str(parseObject(it.inputJson), "file_path"));
        return base ? [base] : [];
      });
    }),
  );
}

/** Consecutive reads and searches as one row ("Read 3 files, searched code 2 times"); open: their rows. */
const GroupRow = memo(function GroupRow({ node }: { node: Extract<WorkNode, { type: "group" }> }) {
  const [open, toggle] = useToggle(node.key, false);
  const targets = useGroupTargets(node.ids);
  return (
    <div>
      <Row
        icon={node.names[0] === "Read" ? FileText : Search}
        label={groupLabel(node.names)}
        meta={!open && targets.length > 0 ? <span className="max-w-72 truncate">{targets.join(", ")}</span> : undefined}
        expanded={open}
        onToggle={toggle}
        testId="thread-group"
      />
      {open && (
        <div className="members">
          {node.ids.map((id, i) => (
            <ToolRow key={id} node={{ type: "tool", key: id, id, name: node.names[i] ?? "", permissionId: "", children: [] }} />
          ))}
        </div>
      )}
    </div>
  );
});

/** Thinking (one or more consecutive items): "Thought for 9s"; open, its text when Claude streamed any. */
const ThinkingRow = memo(function ThinkingRow({ node }: { node: Extract<WorkNode, { type: "thinking" }> }) {
  const { sessionId } = useThreadCtx();
  const [open, toggle] = useToggle(node.key, false);
  const info = useThreadStore(
    useShallow((s) => {
      const log = s.logs[sessionId];
      const its = node.ids.flatMap((id) => (log?.byId[id] ? [log.byId[id]] : []));
      const text = its.map((it) => (it.kind === "thinking" ? it.text : "")).filter(Boolean).join("\n\n");
      const start = its[0]?.createdAtMs ?? null;
      const end = its[its.length - 1]?.updatedAtMs ?? null;
      return { text, streaming: its.some((it) => it.streaming), ms: start !== null && end !== null ? end - start : 0 };
    }),
  );
  const took = formatDuration(info.ms);
  const label = info.streaming ? "Thinking…" : took && info.ms >= 1000 ? `Thought for ${took.replace(/\.\ds$/, "s")}` : "Thought";
  return (
    <div>
      <Row icon={Lightbulb} label={label} expanded={info.text ? open : undefined} onToggle={toggle} testId="thread-thinking" />
      {open && info.text && <div className="detail text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground italic selectable">{info.text}</div>}
    </div>
  );
});

/** Claude's text: markdown, with a caret while it streams; the turn's final answer gets more air. */
const TextRow = memo(function TextRow({ id, final, nested }: { id: string; final: boolean; nested?: boolean }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  const text = it?.kind === "text" ? it.text : "";
  const streaming = it?.kind === "text" && it.streaming;
  // Claude's reply: its shell blocks offer Run in terminal (CodeActions).
  const run = useMemo(() => ({ sessionId, text, streaming }), [sessionId, text, streaming]);
  if (it?.kind !== "text") return null;
  const md = (
    <CodeRunContext.Provider value={run}>
      <ThreadMarkdown className={it.streaming ? "cf-streaming" : undefined}>{it.text}</ThreadMarkdown>
    </CodeRunContext.Provider>
  );
  if (nested) {
    return (
      <div className="subresult selectable" data-testid="thread-text">
        {md}
      </div>
    );
  }
  return (
    <div className={final ? "a-md final selectable" : "a-md selectable"} data-testid="thread-text" data-final={final || undefined} data-streaming={it.streaming || undefined}>
      {md}
    </div>
  );
});

/** An AskUserQuestion: "Asked [Header] answer" once answered, amber "waiting for you" while it asks. */
const QuestionRow = memo(function QuestionRow({ id }: { id: string }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  const [open, toggle] = useToggle(id, false);
  if (it?.kind !== "question") return null;
  const r = it.request;
  const questions = questionsOf(r.inputJson);
  const first = questions[0];
  if (r.state === "pending") {
    return (
      <Row
        icon={MessageCircleQuestionMark}
        label={
          <>
            Asking <b>{questions.length === 1 ? "a question" : `${String(questions.length)} questions`}</b>
          </>
        }
        meta={
          <span className="t-amber" data-testid="thread-waiting">
            waiting for you
          </span>
        }
        testId="thread-question-row"
        data={{ "data-waiting": "true" }}
      />
    );
  }
  const answered = r.state === "allowed";
  const answer = first ? (r.answers[first.question] ?? "") : "";
  return (
    <div>
      <Row
        icon={MessageCircleQuestionMark}
        label={
          answered ? (
            <>
              Asked {first?.header && <span className="q-hdr">{first.header}</span>} <b>{answer}</b>
              {questions.length > 1 && <span className="text-muted-foreground"> +{questions.length - 1}</span>}
            </>
          ) : (
            <>Question {r.state === "denied" ? "skipped" : "withdrawn"}</>
          )
        }
        meta={answered ? "answered" : undefined}
        expanded={questions.length > 0 ? open : undefined}
        onToggle={toggle}
        testId="thread-question-row"
      />
      {open && (
        <dl className="detail grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px] selectable">
          {questions.map((q) => (
            <div key={q.question} className="contents">
              <dt className="text-muted-foreground">{q.question}</dt>
              <dd>{r.answers[q.question] ?? "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
});

/** A permission request without a tool row (a call denied before it ran). */
const PermissionRow = memo(function PermissionRow({ id }: { id: string }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  if (it?.kind !== "permission") return null;
  const r = it.request;
  const waiting = r.state === "pending";
  return (
    <Row
      icon={ShieldAlert}
      label={
        <>
          {waiting ? "Asks to use" : r.decision === "auto_denied" ? "Not allowed:" : "Permission for"} <b>{r.displayName || r.toolName}</b>
          {r.description && <span className="text-muted-foreground"> {r.description}</span>}
        </>
      }
      meta={waiting ? <span className="t-amber">waiting for you</span> : <span className={r.state === "allowed" ? "chip ok" : "chip fail"}>{r.state}</span>}
      testId="thread-permission-row"
    />
  );
});

/** An error, a compaction, or a local command's output. */
const NoteRow = memo(function NoteRow({ id }: { id: string }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  const [open, toggle] = useToggle(id, false);
  if (!it) return null;
  if (it.kind === "error") {
    return (
      <div className="my-1.5 flex items-start gap-2 rounded-md border border-red-500/30 bg-red-500/5 px-2.5 py-1.5 text-[13px] selectable" data-testid="thread-error">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 t-red" aria-hidden />
        <span className="t-red whitespace-pre-wrap">{it.text}</span>
      </div>
    );
  }
  if (it.kind === "compaction") {
    const k = (n: number) => (n >= 1000 ? `${String(Math.round(n / 1000))}k` : String(n));
    return (
      <div>
        <Row
          icon={FoldVertical}
          label={`Compacted the conversation${it.trigger === "auto" ? " (automatically)" : ""}`}
          meta={it.preTokens > 0 ? `${k(it.preTokens)} → ${k(it.postTokens)} tokens` : undefined}
          expanded={it.summary ? open : undefined}
          onToggle={toggle}
          testId="thread-compaction"
        />
        {open && it.summary && (
          <div className="detail text-[12px] text-muted-foreground">
            <ThreadMarkdown>{it.summary}</ThreadMarkdown>
          </div>
        )}
      </div>
    );
  }
  if (it.kind === "commandOutput") {
    const text = it.text.replace(/<\/?local-command-std(out|err)>/g, "").trim();
    return <Row icon={SquareChevronRight} label={<span className="selectable">{text}</span>} testId="thread-command-output" />;
  }
  return null;
});

/**
 * A system note (the daemon's, not Claude's): one quiet centered line between hairlines,
 * the sketch's divider (docs/sketches/rendered-thread). A fork's "Forked from …" marks
 * where the history it copied from its parent ends.
 */
const SystemNoteRow = memo(function SystemNoteRow({ id }: { id: string }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  const run = useAgentRunOfNote(sessionId, id);
  if (it?.kind !== "note") return null;
  const note = parseAgentNote(it.text, run?.description ?? "");
  if (note) return <AgentNoteRow note={note} atMs={it.createdAtMs} />;
  return (
    <div className="sysnote" role="separator" aria-label={it.text} data-testid="thread-note">
      <span className="selectable">{it.text}</span>
    </div>
  );
});

/** "just now", "5 min ago": the note's age on the shared 30 s clock. */
function NoteAge({ atMs }: { atMs: number }) {
  const now = useNow(30_000);
  return <>{formatAgo(atMs, now)}</>;
}

/**
 * The daemon's note when a background subagent ends (docs/notes/agents-1-daemon.md):
 * one quiet line, a check (emerald) or a cross (red), "Agent finished · name", the report's
 * first line ellipsised, and its age on the right.
 */
function AgentNoteRow({ note, atMs }: { note: ReturnType<typeof parseAgentNote> & object; atMs: number | null }) {
  const Icon = note.failed ? CircleX : CircleCheck;
  return (
    <div className="agentnote" role="note" data-testid="thread-agent-note" data-failed={note.failed || undefined}>
      <Icon className={note.failed ? "t-red" : "t-emerald"} aria-label={note.failed ? "Failed" : "Finished"} />
      <span className="nm">{note.failed ? "Agent failed" : "Agent finished"}</span>
      <span className="ghost" aria-hidden>
        ·
      </span>
      <span className="nm" data-testid="thread-agent-note-name">
        {note.name}
      </span>
      {note.summary && (
        <span className="sum" title={note.summary} data-testid="thread-agent-note-summary">
          {note.summary}
        </span>
      )}
      {atMs !== null && (
        <span className="ago">
          <NoteAge atMs={atMs} />
        </span>
      )}
    </div>
  );
}

/** A row of a turn's work log, top level or nested under a subagent. */
export function WorkNodeView({ node, nested }: { node: WorkNode; nested?: boolean }) {
  switch (node.type) {
    case "tool":
      return <ToolRow node={node} />;
    case "group":
      return <GroupRow node={node} />;
    case "thinking":
      return <ThinkingRow node={node} />;
    case "text":
      return <TextRow id={node.id} final={node.final} nested={nested} />;
    case "question":
      return <QuestionRow id={node.id} />;
    case "permission":
      return <PermissionRow id={node.id} />;
    case "note":
      return <NoteRow id={node.id} />;
    case "system":
      return <SystemNoteRow id={node.id} />;
  }
}

const UserRow = memo(function UserRow({ id }: { id: string }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, id);
  if (it?.kind !== "user") return null;
  return <UserBubble text={it.text} composerText={it.composerText} attachments={it.attachments} createdAtMs={it.createdAtMs} />;
});

/**
 * A finished turn's footer: "Worked for 4m 08s · 12 steps · $1.12 · Opus" on a hairline,
 * the latest turn's too. It folds the turn: a click hides (or shows again) the turn's work,
 * so the answer stays. The copy button copies the final answer.
 */
const FooterRow = memo(function FooterRow({ row }: { row: Extract<TimelineRow, { type: "footer" }> }) {
  const { sessionId } = useThreadCtx();
  const it = useThreadItem(sessionId, row.id);
  const models = useModelChoices();
  if (it?.kind !== "turnEnd") return null;
  const took = formatDuration(it.durationMs);
  const what = it.interrupted ? "Interrupted" : it.isError ? `Failed (${it.subtype.replace(/_/g, " ")})` : "Worked";
  const parts = [took ? `${what}${it.interrupted || it.isError ? " after" : " for"} ${took}` : what];
  if (row.steps > 0) parts.push(`${String(row.steps)} ${row.steps === 1 ? "step" : "steps"}`);
  // The daemon's measure of the turn and the model that replied. Without them (the daemon
  // could not tell the cost, the turn had no reply, an older daemon recorded it) the
  // footer says nothing rather than guess: cost_usd is a running total whose base a
  // restart changes, and the thread's model may have changed since.
  const cost = turnCostLabel(it.turnCostUsd);
  if (cost) parts.push(cost);
  if (it.model) parts.push(canonicalModelName(models, it.model));
  const copy = () => {
    const finals = new Set(row.finals);
    const text = getThreadItems(sessionId)
      .flatMap((x: ThreadItemView) => (finals.has(x.id) && x.kind === "text" ? [x.text] : []))
      .join("\n\n");
    void copyText(text);
  };
  return (
    <div className="tfoot" data-testid="thread-footer" data-folded={row.folded || undefined}>
      <button
        type="button"
        className="fold"
        aria-expanded={!row.folded}
        aria-label={row.folded ? "Show this turn's work" : "Hide this turn's work"}
        onClick={() => {
          setTurnFolded(sessionId, row.turn, !row.folded);
        }}
      >
        <ChevronRight aria-hidden />
        {parts.map((p, i) => (
          <span key={i} className="contents">
            {i > 0 && <span className="sep">·</span>}
            <span className={it.isError && i === 0 ? "t-red" : undefined}>{p}</span>
          </span>
        ))}
      </button>
      <span className="flex-1" />
      {row.finals.length > 0 && (
        <button type="button" className="tb" aria-label="Copy answer" title="Copy answer" onClick={copy}>
          <Copy />
        </button>
      )}
    </div>
  );
});

/** "Working 3m 52s" while the turn runs (since its user message); "Starting Claude…" until Claude is up. */
function WorkingRow({ since }: { since: string }) {
  const { sessionId } = useThreadCtx();
  const start = useThreadStore((s) => s.logs[sessionId]?.byId[since]?.createdAtMs ?? null);
  const starting = useSessionsStore((s) => s.byId[sessionId]?.state === "starting");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, []);
  const took = start !== null ? formatDuration(Math.max(0, now - start)) : "";
  return (
    <div className="working" data-testid="thread-working" data-starting={starting || undefined}>
      <LoaderCircle className="animate-spin" aria-hidden />
      <span className="shimmer">{starting ? "Starting Claude…" : "Working"}</span>
      {!starting && took && <span className="tabular-nums">{took.replace(/\.\ds$/, "s")}</span>}
    </div>
  );
}

/** One timeline row. */
export function TimelineRowView({ row }: { row: TimelineRow }) {
  switch (row.type) {
    case "user":
      return <UserRow id={row.id} />;
    case "footer":
      return <FooterRow row={row} />;
    case "working":
      return <WorkingRow since={row.since} />;
    default:
      return <WorkNodeView node={row} />;
  }
}
