import { memo, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  CornerDownRight,
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
import type { ThreadItemView, ToolCallView, WakeView } from "@/api/thread";
import { Tip } from "@/components/ui/tooltip";
import { agentElapsedMs, agentName, fmtElapsed, parseAgentNote } from "@/lib/agents";
import { copyText } from "@/lib/clipboard";
import { useNow } from "@/lib/clock";
import { CREATED_BY_NOTE_ID, parseCreatedByNote } from "@/lib/lineage";
import { canonicalModelName } from "@/lib/models";
import { formatAgo } from "@/lib/thread";
import { questionsOf } from "@/lib/threadRequest";
import { wakeLine, type WakeTone } from "@/lib/wake";
import { groupLabel, turnCostLabel, type TimelineRow, type WorkNode } from "@/lib/threadTimeline";
import { formatDuration, parseObject, splitPath, str, toolFileTarget, toolSummary, type Tense } from "@/lib/toolSummary";
import { useAgentRunOfCall, useAgentRunOfNote } from "@/stores/agents";
import { useNoteCreatorId } from "@/stores/lineage";
import { useModelChoices } from "@/stores/settings";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { getThreadItems, setRowExpanded, setTurnFolded, useRowExpanded, useThreadItem, useThreadStore } from "@/stores/thread";
import { ThreadMarkdown } from "./Code";
import { CodeRunContext } from "./codeContext";
import { KeepRowContext, useThreadCtx } from "./context";
import { LineageNote } from "./LineageNote";
import { AgentOpen } from "./AgentOpen";
import { ToolPathChip } from "./PathChip";
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
  const { threadId } = useThreadCtx();
  const open = useRowExpanded(threadId, rowKey, fallback);
  return [
    open,
    () => {
      setRowExpanded(threadId, rowKey, !open);
    },
  ];
}

function durationOf(it: { createdAtMs: number | null; updatedAtMs: number | null }): number | undefined {
  return it.createdAtMs !== null && it.updatedAtMs !== null ? it.updatedAtMs - it.createdAtMs : undefined;
}

/**
 * A tool call's label: verb, then the target (bold, or mono for commands and patterns), then
 * muted detail. A file tool's target and directory are one path chip opening the file (at a
 * Read's offset, an edit's first changed line); the verb and the rest still toggle the row.
 */
function ToolLabel({ t, tense, cwd }: { t: ToolCallView; tense: Tense; cwd: string }) {
  const s = toolSummary(t, { tense, cwd });
  const file = s.target ? toolFileTarget(t) : null;
  const target =
    s.target && (s.targetStyle === "mono" ? <span className="mono cmd">{s.target}</span> : s.targetStyle === "bold" ? <b>{s.target}</b> : <span>{s.target}</span>);
  const detail = s.detail && <span className={s.detailMono ? "mono text-muted-foreground" : "text-muted-foreground"}>{s.detail}</span>;
  return (
    <>
      {s.verb}{" "}
      {file ? (
        <ToolPathChip path={file.path} line={file.line}>
          {target}
          {detail && <> {detail}</>}
        </ToolPathChip>
      ) : (
        <>
          {target}
          {detail && <> {detail}</>}
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
      {(running || itemRunning) && <LoaderCircle className="size-3.5 animate-spin text-info" aria-label="Running" />}
    </>
  );
}

/**
 * A tool call: its row, and when open its detail (a subagent: its nested rows and report).
 * Open by default: a running subagent, and a file edit waiting for permission.
 */
const ToolRow = memo(function ToolRow({ node }: { node: Extract<WorkNode, { type: "tool" }> }) {
  const { threadId, cwd } = useThreadCtx();
  const item = useThreadItem(threadId, node.id);
  const perm = useThreadItem(threadId, node.permissionId);
  const t = item?.kind === "tool" ? item : null;
  const agent = node.name === "Agent" || node.name === "Task";
  // The run the daemon follows for this Agent call (docs/notes/agents-1-daemon.md); a
  // background call's item stays running until the run ends.
  const run = useAgentRunOfCall(threadId, agent ? node.id : "");
  const request = perm?.kind === "permission" ? perm.request : null;
  const waiting = request?.state === "pending";
  // A running foreground subagent opens to show its work; a background one stays a line
  // (its progress is the activity on the row, the strip and the Agents tab), and so does a
  // nested run (spawned by another run): the stream never carries its work.
  const [open, toggle] = useToggle(node.key, (agent && t?.status === "running" && !run?.background && (run?.spawnDepth ?? 1) <= 1) || (waiting && EDIT_TOOLS.has(node.name)));
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
      {t.status === "running" && <LoaderCircle className="size-3.5 animate-spin text-info" aria-label="Running" />}
    </>
  );
  // A thread's own run opens in the read-only subagent view; a nested one (spawned by
  // another run) has nothing to show there.
  const openable = run !== undefined && run.spawnDepth <= 1;
  return (
    <div className={openable ? "agent-host" : undefined} data-tool={t.name} data-status={t.status}>
      <Row
        icon={toolIcon(t.name)}
        label={<ToolLabel t={t} tense={tense} cwd={cwd} />}
        meta={meta}
        expanded={waiting && !EDIT_TOOLS.has(t.name) ? undefined : open}
        onToggle={toggle}
        testId="thread-tool"
        data={{ "data-waiting": waiting ? "true" : undefined }}
      />
      {openable && <AgentOpen threadId={threadId} runId={run.id} name={agentName(run)} />}
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
            {request && request.state !== "allowed" && request.message && <p className="mb-1 text-caption">{request.message}</p>}
            <ToolDetail t={t} cwd={cwd} />
          </div>
        ))}
    </div>
  );
});

/** Base names of a group's files and patterns, for its meta ("poller.go, poller_test.go, gh/client.go"). */
function useGroupTargets(ids: readonly string[]): string[] {
  const { threadId } = useThreadCtx();
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
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
  const { threadId } = useThreadCtx();
  const [open, toggle] = useToggle(node.key, false);
  const info = useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
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
      {open && info.text && <div className="detail text-caption leading-relaxed whitespace-pre-wrap italic selectable">{info.text}</div>}
    </div>
  );
});

/** Claude's text: markdown, with a caret while it streams; the turn's final answer gets more air. */
/**
 * Copies a finished turn's answer (its final text items, `answer`'s ids, joined by blank
 * lines): a 24px button at the answer's top right, shown while the answer is hovered.
 */
function CopyAnswer({ answer }: { answer: string }) {
  const { threadId } = useThreadCtx();
  const copy = () => {
    const ids = new Set(answer.split("\n"));
    const text = getThreadItems(threadId)
      .flatMap((x: ThreadItemView) => (ids.has(x.id) && x.kind === "text" ? [x.text] : []))
      .join("\n\n");
    void copyText(text);
  };
  return (
    <Tip label="Copy answer">
      <button type="button" className="tb copy-answer" aria-label="Copy answer" data-testid="thread-copy-answer" onClick={copy}>
        <Copy aria-hidden />
      </button>
    </Tip>
  );
}

const TextRow = memo(function TextRow({ id, final, answer, nested }: { id: string; final: boolean; answer?: string; nested?: boolean }) {
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
  const text = it?.kind === "text" ? it.text : "";
  const streaming = it?.kind === "text" && it.streaming;
  // Claude's reply: its shell blocks offer Run in terminal (CodeActions).
  const run = useMemo(() => ({ threadId, text, streaming }), [threadId, text, streaming]);
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
      {answer && <CopyAnswer answer={answer} />}
    </div>
  );
});

/** An AskUserQuestion: "Asked [Header] answer" once answered, amber "waiting for you" while it asks. */
const QuestionRow = memo(function QuestionRow({ id }: { id: string }) {
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
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
        <dl className="detail grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm selectable">
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
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
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
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
  const [open, toggle] = useToggle(id, false);
  if (!it) return null;
  if (it.kind === "error") {
    return (
      <div className="my-1.5 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-body-sm selectable" data-testid="thread-error">
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
          <div className="detail text-caption">
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
 * A system note (the daemon's, not Claude's). A fork's "Forked from …" (and any note
 * without a style of its own) is one quiet centered line between hairlines, the sketch's
 * divider (docs/sketches/rendered-thread): it marks where the history the fork copied from
 * its parent ends. "Created by …" and a subagent's end are one-line notes of their own.
 */
const SystemNoteRow = memo(function SystemNoteRow({ id }: { id: string }) {
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
  const run = useAgentRunOfNote(threadId, id);
  if (it?.kind !== "note") return null;
  const note = parseAgentNote(it.text, run?.description ?? "");
  if (note) return <AgentNoteRow note={note} atMs={it.createdAtMs} threadId={threadId} run={run && run.spawnDepth <= 1 ? run : undefined} />;
  if (parseCreatedByNote(it.text)) return <CreatedByNoteRow threadId={threadId} id={id} text={it.text} atMs={it.createdAtMs} />;
  return (
    <div className="sysnote" role="separator" aria-label={it.text} data-testid="thread-note">
      <span className="selectable">{it.text}</span>
    </div>
  );
});

/**
 * The daemon's note at the top of a thread an agent created
 * (docs/notes/agents-3-lineage-gui.md): "↳ Created by <creator> · brief: <brief>" on the
 * lineage note's faint line, the creator's name a link that opens it (as a sidebar click
 * does), the age on the right. The creator is the thread's recorded one for its own note,
 * else (a fork's copied note) the one thread with that name; a creator that cannot be
 * found (removed, or the name is ambiguous) is muted text.
 */
function CreatedByNoteRow({ threadId, id, text, atMs }: { threadId: string; id: string; text: string; atMs: number | null }) {
  const recorded = useThreadsStore((s) => (id === CREATED_BY_NOTE_ID ? (s.byId[threadId]?.createdByName ?? "") : ""));
  const note = parseCreatedByNote(text, recorded) ?? { name: "", brief: "" };
  const creatorId = useNoteCreatorId(threadId, id, note.name);
  return (
    <LineageNote icon={<CornerDownRight aria-hidden />} atMs={atMs} testId="thread-created-by-note">
      <span className="lead">Created by</span>
      {creatorId ? (
        <button
          type="button"
          className="nm"
          data-testid="thread-created-by-note-link"
          data-thread={creatorId}
          onClick={(e) => {
            e.stopPropagation();
            useUiStore.getState().select({ kind: "thread", id: creatorId }, { focusPrompt: true });
          }}
        >
          {note.name}
        </button>
      ) : (
        <span className="nm gone" data-testid="thread-created-by-note-name">
          {note.name}
        </span>
      )}
      {note.brief && (
        <>
          <span className="ghost" aria-hidden>
            ·
          </span>
          <Tip label={`brief: ${note.brief}`} whenTruncated>
            <span className="sum selectable" data-testid="thread-created-by-note-brief">
              brief: {note.brief}
            </span>
          </Tip>
        </>
      )}
    </LineageNote>
  );
}

/** "just now", "5 min ago": the note's age on the shared 30 s clock. */
function NoteAge({ atMs }: { atMs: number }) {
  const now = useNow(30_000);
  return <>{formatAgo(atMs, now)}</>;
}

/**
 * The daemon's note when a background subagent ends (docs/notes/agents-1-daemon.md):
 * one quiet line, a check (emerald) or a cross (red), "Agent finished · name", the report's
 * first line ellipsised, and its age on the right; when its run is known, "Open ›" after
 * the age (on hover) shows the run in the read-only subagent view.
 */
function AgentNoteRow({ note, atMs, threadId, run }: { note: ReturnType<typeof parseAgentNote> & object; atMs: number | null; threadId: string; run?: AgentRunView }) {
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
        <Tip label={note.summary} whenTruncated>
          <span className="sum" data-testid="thread-agent-note-summary">
            {note.summary}
          </span>
        </Tip>
      )}
      {atMs !== null && (
        <span className="ago">
          <NoteAge atMs={atMs} />
        </span>
      )}
      {run && <AgentOpen threadId={threadId} runId={run.id} name={note.name} testId="thread-agent-note-open" />}
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
      return <TextRow id={node.id} final={node.final} answer={nested ? undefined : node.answer} nested={nested} />;
    case "question":
      return <QuestionRow id={node.id} />;
    case "permission":
      return <PermissionRow id={node.id} />;
    case "note":
      return <NoteRow id={node.id} />;
    case "system":
      return <SystemNoteRow id={node.id} />;
    case "steer":
      return <UserRow id={node.id} steer />;
  }
}

const WAKE_ICONS: Readonly<Record<WakeTone, { icon: LucideIcon; cls: string; label: string }>> = {
  ok: { icon: CircleCheck, cls: "t-emerald", label: "Finished" },
  attention: { icon: CircleAlert, cls: "t-amber", label: "Needs attention" },
  fail: { icon: CircleX, cls: "t-red", label: "Failed" },
};

/**
 * A message the daemon sent for a wake subscription (docs/notes/agents-4-wake.md), drawn
 * as a lineage note instead of a bubble (docs/notes/agents-3-lineage-gui.md): the tone's
 * icon, "Woken by <thread>: idle, finished", the report's summary, the age, and the
 * payload as a JSON block once expanded. The thread's name is a link while it exists
 * (its current name; the payload's otherwise); an action run's name is plain text.
 */
function WakeNoteRow({ wake, atMs }: { wake: WakeView; atMs: number | null }) {
  const line = useMemo(() => wakeLine(wake), [wake]);
  const exists = useThreadsStore((s) => line.threadId !== "" && line.threadId in s.byId);
  const current = useThreadsStore((s) => (line.threadId ? (s.byId[line.threadId]?.name ?? "") : ""));
  const name = current || line.name;
  const look = WAKE_ICONS[line.tone];
  const Icon = look.icon;
  return (
    <LineageNote icon={<Icon className={look.cls} aria-label={look.label} />} atMs={atMs} body={{ label: "Wake payload", lang: "json", code: line.json }} testId="thread-wake-note">
      <span className="lead">Woken by</span>
      {name && (
        <span className="who">
          {exists ? (
            <button
              type="button"
              className="nm"
              data-testid="thread-wake-note-link"
              data-thread={line.threadId}
              onClick={(e) => {
                e.stopPropagation();
                useUiStore.getState().select({ kind: "thread", id: line.threadId }, { focusPrompt: true });
              }}
            >
              {name}
            </button>
          ) : (
            <span className={line.threadId ? "nm gone" : "nm plain"} data-testid="thread-wake-note-name">
              {name}
            </span>
          )}
          {line.detail && <span data-testid="thread-wake-note-detail">: {line.detail}</span>}
        </span>
      )}
      {line.summary && (
        <>
          {name && (
            <span className="ghost" aria-hidden>
              ·
            </span>
          )}
          <Tip label={line.summary} whenTruncated>
            <span className="sum" data-testid="thread-wake-note-summary">
              {line.summary}
            </span>
          </Tip>
        </>
      )}
    </LineageNote>
  );
}

/** A user message: a turn's opening bubble, or a steer's smaller one inside the turn; a wake message is a note either way. */
const UserRow = memo(function UserRow({ id, steer }: { id: string; steer?: boolean }) {
  const { threadId } = useThreadCtx();
  const it = useThreadItem(threadId, id);
  if (it?.kind !== "user") return null;
  if (it.wake) return <WakeNoteRow wake={it.wake} atMs={it.createdAtMs} />;
  return <UserBubble text={it.text} composerText={it.composerText} attachments={it.attachments} createdAtMs={it.createdAtMs} steer={steer} />;
});

/** Re-renders every second while `live`. */
function useLiveNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(t);
    };
  }, [live]);
  return now;
}

/** A header's line: its parts with a "·" between them; the first one red when `red`. */
function Parts({ parts, red }: { parts: readonly string[]; red?: boolean }) {
  return parts.map((p, i) => (
    <span key={i} className="contents">
      {i > 0 && <span className="sep">·</span>}
      <span className={red && i === 0 ? "t-red" : undefined}>{p}</span>
    </span>
  ));
}

function stepsLabel(steps: number): string {
  return `${String(steps)} ${steps === 1 ? "step" : "steps"}`;
}

/**
 * A turn's header, under its user message and above its work
 * (docs/notes/thread-fold-3-header.md). Finished: "Worked for 4m 08s · 12 steps · $1.12 ·
 * Opus" behind a chevron (right when folded, down when open); a click folds or unfolds the
 * turn's work below it, and the header keeps its place on screen (KeepRowContext). A turn
 * without work (no steps) has nothing to fold: the line is plain text. Live (the turn
 * runs): a sky spinner, "Working" shimmering, the steps so far and the time since the
 * turn's message, always open. One component for both under one row key, so the live line
 * turns into the finished one in place.
 */
const HeaderRow = memo(function HeaderRow({ row }: { row: Extract<TimelineRow, { type: "header" }> }) {
  const { threadId } = useThreadCtx();
  const keep = useContext(KeepRowContext);
  const live = row.id === "";
  const it = useThreadItem(threadId, row.id);
  const start = useThreadStore((s) => (live && row.since ? (s.logs[threadId]?.byId[row.since]?.createdAtMs ?? null) : null));
  const now = useLiveNow(live);
  const models = useModelChoices();
  if (live) {
    const parts = ["Working"];
    if (row.steps > 0) parts.push(stepsLabel(row.steps));
    if (start !== null) parts.push(formatDuration(Math.max(0, now - start)).replace(/\.\ds$/, "s"));
    return (
      <div className="thead" data-testid="thread-turn-header" data-live>
        <span className="line text-caption" data-testid="thread-working">
          <span className="ico">
            <LoaderCircle className="t-sky animate-spin" aria-hidden />
          </span>
          {parts.map((p, i) => (
            <span key={i} className="contents">
              {i > 0 && <span className="sep">·</span>}
              <span className={i === 0 ? "shimmer" : "tabular-nums"}>{p}</span>
            </span>
          ))}
        </span>
      </div>
    );
  }
  if (it?.kind !== "turnEnd") return null;
  const took = formatDuration(it.durationMs);
  const what = it.interrupted ? "Interrupted" : it.isError ? `Failed (${it.subtype.replace(/_/g, " ")})` : "Worked";
  const parts = [took ? `${what}${it.interrupted || it.isError ? " after" : " for"} ${took}` : what];
  if (row.steps > 0) parts.push(stepsLabel(row.steps));
  // The daemon's measure of the turn and the model that replied. Without them (the daemon
  // could not tell the cost, the turn had no reply, an older daemon recorded it) the
  // header says nothing rather than guess: cost_usd is a running total whose base a
  // restart changes, and the thread's model may have changed since.
  const cost = turnCostLabel(it.turnCostUsd);
  if (cost) parts.push(cost);
  if (it.model) parts.push(canonicalModelName(models, it.model));
  return (
    <div className="thead" data-testid="thread-turn-header" data-folded={row.folded || undefined}>
      {row.steps === 0 ? (
        <span className="line text-caption" data-testid="thread-turn-header-line">
          <Parts parts={parts} red={it.isError} />
        </span>
      ) : (
        <button
          type="button"
          className="fold text-caption"
          aria-expanded={!row.folded}
          aria-label={row.folded ? "Show this turn's work" : "Hide this turn's work"}
          onClick={() => {
            keep(row.key);
            setTurnFolded(threadId, row.turn, !row.folded);
          }}
        >
          <span className="ico">
            <ChevronRight aria-hidden />
          </span>
          <Parts parts={parts} red={it.isError} />
        </button>
      )}
    </div>
  );
});

/** One timeline row. */
export function TimelineRowView({ row }: { row: TimelineRow }) {
  switch (row.type) {
    case "user":
      return <UserRow id={row.id} />;
    case "header":
      return <HeaderRow row={row} />;
    default:
      return <WorkNodeView node={row} />;
  }
}
