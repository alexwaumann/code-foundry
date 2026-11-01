import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Globe, LoaderCircle, Square, SquareTerminal } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import type { BackgroundShellView } from "@/api/threads";
import { fmtElapsed } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { serverAddress, shellCount, shellRuntime } from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { stopShell } from "@/stores/threadActions";
import { holdOnce, pendingKey, releasePending, useCardPending } from "@/stores/threadInfo";
import { useThreadsStore } from "@/stores/threads";
import { Group, HOVER_CARD, Row, SubLine } from "./Row";

/**
 * The thread's running background shells, encoded so a thread update that leaves them
 * alone re-renders nothing. An archived thread has none.
 */
function useShells(threadId: string): readonly string[] {
  return useThreadsStore(
    useShallow((s) => {
      const t = s.byId[threadId];
      return t && t.archivedAtMs === null ? t.backgroundShells.map((b) => JSON.stringify(b)) : [];
    }),
  );
}

const decode = (s: string) => JSON.parse(s) as BackgroundShellView;

/** How long the shell has run, ticking; "" when its start is unknown. */
function Uptime({ startedAtMs }: { startedAtMs: number | null }) {
  const now = useNow(1000);
  return startedAtMs === null ? null : <span className="shrink-0 tabular-nums">{fmtElapsed(now - startedAtMs)}</span>;
}

/** One running shell in the fold: a spinner, its command in mono, its description muted, how long it has run. */
function ShellRow({ shell }: { shell: BackgroundShellView }) {
  return (
    <Row sub icon={<LoaderCircle className="animate-spin" />} meta={<Uptime startedAtMs={shell.startedAtMs} />} testId="ti-shell" data-shell={shell.taskId}>
      <span className="text-code">{shell.command}</span>
      {shell.description && <span className="text-cf-text-muted"> {shell.description}</span>}
    </Row>
  );
}

/**
 * A shell that listens on a port: localhost:<port> (its first; the hover card lists them
 * all), then its command, runtime and uptime. A click opens the port in the browser. On
 * hover (or while it has the keyboard) a stop square stops the shell: the row's sibling
 * laid over the value column, like the lineage group's, so Enter on it stops and does
 * not open.
 */
function ServerRow({ threadId, shell }: { threadId: string; shell: BackgroundShellView }) {
  const [first = 0, ...rest] = shell.ports;
  // A stop holds the square until the shell leaves the list (the row unmounts): a second
  // press sends nothing.
  const key = pendingKey(threadId, `shell:${shell.taskId}`);
  const stopping = useCardPending(key);
  useEffect(
    () => () => {
      releasePending(key);
    },
    [key],
  );
  const runtime = shellRuntime(shell.command);
  const card = (
    <div className={cn(HOVER_CARD, "flex flex-col gap-0.5")}>
      {shell.ports.map((p) => (
        <div key={p} className="text-code">
          {serverAddress(p)}
        </div>
      ))}
      {shell.description && <div className="font-medium">{shell.description}</div>}
      <div className="text-code break-all text-cf-text-muted">{shell.command}</div>
    </div>
  );
  return (
    <div className="group/srv relative flex flex-col">
      <Tip label={card} side="left">
        <Row
          tall
          icon={<Globe />}
          meta={rest.length > 0 ? <span className="text-cf-text-muted group-focus-within/srv:invisible group-hover/srv:invisible">+{rest.length}</span> : null}
          onActivate={() => void openUrl(`http://${serverAddress(first)}`)}
          testId="ti-server"
          data-task={shell.taskId}
          data-port={first}
        >
          <span className="truncate text-code">{serverAddress(first)}</span>
          <SubLine className="text-cf-text-muted" testId="ti-server-line">
            <span className="min-w-0 truncate">{shell.command}</span>
            {runtime && <span className="shrink-0">· {runtime}</span>}
            {shell.startedAtMs !== null && (
              <span className="shrink-0">
                · <Uptime startedAtMs={shell.startedAtMs} />
              </span>
            )}
          </SubLine>
        </Row>
      </Tip>
      <Tip label="Stop this server" side="left">
        <button
          type="button"
          aria-label={`Stop ${serverAddress(first)}`}
          aria-disabled={stopping}
          className="absolute top-1/2 right-1 flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-cf-error-text opacity-0 group-hover/srv:opacity-100 hover:bg-cf-text/10 focus-visible:opacity-100 aria-disabled:opacity-50 aria-disabled:hover:bg-transparent [&_svg]:size-3 [&_svg]:fill-current"
          data-testid="ti-server-stop"
          data-task={shell.taskId}
          onClick={(e) => {
            e.stopPropagation();
            void holdOnce(key, () => stopShell(threadId, shell.taskId));
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
          }}
        >
          <Square aria-hidden />
        </button>
      </Tip>
    </div>
  );
}

/**
 * The thread's own background shells (Bash run_in_background, Monitor) while any runs
 * (docs/notes/thread-servers.md). A shell listening on a port is a server row; the others
 * fold under "N shells · running" ("N more shells" below servers). Not the bottom panel's
 * terminals.
 */
export function ShellsGroup({ threadId }: { threadId: string }) {
  const encoded = useShells(threadId);
  const [open, setOpen] = useState(false);
  if (encoded.length === 0) return null;
  const shells = encoded.map(decode);
  const servers = shells.filter((s) => s.ports.length > 0);
  const others = shells.filter((s) => s.ports.length === 0);
  return (
    <Group testId="ti-shells-group">
      {servers.map((s) => (
        <ServerRow key={s.taskId} threadId={threadId} shell={s} />
      ))}
      {others.length > 0 && (
        <Row
          icon={<SquareTerminal />}
          meta="running"
          chevron={open ? "open" : "closed"}
          onActivate={() => {
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          testId="ti-shells"
        >
          {shellCount(others.length, servers.length > 0)}
        </Row>
      )}
      {open && others.map((s) => <ShellRow key={s.taskId} shell={s} />)}
    </Group>
  );
}
