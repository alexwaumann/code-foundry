import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { LoaderCircle, SquareTerminal } from "lucide-react";
import { fmtElapsed } from "@/lib/agents";
import { useNow } from "@/lib/clock";
import { runningShell, shellCount } from "@/lib/threadInfo";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { Group, Row } from "./Row";

const SEP = "\u0000";

/** One running shell: a spinner, its command in mono, its description muted, how long it has run. */
function ShellRow({ shell }: { shell: string }) {
  const [id = "", command = "", description = "", at = ""] = shell.split(SEP);
  const now = useNow(1000);
  const started = at === "" ? null : Number(at);
  return (
    <Row sub icon={<LoaderCircle className="animate-spin" />} meta={started === null ? null : fmtElapsed(now - started)} testId="ti-shell" data-shell={id}>
      <span className="text-code">{command}</span>
      {description && <span className="text-cf-text-muted"> {description}</span>}
    </Row>
  );
}

/** The thread's running background shells, read from its log (its open Watch) only while the fold is open. */
function ShellRows({ threadId }: { threadId: string }) {
  const shells = useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      if (!log) return [];
      const out: string[] = [];
      for (const id of log.order) {
        const it = log.byId[id];
        const sh = it ? runningShell(it) : null;
        if (sh) out.push([sh.id, sh.command, sh.description, sh.startedAtMs === null ? "" : String(sh.startedAtMs)].join(SEP));
      }
      return out;
    }),
  );
  return (
    <>
      {shells.map((s) => (
        <ShellRow key={s.split(SEP)[0]} shell={s} />
      ))}
    </>
  );
}

/**
 * The thread's own background shells (Bash run_in_background, Monitor) while any runs:
 * "N shells · running", a fold with one row per shell. Not the bottom panel's terminals.
 */
export function ShellsGroup({ threadId }: { threadId: string }) {
  const count = useThreadsStore((s) => {
    const t = s.byId[threadId];
    return t && t.archivedAtMs === null ? t.backgroundShellsRunning : 0;
  });
  const [open, setOpen] = useState(false);
  if (count === 0) return null;
  return (
    <Group testId="ti-shells-group">
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
        {shellCount(count)}
      </Row>
      {open && <ShellRows threadId={threadId} />}
    </Group>
  );
}
