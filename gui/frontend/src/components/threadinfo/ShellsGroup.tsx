import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ExternalLink, Globe, LoaderCircle, Square, SquareTerminal } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import type { BackgroundShellView } from "@/api/threads";
import { useNow } from "@/lib/clock";
import { formatDuration } from "@/lib/duration";
import { serverSourceWords, type ServerSource } from "@/lib/servers";
import { serverAddress, shellCount } from "@/lib/threadInfo";
import { cn } from "@/lib/utils";
import { openServer, openServerInBrowser, stopServer, useServerRows } from "@/stores/servers";
import { holdOnce, pendingKey, releasePending, useCardPending } from "@/stores/threadInfo";
import { useThreadsStore } from "@/stores/threads";
import { Group, HOVER_CARD, Row, SubLine } from "./Row";

/**
 * The thread's running background shells that listen on nothing, encoded so a thread update
 * that leaves them alone re-renders nothing. An archived thread has none.
 */
function useOtherShells(threadId: string): readonly string[] {
  return useThreadsStore(
    useShallow((s) => {
      const t = s.byId[threadId];
      return t && t.archivedAtMs === null ? t.backgroundShells.filter((b) => b.ports.length === 0).map((b) => JSON.stringify(b)) : [];
    }),
  );
}

const decode = (s: string) => JSON.parse(s) as BackgroundShellView;

/** A hover button over a server row's end. */
const ROW_BUTTON = "flex size-5 items-center justify-center rounded-sm outline-none hover:bg-cf-text/10 focus-visible:bg-cf-text/10 [&_svg]:size-3";

/** How long the shell has run, ticking; "" when its start is unknown. */
function Uptime({ startedAtMs }: { startedAtMs: number | null }) {
  const now = useNow(1000);
  return startedAtMs === null ? null : <span className="shrink-0 tabular-nums">{formatDuration(now - startedAtMs, { hours: true, minutes: true, seconds: true })}</span>;
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
 * A server (lib/servers): localhost:<port> (its first; the hover card lists them all), then
 * its command, where it comes from (the action, the thread below this one that owns it) and
 * its uptime. A click shows its terminal in a tab (a terminal run) or
 * opens the port in the browser. On hover (or while it has the keyboard) two buttons show
 * over the row's end: open in the browser, and stop. They are the row's siblings, like the
 * lineage group's, so Enter on one does not press the row. Stop names what it stops, the
 * shell or the run: a process that left it can outlive it and keep the port.
 */
function ServerRow({ threadId, server }: { threadId: string; server: ServerSource }) {
  const { ports, ownerId, taskId, runId, command, description, actionName, startedAtMs } = server;
  const [first = 0, ...rest] = ports;
  const address = serverAddress(first);
  const ownerName = useThreadsStore((s) => (ownerId === threadId ? "" : s.byId[ownerId]?.name || ownerId));
  const source = serverSourceWords(actionName, ownerName);
  // A stop holds the square until the shell or run ends (the row unmounts): a second press
  // sends nothing.
  const key = pendingKey(ownerId, server.key);
  const stopping = useCardPending(key);
  useEffect(
    () => () => {
      releasePending(key);
    },
    [key],
  );
  const what = taskId ? "shell" : "action";
  const card = (
    <div className={cn(HOVER_CARD, "flex flex-col gap-0.5")}>
      {ports.map((p) => (
        <div key={p} className="text-code">
          {serverAddress(p)}
        </div>
      ))}
      {description && <div className="font-medium">{description}</div>}
      <div className="text-code break-all text-cf-text-muted">{command}</div>
      {ownerName && <div className="text-cf-text-muted">{ownerName}</div>}
    </div>
  );
  return (
    <div className="group/srv relative flex flex-col">
      <Tip label={card} side="left">
        <Row
          tall
          icon={<Globe />}
          meta={rest.length > 0 ? <span className="text-cf-text-muted group-hover/srv:invisible group-has-focus-visible/srv:invisible">+{rest.length}</span> : null}
          onActivate={() => {
            openServer(server);
          }}
          className="group-hover/srv:pr-12 group-has-focus-visible/srv:pr-12"
          testId="ti-server"
          data-task={taskId || undefined}
          data-run={runId || undefined}
          data-owner={ownerId}
          data-port={first}
        >
          <span className="truncate text-code">{address}</span>
          <SubLine className="text-cf-text-muted" testId="ti-server-line">
            <span className="min-w-0 truncate">{command}</span>
            {source && <span className="min-w-16 shrink-[10000] truncate" data-testid="ti-server-source">· {source}</span>}
            {startedAtMs !== null && (
              <span className="shrink-0">
                · <Uptime startedAtMs={startedAtMs} />
              </span>
            )}
          </SubLine>
        </Row>
      </Tip>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 opacity-0 group-hover/srv:opacity-100 group-has-focus-visible/srv:opacity-100">
        <Tip label="Open in browser" side="left">
          <button
            type="button"
            tabIndex={0}
            aria-label={`Open ${address} in the browser`}
            className={cn(ROW_BUTTON, "text-cf-text-muted hover:text-cf-text")}
            data-testid="ti-server-open"
            onClick={() => {
              openServerInBrowser(server);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
            }}
          >
            <ExternalLink aria-hidden />
          </button>
        </Tip>
        <Tip label={`Stop ${what}`} side="left">
          <button
            type="button"
            tabIndex={0}
            aria-label={`Stop the ${what} on ${address}`}
            aria-disabled={stopping}
            className={cn(ROW_BUTTON, "text-cf-error-text aria-disabled:opacity-50 aria-disabled:hover:bg-transparent [&_svg]:fill-current")}
            data-testid="ti-server-stop"
            data-task={taskId || undefined}
            data-run={runId || undefined}
            onClick={() => {
              void holdOnce(key, () => stopServer(server));
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
            }}
          >
            <Square aria-hidden />
          </button>
        </Tip>
      </div>
    </div>
  );
}

/**
 * What runs beside the thread: one flat list of servers, the thread's own and those of every
 * thread below it, background shells and action runs alike (docs/notes/server-rollup.md,
 * docs/notes/thread-servers.md), then this thread's shells that listen on nothing, folded
 * under "N shells · running" ("N more shells" below servers). The fold stays this thread's: a
 * child's other shells are its own card's. Not the terminal tabs' terminals.
 */
export function ShellsGroup({ threadId }: { threadId: string }) {
  const encoded = useOtherShells(threadId);
  const servers = useServerRows(threadId);
  const [open, setOpen] = useState(false);
  if (encoded.length === 0 && servers.length === 0) return null;
  const others = encoded.map(decode);
  return (
    <Group testId="ti-shells-group">
      {servers.map((s) => (
        <ServerRow key={s.key} threadId={threadId} server={s} />
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
