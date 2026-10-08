import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  TerminalService,
  TerminalState,
  type AttachEvent,
  type Terminal,
  type TerminalEvent,
} from "@/gen/codefoundry/v1/terminal_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type TerminalStateView = "running" | "exited" | "unknown";

/** View model for a terminal. Generated types stay inside src/api. */
export interface TerminalView {
  id: string;
  argv: string[];
  cwd: string;
  cols: number;
  rows: number;
  title: string;
  state: TerminalStateView;
  exitCode: number;
  startedAtMs: number | null;
  exitedAtMs: number | null;
  altScreen: boolean;
  labels: Readonly<Record<string, string>>;
}

export type TerminalEventView = { kind: "updated"; terminal: TerminalView } | { kind: "removed"; id: string };

export type AttachEventView =
  | { kind: "snapshot"; data: Uint8Array; cols: number; rows: number; altScreen: boolean }
  | { kind: "output"; data: Uint8Array }
  | { kind: "resized"; cols: number; rows: number }
  | { kind: "exited"; exitCode: number };

const stateMap: Record<TerminalState, TerminalStateView> = {
  [TerminalState.UNSPECIFIED]: "unknown",
  [TerminalState.RUNNING]: "running",
  [TerminalState.EXITED]: "exited",
};

export function toTerminalView(t: Terminal): TerminalView {
  return {
    id: t.id,
    argv: [...t.argv],
    cwd: t.cwd,
    cols: t.cols,
    rows: t.rows,
    title: t.title,
    state: stateMap[t.state],
    exitCode: t.exitCode,
    startedAtMs: t.startedAt ? timestampMs(t.startedAt) : null,
    exitedAtMs: t.exitedAt ? timestampMs(t.exitedAt) : null,
    altScreen: t.altScreen,
    labels: { ...t.labels },
  };
}

export function toTerminalEventView(ev: TerminalEvent): TerminalEventView | null {
  switch (ev.event.case) {
    case "updated":
      return { kind: "updated", terminal: toTerminalView(ev.event.value) };
    case "removedId":
      return { kind: "removed", id: ev.event.value };
    default:
      return null;
  }
}

export function toAttachEventView(ev: AttachEvent): AttachEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", data: e.value.data, cols: e.value.cols, rows: e.value.rows, altScreen: e.value.altScreen };
    case "output":
      return { kind: "output", data: e.value.data };
    case "resized":
      return { kind: "resized", cols: e.value.cols, rows: e.value.rows };
    case "exited":
      return { kind: "exited", exitCode: e.value.exitCode };
    default:
      return null;
  }
}

export async function listTerminals(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<TerminalView[]> {
  const c = await conn.client(TerminalService);
  const res = await c.list({}, { signal });
  return res.terminals.map(toTerminalView);
}

export async function* watchTerminals(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<TerminalEventView> {
  const c = await conn.client(TerminalService);
  for await (const ev of c.watch({}, { signal })) {
    const v = toTerminalEventView(ev);
    if (v) yield v;
  }
}

export async function* attachTerminal(
  id: string,
  signal: AbortSignal,
  conn: DaemonConnection = daemon,
): AsyncGenerator<AttachEventView> {
  const c = await conn.client(TerminalService);
  for await (const ev of c.attach({ id }, { signal })) {
    const v = toAttachEventView(ev);
    if (v) yield v;
  }
}

export async function writeTerminal(id: string, data: Uint8Array, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(TerminalService);
  await c.write({ id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number, conn: DaemonConnection = daemon): Promise<void> {
  const c = await conn.client(TerminalService);
  await c.resize({ id, cols, rows });
}
