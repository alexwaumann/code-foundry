import { memo, useContext, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Bot, CornerDownRight } from "lucide-react";
import type { AgentRunView } from "@/api/agents";
import { ThreadInfoCard } from "@/components/threadinfo/ThreadInfoCard";
import { ThreadInfoOverlay } from "@/components/threadinfo/ThreadInfoOverlay";
import { useInfoRoom } from "@/components/threadinfo/useInfoRoom";
import { Tip } from "@/components/ui/tooltip";
import { PaneHeader } from "@/components/window/PaneHeader";
import { agentMode, agentName } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { formatAge } from "@/lib/duration";
import { canonicalModelName } from "@/lib/models";
import { agentPrompt, headerParts, lastTextId, reportIsLastText, runFolded, runFoldKey, runNodes, shownNodes, turnOfCall } from "@/lib/subagentView";
import { decodeTimelineKey, type WorkNode } from "@/lib/threadTimeline";
import { useAgentRun } from "@/stores/agents";
import { useModelChoices } from "@/stores/settings";
import { goUpFromSubagent } from "@/stores/subagentActions";
import { useRunTimelineKeys, useSubagentViewStore } from "@/stores/subagentView";
import { setTurnFolded, useThreadItem, useThreadLoaded, useThreadStore, useTimelineKeys, useTurnFolds } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { useThreadInfoOpen } from "@/stores/threadInfoOverlay";
import { useUiStore } from "@/stores/ui";
import { useElementHeight } from "./activity";
import { ThreadMarkdown } from "./Code";
import { KeepRowContext, ThreadContext } from "./context";
import { HeaderActions } from "./HeaderActions";
import { PaneOverlay } from "./InlineHtml";
import { TurnHead, WorkNodeView } from "./rows";
import { SubagentComposer } from "./SubagentComposer";
import { CRUMB_LINK, ThreadCrumb } from "./ThreadParts";
import { TimelineList } from "./Timeline";
import { UserBubble } from "./UserBubble";
import "./thread.css";

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

/** A quiet button that runs thread.agent.up (the crumb's parent, the note's name). */
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
 * The left of the header, a thread's without its menu: the crumb (where it runs, the parent
 * as the way back up), then the Bot and the run's name. A subagent has no thread actions.
 */
function RunTitle({ threadId, runId }: { threadId: string; runId: string }) {
  const parent = useParentName(threadId);
  // Narrow: a string, so a progress tick does not re-render the header.
  const name = useThreadStore((s) => {
    const run = s.logs[threadId]?.agents.find((r) => r.id === runId);
    return run ? agentName(run) : "Subagent";
  });
  const crumb = useMemo(
    () => ({
      parent: (
        <UpLink className={CRUMB_LINK} testId="subagent-crumb-parent">
          {parent}
        </UpLink>
      ),
    }),
    [parent],
  );
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1" data-testid="thread-title-bar">
      <ThreadCrumb id={threadId} run={crumb} />
      <span className="flex h-6 min-w-12 shrink items-center gap-1.5 px-1.5 text-label font-medium text-cf-text" data-testid="subagent-title">
        <Bot className="size-3.5 shrink-0 text-cf-info-text" aria-hidden />
        <Tip label={name} whenTruncated>
          <span className="min-w-0 truncate" data-testid="subagent-name">
            {name}
          </span>
        </Tip>
      </span>
    </span>
  );
}

/**
 * "↳ Subagent of <parent> · background · general-purpose · Opus 4.8 · high · launched by
 * turn 3's Agent call, 4m ago".
 */
function LineageRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const parent = useParentName(threadId);
  const model = useRunModel(threadId, run.model);
  const keys = useTimelineKeys(threadId);
  const turn = useMemo(() => turnOfCall(keys.map(decodeTimelineKey), run.toolUseId), [keys, run.toolUseId]);
  const now = useNow(30_000);
  const launched = run.startedAtMs === null ? "" : formatAge(run.startedAtMs, now, { minutes: true, hours: true, days: true });
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
      </div>
    </div>
  );
}

/** The run's prompt: a plain user bubble, its time under it. */
function PromptRow({ threadId, run }: { threadId: string; run: AgentRunView }) {
  const call = useThreadItem(threadId, run.toolUseId);
  const prompt = call?.kind === "tool" ? agentPrompt(call.inputJson) : "";
  if (!prompt) return null;
  return <UserBubble text={prompt} composerText="" attachments={[]} createdAtMs={call?.createdAtMs ?? run.startedAtMs} testId="subagent-prompt" foldKey={`prompt:${run.toolUseId}`} />;
}

/**
 * The run's turn header, above its work as a thread's turn has it. Live: "Working for
 * 4m 12s · 23 tools · 48.2K tokens · Opus"; finished, the same line behind the chevron that
 * folds its work ("Worked for …", red "Failed after …"), which keeps its place on screen.
 */
function HeadRow({ threadId, run, folded, foldable }: { threadId: string; run: AgentRunView; folded: boolean; foldable: boolean }) {
  const keep = useContext(KeepRowContext);
  const model = useRunModel(threadId, run.model);
  const running = run.status === "running";
  const now = useNow(running ? 1000 : 60_000);
  const parts = headerParts(run, model, now);
  return (
    <TurnHead
      live={running}
      parts={parts}
      red={run.status === "failed"}
      folded={folded}
      foldable={foldable}
      what="agent"
      status={run.status}
      onToggle={() => {
        keep(HEAD_KEY);
        setTurnFolded(threadId, runFoldKey(run.id), !folded);
      }}
    />
  );
}

/** A finished run's handed-back report (when its last text is not already it), as a turn's answer reads. */
function ReportRow({ run }: { run: AgentRunView }) {
  return (
    <div className="a-md final selectable" data-testid="subagent-report">
      <ThreadMarkdown>{run.summary}</ThreadMarkdown>
    </div>
  );
}

/** Why a failed run failed, in its own words. */
function ErrorRow({ run }: { run: AgentRunView }) {
  return (
    <div className="a-md selectable text-body break-words whitespace-pre-wrap text-cf-error-text" role="alert" data-testid="subagent-error">
      {run.error}
    </div>
  );
}

const HEAD_KEY = "sub:head";

type SubRow = { type: "lineage"; key: string } | { type: "prompt"; key: string } | { type: "head"; key: string; folded: boolean; foldable: boolean } | WorkNode | { type: "error"; key: string } | { type: "report"; key: string };

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

const RUN_PARTS = { lineage: LineageRow, prompt: PromptRow, report: ReportRow, error: ErrorRow } as const;

/** The view's own rows (lineage, prompt, report, error): only these and the head follow the run's record. */
function RunPart({ part, threadId, runId }: { part: keyof typeof RUN_PARTS; threadId: string; runId: string }) {
  const run = useAgentRun(threadId, runId);
  if (!run) return null;
  const Part = RUN_PARTS[part];
  return <Part threadId={threadId} run={run} />;
}

/** The turn header's row, on the run's record like the others. */
function RunHead({ row, threadId, runId }: { row: Extract<SubRow, { type: "head" }>; threadId: string; runId: string }) {
  const run = useAgentRun(threadId, runId);
  return run ? <HeadRow threadId={threadId} run={run} folded={row.folded} foldable={row.foldable} /> : null;
}

/** One row of the view: one of its own rows, else a work row as the thread's timeline draws it. */
const SubRowView = memo(function SubRowView({ row, threadId, runId }: { row: SubRow; threadId: string; runId: string }) {
  switch (row.type) {
    case "lineage":
    case "prompt":
    case "report":
    case "error":
      return <RunPart part={row.type} threadId={threadId} runId={runId} />;
    case "head":
      return <RunHead row={row} threadId={threadId} runId={runId} />;
    default:
      return <WorkNodeView node={row} />;
  }
});

/**
 * The run's transcript as a list, one turn of a thread: the lineage note, the prompt, the
 * turn header, its work (the items whose parent is its Agent call; structural keys only, so
 * a progress tick or a text delta does not rebuild it), why it failed and its report. A
 * finished run folds its work like a finished turn: what it answered stays.
 */
function SubagentList({ threadId, runId, toolUseId, status, bottomInset, pinnedLayer }: { threadId: string; runId: string; toolUseId: string; status: AgentRunView["status"]; bottomInset: number; pinnedLayer: ReactNode }) {
  const keys = useRunTimelineKeys(threadId, toolUseId);
  const nodes = useMemo(() => runNodes(keys.map(decodeTimelineKey)), [keys]);
  const report = useReportShown(threadId, runId, lastTextId(nodes));
  const failure = useThreadStore((s) => (s.logs[threadId]?.agents.find((r) => r.id === runId)?.error ?? "") !== "") && status === "failed";
  const folded = runFolded(status, useTurnFolds(threadId)[runFoldKey(runId)]);
  const rows = useMemo<SubRow[]>(() => {
    const foldable = shownNodes(nodes, true, report).length < nodes.length;
    return [
      { type: "lineage", key: "sub:lineage" },
      { type: "prompt", key: "sub:prompt" },
      { type: "head", key: HEAD_KEY, folded, foldable },
      ...shownNodes(nodes, folded, report),
      ...(failure ? [{ type: "error" as const, key: "sub:error" }] : []),
      ...(report ? [{ type: "report" as const, key: "sub:report" }] : []),
    ];
  }, [nodes, report, failure, folded]);
  const render = useMemo(() => (row: SubRow) => <SubRowView row={row} threadId={threadId} runId={runId} />, [threadId, runId]);
  return <TimelineList threadId={threadId} rows={rows} bottomInset={bottomInset} renderRow={render} estimateRow={estimateSubRow} pinnedLayer={pinnedLayer} />;
}

/** The dock's composer stand-in, on the run's record (its own subscription: a progress tick stays here). */
function RunComposer({ threadId, runId }: { threadId: string; runId: string }) {
  const parent = useParentName(threadId);
  const run = useAgentRun(threadId, runId);
  const model = useRunModel(threadId, run?.model ?? "");
  return <SubagentComposer status={run?.status ?? "unknown"} parent={parent} model={model} effort={run?.effort ?? ""} agentType={run?.agentType ?? ""} />;
}

/**
 * The read-only subagent view (stores/subagentView.ts): one of the selected thread's own
 * subagent runs drawn as a thread (docs/notes/subagent-as-thread.md), in the content pane
 * while the thread stays selected (its Watch feeds both). A thread's header, card and
 * composer card, each without what acts on the thread: the crumb and the composer's button
 * go back up, as does Escape (thread.agent.up) while the keyboard is in the view. The view
 * takes the keyboard when a run opens, and whenever something asks for the prompt it does
 * not have, so Escape keeps working.
 */
export function SubagentPane({ threadId, runId }: { threadId: string; runId: string }) {
  // Narrow: the pane re-renders when the run appears or ends, not on its progress.
  const toolUseId = useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.id === runId)?.toolUseId ?? null);
  const status = useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.id === runId)?.status ?? "unknown");
  const loaded = useThreadLoaded(threadId);
  const cwd = useThreadsStore((s) => s.byId[threadId]?.worktreePath ?? "");
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const [dockRef, dockHeight] = useElementHeight();
  const rootRef = useRef<HTMLElement>(null);
  const focusSeq = useSubagentViewStore((s) => s.focusSeq);
  const promptAsked = useUiStore((s) => s.promptFocusSeq + s.contentFocusSeq);
  const infoOpen = useThreadInfoOpen(threadId);
  const [rowRef, infoFits] = useInfoRoom(threadId);
  // A run that opens takes the keyboard (Escape goes back up), unless the palette has it.
  useEffect(() => {
    if (useUiStore.getState().palette.open) return;
    rootRef.current?.focus({ preventScroll: true });
  }, [focusSeq, promptAsked, runId]);
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
        <PaneHeader className="gap-2 px-3" data-testid="subagent-header">
          <RunTitle threadId={threadId} runId={runId} />
          <span className="ml-auto flex shrink-0 items-center gap-2 pl-2 text-cf-text-muted tabular-nums">
            <HeaderActions />
          </span>
        </PaneHeader>
        <div className="relative flex min-h-0 flex-1" ref={rowRef} data-testid="subagent-body">
          {/* As a thread's body (ThreadPane): the card lays over this column's right side, inside the list's scroller. */}
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" style={{ "--ti-inset": infoOpen && infoFits ? "var(--ti-card)" : "0px" } as CSSProperties}>
            {/* A run's own modal scope: the thread's page modal stays with the thread's body. */}
            <PaneOverlay scope={`${threadId}/${runId}`} threadId={threadId}>
              {!loaded && <p className="absolute top-10 right-(--ti-inset) left-0 text-center text-body text-cf-text-muted">Loading the conversation…</p>}
              {toolUseId !== null && (
                <SubagentList
                  threadId={threadId}
                  runId={runId}
                  toolUseId={toolUseId}
                  status={status}
                  bottomInset={dockHeight}
                  pinnedLayer={infoOpen && infoFits ? <ThreadInfoCard threadId={threadId} runId={runId} /> : undefined}
                />
              )}
              <div className="dock" ref={dockRef}>
                <RunComposer threadId={threadId} runId={runId} />
              </div>
            </PaneOverlay>
          </div>
          {!infoFits && <ThreadInfoOverlay threadId={threadId} runId={runId} />}
        </div>
      </section>
    </ThreadContext.Provider>
  );
}
