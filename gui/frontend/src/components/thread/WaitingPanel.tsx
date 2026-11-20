import { useState, type ReactNode } from "react";
import { Bot, Clock, GitPullRequest, MessagesSquare, Play, Plug, SquareTerminal, X, type LucideIcon } from "lucide-react";
import type { BackgroundShellView } from "@/api/threads";
import type { WakeKind, WakeSubscriptionView } from "@/api/wakes";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { agentName } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { waitTotal } from "@/lib/composerPill";
import { orderWakes, shellName, threadTargetStatus, waitCounts, wakeCondition, wakeName, wakeStatus, wakeTip } from "@/lib/waitList";
import { useAgentRun, useStripRunIds } from "@/stores/agents";
import { openAgentRun, useCanOpenAgents } from "@/stores/subagentActions";
import { stopShell } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";
import { removeWake, useWaitListCurrent, useWaitShells, useWakes } from "@/stores/waitList";
import { useStopWaiting } from "./pillData";

const ICON = "size-3.5 shrink-0 text-cf-text-muted";
const ROW = "flex min-h-8 min-w-0 items-center gap-2.5 border-t border-cf-border py-1 pr-2 pl-3";
const NAME = "min-w-0 flex-1 truncate";
const STATUS = "max-w-1/2 shrink-0 truncate text-cf-text-muted";

const kindIcons: Readonly<Record<WakeKind, LucideIcon>> = {
  thread: MessagesSquare,
  pullRequest: GitPullRequest,
  actionRun: Play,
  plugin: Plug,
  timer: Clock,
};

/**
 * A row's name, truncated, with what the row does not show: its reason when it has one
 * (wakeTip), else the whole name once it is cut short.
 */
function RowName({ name, tip, children }: { name: string; tip: string; children?: ReactNode }) {
  return (
    <Tip label={tip || name} whenTruncated={!tip}>
      <span className={NAME} data-testid="waiting-row-name">
        {children ?? name}
      </span>
    </Tip>
  );
}

/** The × of a subscription row. It holds after a press: the row leaves when the list says so, and a failure toasts. */
function RemoveButton({ threadId, wake }: { threadId: string; wake: WakeSubscriptionView }) {
  const [pending, setPending] = useState(false);
  // Not before the Watch has said the row is still there (a list kept from an earlier visit).
  const current = useWaitListCurrent(threadId);
  return (
    <Tip label="Stop waiting for this">
      <Button
        variant="ghost"
        size="icon-xs"
        className="text-cf-text-muted"
        aria-label={`Stop listening for ${wakeName(wake)}`}
        disabled={pending || !current}
        data-testid="waiting-remove"
        onClick={() => {
          setPending(true);
          void removeWake(threadId, wake.id).then(() => {
            setPending(false);
          });
        }}
      >
        <X />
      </Button>
    </Tip>
  );
}

/** A thread target's status, live from the thread list; the daemon's words once the thread is gone from it. */
function ThreadStatus({ wake }: { wake: WakeSubscriptionView }) {
  const now = useNow(60_000);
  const status = useThreadsStore((s) => threadTargetStatus(s.byId[wake.targetId], now));
  return (
    <span className={STATUS} data-testid="waiting-row-status">
      {status ?? wake.targetStatus}
    </span>
  );
}

/** One subscription: its icon, its name (the target's, a timer's reason), its live status, an ×. */
function WakeRow({ threadId, wake, wakes }: { threadId: string; wake: WakeSubscriptionView; wakes: readonly WakeSubscriptionView[] }) {
  const Icon = kindIcons[wake.kind];
  const condition = wakeCondition(wakes, wake);
  const threadName = useThreadsStore((s) => (wake.kind === "thread" ? s.byId[wake.targetId]?.name : undefined));
  const name = threadName || wakeName(wake);
  return (
    <li className={ROW} data-testid="waiting-row" data-kind={wake.kind} data-wake={wake.id}>
      <Icon className={ICON} aria-hidden />
      <RowName name={name} tip={wakeTip(wake)}>
        {name}
        {condition && <span className="text-cf-text-muted"> · {condition}</span>}
      </RowName>
      {wake.kind === "thread" ? (
        <ThreadStatus wake={wake} />
      ) : (
        <span className={STATUS} data-testid="waiting-row-status">
          {wakeStatus(wake)}
        </span>
      )}
      <RemoveButton threadId={threadId} wake={wake} />
    </li>
  );
}

/** One background shell: Stop ends it (thread.shell.stop) and holds until the shell goes. */
function ShellRow({ threadId, shell }: { threadId: string; shell: BackgroundShellView }) {
  const [stopping, setStopping] = useState(false);
  const name = shellName(shell);
  return (
    <li className={ROW} data-testid="waiting-row" data-kind="shell" data-wake={shell.taskId}>
      <SquareTerminal className={ICON} aria-hidden />
      <RowName name={name} tip="" />
      <span className={STATUS} data-testid="waiting-row-status">
        {stopping ? "stopping" : "running"}
      </span>
      <Button
        variant="ghost"
        size="xs"
        className="text-cf-error-text"
        disabled={stopping}
        data-testid="waiting-stop-shell"
        onClick={() => {
          setStopping(true);
          void stopShell(threadId, shell.taskId).then((ok) => {
            if (!ok) setStopping(false);
          });
        }}
      >
        Stop
      </Button>
    </li>
  );
}

/**
 * One running background subagent: its name, the link into the read-only subagent view
 * (plain text where the command is not listed), and its activity. No action: nothing can
 * stop one run, so it says so.
 */
function SubagentRow({ threadId, id }: { threadId: string; id: string }) {
  const run = useAgentRun(threadId, id);
  const can = useCanOpenAgents();
  if (!run) return null;
  const name = agentName(run);
  return (
    <li className={ROW} data-testid="waiting-row" data-kind="subagent" data-wake={id}>
      <Bot className={ICON} aria-hidden />
      <RowName name={name} tip="">
        {can ? (
          <button
            type="button"
            className="cursor-default decoration-dotted underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
            data-testid="waiting-subagent-name"
            onClick={() => {
              void openAgentRun(threadId, id);
            }}
          >
            {name}
          </button>
        ) : (
          name
        )}
      </RowName>
      <span className={STATUS} data-testid="waiting-row-status">
        {run.activity || "running"}
      </span>
      <span className="shrink-0 text-caption text-cf-text-muted">runs to its end</span>
    </li>
  );
}

/**
 * The waiting segment's panel, opened upward from the pill (ComposerRow): "Waiting on N" and
 * "Stop waiting on all" in its header (left out with only subagents, which nothing can stop),
 * then a row per thing with its live status and its own stop control.
 */
export function WaitingPanel({ threadId }: { threadId: string }) {
  const wakes = useWakes(threadId);
  const shells = useWaitShells(threadId);
  const runs = useStripRunIds(threadId);
  const { stop, disabled } = useStopWaiting(threadId);
  const total = waitTotal(waitCounts(wakes, shells.length, runs.length));
  return (
    <div className="text-body-sm" data-testid="waiting-panel">
      <div className="flex min-h-9 items-center gap-2 py-1 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-medium" data-testid="waiting-panel-title">
          Waiting on {total}
        </span>
        {wakes.length + shells.length > 0 && (
          <Button variant="outline" size="xs" disabled={disabled} data-testid="waiting-stop-all" onClick={stop}>
            Stop waiting on all
          </Button>
        )}
      </div>
      <ul className="max-h-64 overflow-y-auto" data-testid="waiting-rows">
        {orderWakes(wakes).map((w) => (
          <WakeRow key={w.id} threadId={threadId} wake={w} wakes={wakes} />
        ))}
        {shells.map((sh) => (
          <ShellRow key={sh.taskId} threadId={threadId} shell={sh} />
        ))}
        {runs.map((id) => (
          <SubagentRow key={id} threadId={threadId} id={id} />
        ))}
      </ul>
    </div>
  );
}
