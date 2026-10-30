import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, Bot, ChevronRight, CircleCheck, CircleX, CornerDownRight, LoaderCircle, Lock } from "lucide-react";
import type { AgentRunView } from "@/api/agents";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { formatChord } from "@/keys/chord";
import { agentElapsedMs, agentMode, agentName, agentStatusText, fmtElapsed } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { canonicalModelName } from "@/lib/models";
import { agentPrompt, footerParts, lastTextId, reportIsLastText, runNodes, turnOfCall } from "@/lib/subagentView";
import { decodeTimelineKey, type WorkNode } from "@/lib/threadTimeline";
import { formatAgo } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { useAgentRun } from "@/stores/agents";
import { useCommandsStore } from "@/stores/commands";
import { useModelChoices } from "@/stores/settings";
import { goUpFromSubagent, SUBAGENT_COMMANDS } from "@/stores/subagentActions";
import { useRunTimelineKeys, useSubagentViewStore } from "@/stores/subagentView";
import { useThreadItem, useThreadLoaded, useThreadStore, useTimelineKeys } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { ThreadMarkdown } from "./Code";
import { ThreadContext } from "./context";
import { PaneOverlay } from "./InlineHtml";
import { WorkNodeView } from "./rows";
import { TimelineList } from "./Timeline";
import { UserBubble } from "./UserBubble";
import "./thread.css";

/** The floating plate's height, for the list's bottom inset. */
function useHeight(ref: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      setH(el.offsetHeight);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [ref]);
  return h;
}

/** The parent thread's name (its id while it has none). */
function useParentName(threadId: string): string {
  return useThreadsStore((s) => s.byId[threadId]?.name || threadId);
}

/** The model the run used, as the app names models: the one it asked for, else its thread's. */
function useRunModel(threadId: string, model: string): string {
  const threadModel = useThreadsStore((s) => s.byId[threadId]?.model ?? "");
  const choices = useModelChoices();
  const id = model || threadModel;
  return id ? canonicalModelName(choices, id) : "";
}

/** "Running · 4m 12s" (live), "Done · 5 min ago", "Failed · 3 min ago": the run's status words and tones. */
function RunStatus({ run }: { run: AgentRunView }) {
  const running = run.status === "running";
  const now = useNow(running ? 1000 : 30_000);
  const ms = running ? agentElapsedMs(run, now) : null;
  const text = running ? (ms === null ? "Running" : `Running · ${fmtElapsed(ms)}`) : agentStatusText(run, now);
  const Icon = running ? LoaderCircle : run.status === "failed" ? CircleX : run.status === "done" ? CircleCheck : null;
  const tone = running ? "text-cf-info-text" : run.status === "failed" ? "text-cf-error-text" : run.status === "done" ? "text-cf-success-text" : "text-cf-text-muted";
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5 text-caption whitespace-nowrap tabular-nums", tone)} data-testid="subagent-status" data-status={run.status}>
      {Icon && <Icon className={cn("size-3.5 shrink-0", running && "animate-spin")} aria-hidden />}
      {text}
    </span>
  );
}

/** A quiet button that runs thread.agent.up (the crumb's parent, the note's links). */
function UpLink({ children, className, testId }: { children: ReactNode; className?: string; testId: string }) {
  return (
    <button
      type="button"
      className={className}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        goUpFromSubagent();
      }}
    >
      {children}
    </button>
  );
}

/**
 * The header: back, the crumb (the parent as a muted link, ›, the run's name), a Read-only
 * chip, the run's status, then the panel toggle. A subagent has no thread actions.
 */
function SubagentHeader({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const parent = useParentName(threadId);
  return (
    <PaneHeader className="gap-2 px-3" data-testid="subagent-header">
      <Tip label={`Back to ${parent}`}>
        <Button type="button" variant="ghost" size="icon-xs" className="-ml-1 shrink-0" aria-label="Back to parent thread" data-testid="subagent-back" onClick={() => goUpFromSubagent()}>
          <ArrowLeft className="size-3.5" aria-hidden />
        </Button>
      </Tip>
      <span className="flex min-w-0 flex-1 basis-0 items-center gap-1.5 text-label" data-testid="subagent-crumb">
        <UpLink className="min-w-0 shrink-[4] truncate rounded-sm px-1 text-cf-text-muted hover:bg-cf-control-hover hover:text-cf-text" testId="subagent-crumb-parent">
          {parent}
        </UpLink>
        <ChevronRight className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        <Bot className="size-3.5 shrink-0 text-cf-info-text" aria-hidden />
        <span className="min-w-0 truncate font-medium" data-testid="subagent-name">
          {agentName(run)}
        </span>
      </span>
      <Tip label="A subagent takes its instructions from its parent thread">
        <span className="flex h-[22px] shrink-0 items-center gap-1 rounded-md border border-cf-warning/50 px-1.5 text-caption-sm font-medium text-cf-warning-text" data-testid="subagent-readonly">
          <Lock className="size-3" aria-hidden />
          Read-only
        </span>
      </Tip>
      <RunStatus run={run} />
      <span className="-mr-1.5 flex shrink-0 items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
        <PanelToggle />
      </span>
    </PaneHeader>
  );
}

/**
 * "↳ Subagent of <parent> · background · general-purpose · Opus 4.8 · high · launched by
 * turn 3's Agent call, 4 min ago", "← Back to <parent>" at the right.
 */
function LineageRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const parent = useParentName(threadId);
  const model = useRunModel(threadId, run.model);
  const keys = useTimelineKeys(threadId);
  const turn = useMemo(() => turnOfCall(keys.map(decodeTimelineKey), run.toolUseId), [keys, run.toolUseId]);
  const now = useNow(30_000);
  const launched = run.startedAtMs === null ? "" : formatAgo(run.startedAtMs, now);
  const meta = [agentMode(run), run.agentType, model, run.effort].filter(Boolean).join(" · ");
  const when = turn > 0 ? `launched by turn ${String(turn)}'s Agent call${launched ? `, ${launched}` : ""}` : launched ? `launched ${launched}` : "";
  const tail = [meta, when].filter(Boolean).join(" · ");
  return (
    <div className="lnote" role="note" data-testid="subagent-lineage">
      <div className="ln">
        <CornerDownRight aria-hidden />
        <span className="lead">Subagent of</span>
        <UpLink className="nm" testId="subagent-lineage-parent">
          {parent}
        </UpLink>
        {tail && (
          <>
            <span className="ghost" aria-hidden>
              ·
            </span>
            <Tip label={tail} whenTruncated>
              <span className="sum" data-testid="subagent-lineage-meta">
                {tail}
              </span>
            </Tip>
          </>
        )}
        <UpLink className="back" testId="subagent-lineage-back">
          <ArrowLeft aria-hidden />
          <span className="truncate">Back to {parent}</span>
        </UpLink>
      </div>
    </div>
  );
}

/** The run's prompt as a user bubble, "Prompt from <parent>" above its text, its time under it. */
function PromptRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const parent = useParentName(threadId);
  const call = useThreadItem(threadId, run.toolUseId);
  const prompt = call?.kind === "tool" ? agentPrompt(call.inputJson) : "";
  const label = (
    <>
      <Bot className="size-3 shrink-0" aria-hidden />
      Prompt from {parent}
    </>
  );
  if (!prompt) return null;
  return <UserBubble text={prompt} composerText="" attachments={[]} createdAtMs={call?.createdAtMs ?? run.startedAtMs} label={label} testId="subagent-prompt" />;
}

/** The run's line under its work: spinner "Working for …" / check "Worked for …" / cross and the error. */
function FooterRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const model = useRunModel(threadId, run.model);
  const running = run.status === "running";
  const now = useNow(running ? 1000 : 60_000);
  const parts = footerParts(run, model, now);
  const failed = run.status === "failed";
  const Icon = running ? LoaderCircle : failed ? CircleX : CircleCheck;
  return (
    <div className="thead subfoot" data-testid="subagent-footer" data-status={run.status}>
      <span className={cn("line text-caption", failed && "whitespace-normal")}>
        <span className="ico">
          <Icon className={running ? "t-sky animate-spin" : failed ? "t-red" : "t-emerald"} aria-hidden />
        </span>
        {parts.map((p, i) => (
          <span key={i} className="contents">
            {i > 0 && <span className="sep">·</span>}
            <span className={failed ? "t-red selectable" : i === 0 && running ? "shimmer" : "tabular-nums"}>{p}</span>
          </span>
        ))}
      </span>
    </div>
  );
}

/** A finished run's handed-back report (when its last text is not already it). */
function ReportRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const parent = useParentName(threadId);
  return (
    <div className="subreport selectable" data-testid="subagent-report">
      <div className="text-overline">Report handed back to {parent}</div>
      <ThreadMarkdown>{run.summary}</ThreadMarkdown>
    </div>
  );
}

/** The dashed plate where the composer would be: why it is read-only, and the way back. */
function ReadOnlyPlate({ threadId, status }: { threadId: string; status: AgentRunView["status"] }) {
  const parent = <b className="font-medium text-cf-text">{useParentName(threadId)}</b>;
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === SUBAGENT_COMMANDS.up)?.keybindings[0] ?? "");
  const why =
    status === "done" ? (
      <>This agent finished and handed its report to {parent}.</>
    ) : status === "failed" ? (
      <>This agent failed. Its parent {parent} was told.</>
    ) : (
      <>A subagent takes its instructions from its parent thread. To steer it, send a follow-up to {parent}.</>
    );
  return (
    <div className="flex items-center gap-3 rounded-lg border border-dashed border-cf-border bg-cf-surface px-4 py-3 text-body-sm text-cf-text-muted" data-testid="subagent-plate">
      <Lock className="size-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1" data-testid="subagent-plate-text">
        <b className="font-medium text-cf-text">Read-only.</b> {why}
      </p>
      <Button type="button" variant="outline" size="sm" className="max-w-[45%] shrink-0" data-testid="subagent-plate-back" onClick={() => goUpFromSubagent()}>
        <ArrowLeft aria-hidden />
        <span className="truncate">Back to {useParentName(threadId)}</span>
        {chord && (
          <Kbd size="sm" className="ml-0.5" data-testid="subagent-plate-chord">
            {formatChord(chord).toLowerCase()}
          </Kbd>
        )}
      </Button>
    </div>
  );
}

type SubRow = { type: "lineage"; key: string } | { type: "prompt"; key: string } | WorkNode | { type: "footer"; key: string } | { type: "report"; key: string };

function estimateSubRow(r: SubRow | undefined): number {
  switch (r?.type) {
    case "lineage":
      return 46;
    case "prompt":
      return 110;
    case "text":
      return 64;
    case "report":
      return 90;
    default:
      return 26;
  }
}

/** Whether the run's handed-back report shows as a block of its own: done, and not already its last text. */
function useReportShown(threadId: string, runId: string, lastId: string): boolean {
  return useThreadStore((s) => {
    const log = s.logs[threadId];
    const run = log?.agents.find((r) => r.id === runId);
    if (run?.status !== "done" || !run.summary.trim()) return false;
    const it = lastId ? log?.byId[lastId] : undefined;
    return !reportIsLastText(run.summary, it?.kind === "text" ? it.text : "");
  });
}

const RUN_PARTS = { lineage: LineageRow, prompt: PromptRow, footer: FooterRow, report: ReportRow } as const;

/** The view's own rows (lineage, prompt, footer, report): only these follow the run's record. */
function RunPart({ part, threadId, runId }: { part: keyof typeof RUN_PARTS; threadId: string; runId: string }) {
  const run = useAgentRun(threadId, runId);
  if (!run) return null;
  const Part = RUN_PARTS[part];
  return <Part threadId={threadId} run={run} />;
}

/** One row of the view: one of its own rows, else a work row as the thread's timeline draws it. */
const SubRowView = memo(function SubRowView({ row, threadId, runId }: { row: SubRow; threadId: string; runId: string }) {
  switch (row.type) {
    case "lineage":
    case "prompt":
    case "footer":
    case "report":
      return <RunPart part={row.type} threadId={threadId} runId={runId} />;
    default:
      return <WorkNodeView node={row} />;
  }
});

/**
 * The run's transcript as a list: the lineage note, the prompt, its work (the items whose
 * parent is its Agent call; structural keys only, so a progress tick or a text delta does
 * not rebuild it), the footer and the report. Nothing folds: one run is one turn.
 */
function SubagentList({ threadId, runId, toolUseId, bottomInset }: { threadId: string; runId: string; toolUseId: string; bottomInset: number }) {
  const keys = useRunTimelineKeys(threadId, toolUseId);
  const nodes = useMemo(() => runNodes(keys.map(decodeTimelineKey)), [keys]);
  const report = useReportShown(threadId, runId, lastTextId(nodes));
  const rows = useMemo<SubRow[]>(
    () => [{ type: "lineage", key: "sub:lineage" }, { type: "prompt", key: "sub:prompt" }, ...nodes, { type: "footer", key: "sub:footer" }, ...(report ? [{ type: "report" as const, key: "sub:report" }] : [])],
    [nodes, report],
  );
  const render = useMemo(() => (row: SubRow) => <SubRowView row={row} threadId={threadId} runId={runId} />, [threadId, runId]);
  return <TimelineList threadId={threadId} rows={rows} bottomInset={bottomInset} renderRow={render} estimateRow={estimateSubRow} />;
}

/** The run's header (its own subscription: a progress tick re-renders the header, not the pane). */
function RunHeader({ threadId, runId }: { threadId: string; runId: string }) {
  const run = useAgentRun(threadId, runId);
  if (!run)
    return (
      <PaneHeader className="gap-2 px-3" data-testid="subagent-header">
        <span className="text-label text-cf-text-muted">Subagent</span>
      </PaneHeader>
    );
  return <SubagentHeader threadId={threadId} run={run} />;
}

/**
 * The read-only subagent view (stores/subagentView.ts): one of the selected thread's own
 * subagent runs as if it were a thread page, in the content pane while the thread stays
 * selected (its Watch feeds both). A header with the way back up, the run's prompt, work
 * and report, and a dashed plate where the composer would be. Escape (thread.agent.up)
 * goes back while the keyboard is in the view, which takes it when a run opens.
 */
export function SubagentPane({ threadId, runId }: { threadId: string; runId: string }) {
  // Narrow: the pane re-renders when the run appears or ends, not on its progress.
  const toolUseId = useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.id === runId)?.toolUseId ?? null);
  const status = useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.id === runId)?.status ?? "unknown");
  const loaded = useThreadLoaded(threadId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const dockRef = useRef<HTMLDivElement>(null);
  const dockHeight = useHeight(dockRef);
  const rootRef = useRef<HTMLElement>(null);
  const focusSeq = useSubagentViewStore((s) => s.focusSeq);
  // A run that opens takes the keyboard (Escape goes back up), unless the palette has it.
  useEffect(() => {
    if (useUiStore.getState().palette.open) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [focusSeq, runId]);
  return (
    <ThreadContext.Provider value={ctx}>
      <section
        ref={rootRef}
        className="cf-thread flex min-h-0 min-w-0 flex-1 flex-col outline-none"
        tabIndex={-1}
        aria-label="Subagent"
        data-thread-id={threadId}
        data-run-id={runId}
        data-testid="subagent-pane"
        data-region="content"
        data-focus-root
      >
        <RunHeader threadId={threadId} runId={runId} />
        <div className="relative flex min-h-0 flex-1 flex-col">
          {/* A run's own modal scope: the thread's page modal stays with the thread's body. */}
          <PaneOverlay scope={`${threadId}/${runId}`} threadId={threadId}>
            {!loaded && <p className="absolute inset-x-0 top-10 text-center text-body text-cf-text-muted">Loading the conversation…</p>}
            {toolUseId !== null && <SubagentList threadId={threadId} runId={runId} toolUseId={toolUseId} bottomInset={dockHeight} />}
            <div className="dock" ref={dockRef}>
              <ReadOnlyPlate threadId={threadId} status={status} />
            </div>
          </PaneOverlay>
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
