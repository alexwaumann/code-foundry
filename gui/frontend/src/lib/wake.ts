/**
 * A wake message (docs/notes/agents-4-wake.md) as the timeline's one-line "Woken by …"
 * note (docs/notes/agents-3-lineage-gui.md): who woke the thread, how it ended, a summary,
 * from the payload the daemon sent with it. A batch of thread wakes sent as one message
 * (`{"kind": "batch", "wakes": [...]}`, docs/notes/orch-wakes-content.md) is one line per
 * wake. A daemon restart's notice (`{"kind": "restart", ...}`, alone or first in a batch,
 * docs/notes/orch-restart-wakes.md) is a line of its own. Pure.
 */
import type { WakeView } from "@/api/thread";

/** ok: finished, idle or exit 0; attention: waits on someone; fail: an error, a failed report, a non-zero exit. */
export type WakeTone = "ok" | "attention" | "fail";

export interface WakeLine {
  tone: WakeTone;
  /** The thread that woke this one ("" for an action run, or an unreadable payload). */
  threadId: string;
  /** Its name in the payload (the thread's id when unnamed then), or the action's name; "" when unknown. */
  name: string;
  /** "idle, finished", "needs attention, permission: Bash", "exit 3"; "" when unknown. */
  detail: string;
  /** The report's summary, a run's last output line, or (unreadable payload) the header line. */
  summary: string;
  /** The payload pretty-printed for the expandable body (the raw text when it does not parse). */
  json: string;
}

type Obj = Record<string, unknown>;

function obj(v: unknown): Obj | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function threadLine(t: Obj, json: string): WakeLine {
  const id = str(t.id);
  const status = str(t.status);
  const reason = str(t.status_reason);
  const report = obj(t.report);
  const failed = status === "error" || reason.startsWith("error") || str(report?.status) === "failed";
  const waits = status === "needs_attention" && reason !== "finished" && reason !== "";
  return {
    tone: failed ? "fail" : waits ? "attention" : "ok",
    threadId: id,
    name: str(t.name) || id,
    // A finished turn is idle at its prompt, as the wake's header says ("is idle: finished").
    detail: [reason === "finished" ? "idle" : status.replace(/_/g, " "), reason].filter(Boolean).join(", "),
    summary: str(report?.summary),
    json,
  };
}

function runLine(r: Obj, json: string): WakeLine {
  const code = typeof r.exit_code === "number" ? r.exit_code : null;
  const tail = str(r.output_tail)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    tone: code === 0 ? "ok" : "fail",
    threadId: "",
    name: str(r.action_name) || str(r.id),
    detail: code === null ? "" : `exit ${String(code)}`,
    summary: tail.at(-1) ?? "",
    json,
  };
}

function restartLine(p: Obj, json: string): WakeLine {
  const cut = Array.isArray(p.interrupted) ? p.interrupted.map(obj).filter((t): t is Obj => t !== null) : [];
  const self = p.own_turn_interrupted === true;
  const detail = [cut.length > 0 ? `${String(cut.length)} interrupted` : "", self ? "own turn interrupted" : ""].filter(Boolean).join(", ");
  return {
    tone: cut.length > 0 || self ? "attention" : "ok",
    threadId: "",
    name: "App restart",
    detail,
    summary: cut.map((t) => str(t.name) || str(t.id)).join(", "),
    json,
  };
}

function parse(json: string): Obj | null {
  try {
    return obj(JSON.parse(json));
  } catch {
    return null;
  }
}

/** The notes' lines for a wake message: one per wake of a batch, else one. */
export function wakeLines(w: WakeView): WakeLine[] {
  const p = parse(w.json);
  const batch = p?.kind === "batch" && Array.isArray(p.wakes) ? p.wakes.map(obj) : null;
  if (!batch || batch.length === 0 || batch.some((b) => !b)) return [lineOf(p, w)];
  return batch.map((b) => lineOf(b, w));
}

/** The note's line for a wake message (a batch's first wake). */
export function wakeLine(w: WakeView): WakeLine {
  return wakeLines(w)[0] ?? lineOf(null, w);
}

function lineOf(p: Obj | null, w: WakeView): WakeLine {
  const json = p ? JSON.stringify(p, null, 2) : w.json;
  const thread = obj(p?.thread);
  if (thread) return threadLine(thread, json);
  const run = obj(p?.run);
  if (run) return runLine(run, json);
  if (p?.kind === "restart") return restartLine(p, json);
  return { tone: "ok", threadId: "", name: "", detail: "", summary: w.title, json };
}
