import { Fragment, type CSSProperties, type ReactNode } from "react";
import { Bot, ChevronRight, Clock, LoaderCircle, Wrench, Zap } from "lucide-react";
import type { AgentRunView, AgentStatusView } from "@/api/agents";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { agentElapsedMs, agentMeta, agentName, agentStatusText, agentsSubline, fmtElapsed } from "@/lib/agents";
import { fmtTok } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { useAgentCounts, useAgentLevel, useAgentRowIds, useAgentRun } from "@/stores/agents";
import { openAgentRun, useCanOpenAgents } from "@/stores/subagentActions";
import { useIsViewing } from "@/stores/subagentView";
import { useThreadsStore } from "@/stores/threads";
import { useThreadStore } from "@/stores/thread";
import { useUiStore } from "@/stores/ui";
import "./agents.css";

/** The thread this panel belongs to: the selected thread ("" otherwise). */
function useThreadId(): string {
  return useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
}

const STATUS_TONE: Readonly<Record<AgentStatusView, string>> = {
  running: "text-info",
  done: "text-success",
  failed: "text-destructive",
  unknown: "text-muted-foreground",
};

const DOT: Readonly<Record<Exclude<AgentStatusView, "running">, string>> = {
  done: "bg-success",
  failed: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

function Header({ threadId }: { threadId: string }) {
  const c = useAgentCounts(threadId);
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="agents-header">
      <h2 className="flex min-w-0 items-center gap-1.5 text-heading">
        <Bot className="size-4 shrink-0 text-info" aria-hidden />
        <span className="min-w-0 truncate">Agents</span>
        {c && c.total > 0 && (
          <span className="ml-auto shrink-0 text-caption tabular-nums" data-testid="agents-count">
            {c.running} running · {c.total} this thread
          </span>
        )}
      </h2>
      {c && c.total > 0 && (
        <span className="flex min-h-5 min-w-0 items-center gap-1.5 text-caption" data-testid="agents-subline">
          {c.background > 0 && <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden />}
          <span className="min-w-0 truncate">{agentsSubline(c)}</span>
        </span>
      )}
    </header>
  );
}

/** "Done · 5 min ago": its own component, so only ended rows tick on the shared 30 s clock. */
function EndedStatus({ run }: { run: AgentRunView }) {
  const now = useNow(30_000);
  return <>{agentStatusText(run, now)}</>;
}

/** The running time: live (1 s clock) while running, Claude's duration once ended. */
function Elapsed({ run }: { run: AgentRunView }) {
  const live = run.status === "running";
  return live ? <LiveElapsed run={run} /> : <>{fmtOrDash(agentElapsedMs(run, 0))}</>;
}

function LiveElapsed({ run }: { run: AgentRunView }) {
  const now = useNow(1000);
  return <>{fmtOrDash(agentElapsedMs(run, now))}</>;
}

function fmtOrDash(ms: number | null): string {
  return ms === null ? "—" : fmtElapsed(ms);
}

function Stat({ icon: Icon, label, children, testId }: { icon: typeof Clock; label: string; children: ReactNode; testId: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap" aria-label={label} data-testid={testId}>
      <Icon className="size-3 shrink-0" aria-hidden />
      <span aria-hidden>{children}</span>
    </span>
  );
}

/**
 * One run (L1): status and name, its meta line, what it does or did, and its stats. The
 * thread's own runs (spawn depth 1) are buttons that open the run in the read-only
 * subagent view (thread.agent.open), with a chevron after the status; the one on screen
 * has a sky bar, a sky tint and a "viewing" tag. Nested runs have nothing to open.
 */
function AgentRow({ threadId, id }: { threadId: string; id: string }) {
  const run = useAgentRun(threadId, id);
  const level = useAgentLevel(threadId, id);
  const viewing = useIsViewing(threadId, id);
  const can = useCanOpenAgents();
  if (!run) return null;
  const name = agentName(run);
  const running = run.status === "running";
  const meta = agentMeta(run);
  const openable = can && run.spawnDepth <= 1;
  // Nested runs are indented 20px per level, with a connector from their parent's column.
  const style = level > 0 ? ({ paddingLeft: 16 + 20 * level, "--nest-x": `${String(1 + 20 * level)}px` } as CSSProperties) : undefined;
  const common = cn("relative flex w-full min-w-0 flex-col gap-[3px] border-b border-pane-border px-4 pt-[9px] pb-2.5 text-left @max-[340px]:px-3", level > 0 && "cf-agents-nest");
  const data = { "data-testid": "agent-row", "data-agent": run.id, "data-status": run.status, "data-level": level, "data-background": run.background || undefined, "data-viewing": viewing || undefined };
  const body = (
    <>
      {viewing && <span className="absolute -top-px -bottom-px left-0 w-0.5 bg-info" aria-hidden />}
      <div className="flex min-w-0 items-center gap-2 text-body-sm">
        {running ? (
          <LoaderCircle className="size-3 shrink-0 animate-spin text-info" aria-label="Running" />
        ) : (
          <span className={cn("size-2 shrink-0 rounded-full", DOT[run.status as Exclude<AgentStatusView, "running">])} aria-hidden />
        )}
        <Tip label={name} whenTruncated>
          <span className={cn("min-w-0 flex-1 truncate", running || run.status === "failed" ? "font-medium" : "font-[450]")} data-testid="agent-name">
            {name}
          </span>
        </Tip>
        {viewing && (
          <span className="shrink-0 rounded-sm border border-info/50 px-1 text-caption-sm text-info" data-testid="agent-viewing">
            viewing
          </span>
        )}
        <span className={cn("shrink-0 text-caption-sm tabular-nums", STATUS_TONE[run.status])} data-testid="agent-status">
          {running || run.endedAtMs === null ? agentStatusText(run, 0) : <EndedStatus run={run} />}
        </span>
        {openable && <ChevronRight className="-mr-1 size-3.5 shrink-0 text-muted-foreground" aria-hidden data-testid="agent-open-chevron" />}
      </div>
      <div className="min-w-0 truncate pl-5 text-caption" data-testid="agent-meta">
        {meta.map((p, i) => (
          <Fragment key={`${String(i)}:${p}`}>
            {i > 0 && (
              <span className="mx-1.5 opacity-50" aria-hidden>
                ·
              </span>
            )}
            {p}
          </Fragment>
        ))}
      </div>
      {running ? (
        <div className="ml-5 flex min-w-0 items-center gap-1.5 text-body-sm" data-testid="agent-activity">
          <LoaderCircle className="size-[13px] shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <span className="cf-agents-shimmer min-w-0 truncate">{run.activity || "Starting…"}</span>
          {run.lastTool && <span className="shrink-0 text-code text-muted-foreground">{run.lastTool}</span>}
        </div>
      ) : run.status === "failed" ? (
        run.error && (
          <Tip label={run.error} whenTruncated>
            <div className="ml-5 line-clamp-2 text-body-sm break-words text-destructive" data-testid="agent-error">
              {run.error}
            </div>
          </Tip>
        )
      ) : (
        run.summary && (
          <Tip label={run.summary} whenTruncated>
            <div className="ml-5 line-clamp-2 text-caption break-words" data-testid="agent-summary">
              {run.summary}
            </div>
          </Tip>
        )
      )}
      <div className="flex min-w-0 items-center justify-end gap-3 pl-5 text-caption-sm tabular-nums" data-testid="agent-stats">
        <Stat icon={Clock} label="Elapsed" testId="agent-elapsed">
          <Elapsed run={run} />
        </Stat>
        <Stat icon={Wrench} label="Tool uses" testId="agent-tools">
          {run.toolUses}
        </Stat>
        <Stat icon={Zap} label="Tokens" testId="agent-tokens">
          {fmtTok(run.totalTokens)}
        </Stat>
      </div>
    </>
  );
  const tint = viewing && "bg-info/7 dark:bg-info/10";
  if (!openable)
    return (
      <li className={cn(common, tint)} style={style} {...data}>
        {body}
      </li>
    );
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        className={cn(common, "cursor-default outline-none hover:bg-accent/50 focus-visible:bg-accent/50", tint)}
        style={style}
        aria-current={viewing || undefined}
        onClick={() => {
          void openAgentRun(threadId, run.id);
        }}
        {...data}
      >
        {body}
      </button>
    </li>
  );
}

function Message({ testId, children }: { testId: string; children: string }) {
  return (
    <p className="px-4 py-3 text-body text-muted-foreground @max-[340px]:px-3" data-testid={testId}>
      {children}
    </p>
  );
}

/**
 * The side panel's Agents surface (docs/sketches/agents-panel variant L1,
 * docs/notes/agents-2-gui.md): the selected thread's subagent runs as one flat list in
 * spawn order (status never reorders it; nested runs under their parent), separators from
 * border to border, under a header with the counts. The thread's own runs open in the
 * read-only subagent view (AgentRow).
 */
export function AgentsSurface() {
  const threadId = useThreadId();
  const known = useThreadsStore((s) => threadId !== "" && threadId in s.byId);
  const loaded = useThreadStore((s) => threadId in s.logs);
  const ids = useAgentRowIds(threadId);
  if (!known) return <Message testId="agents-missing">Select a thread to see its agents.</Message>;
  return (
    <div className="@container flex min-w-0 flex-col" data-testid="agents-surface" data-thread={threadId}>
      <Header threadId={threadId} />
      {!loaded ? (
        <Message testId="agents-loading">Loading…</Message>
      ) : ids.length === 0 ? (
        <Message testId="agents-empty">No agents yet. Claude&apos;s subagents (the Agent tool) show here as they run.</Message>
      ) : (
        <ul className="flex min-w-0 flex-col" data-testid="agents-list">
          {ids.map((id) => (
            <AgentRow key={id} threadId={threadId} id={id} />
          ))}
        </ul>
      )}
    </div>
  );
}
