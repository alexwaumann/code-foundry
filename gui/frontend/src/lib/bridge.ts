/**
 * The page↔host message contract of the bridge (docs/notes/bridge-2-gui.md): what a page
 * shown in a thread posts to its parent through `/cf/bridge.js`, and what the host
 * (lib/bridgeHost.ts) posts back. Parsing, arg filling and the reply shapes; pure.
 *
 * Page → host (every message carries `cf: 1`):
 * - `{ type: "cf:run", id, verb, args }`, args an object of strings
 * - `{ type: "cf:on", id, source }`, `{ type: "cf:off", id }`
 * - `{ type: "cf:hello" }`
 * - `{ type: "cf:store", id, key, value }`, value a JSON text or null to remove
 *   (docs/notes/bridge-fix-storage.md)
 * - `{ type: "cf:cancel", id }`: the page gave up on a run (its timeout)
 * (`cf:resize` and `cf:theme:ack` predate the bridge: components/files/previewGrant.ts.)
 *
 * Host → page:
 * - `{ type: "cf:ready", cf: 1, thread: { id, name } | null, theme, readOnly, sources, storage }`
 * - `{ type: "cf:result", id, ok: true, result: { text, json } }`, or
 *   `{ type: "cf:result", id, ok: false, error: { code, message } }`
 * - `{ type: "cf:event", id, source, event }`
 * - `{ type: "cf:pending", id, reason: "confirm" }`: the run waits on the user (its confirm
 *   dialog is open or queued), so the page stops its clock; `{ type: "cf:resume", id }`
 *   once answered yes
 * - `{ type: "cf:storage", values }`: the thread's whole page storage, after another frame
 *   of the thread wrote or a write was refused
 */
import type { ArgSpecView } from "@/api/command";
import type { PublishedTheme } from "@/api/ui";

/** The sources a page may subscribe to with `cf:on`, named as the page names them. */
export const BRIDGE_SOURCES = ["thread-list", "thread", "gh", "action", "plugin", "terminal", "project", "workspace", "settings", "update", "ui", "ember"] as const;
export type BridgeSource = (typeof BRIDGE_SOURCES)[number];

export function isBridgeSource(s: string): s is BridgeSource {
  return (BRIDGE_SOURCES as readonly string[]).includes(s);
}

/**
 * Why a call failed, as the page sees it. `gesture` and `timeout` are the page script's
 * own (a mutation without a click; no answer in time); the host sends the rest.
 */
export type BridgeErrorCode = "gesture" | "declined" | "unavailable" | "invalid" | "failed" | "timeout";

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
}

/** A call's id as the page chose it, echoed back as is. */
export type CallId = string | number;

/** A page message the host acts on; `bad` is one with an id whose rest does not parse (answered `invalid`). */
export type PageMessage =
  | { kind: "run"; id: CallId; verb: string; args: Record<string, string> }
  | { kind: "on"; id: CallId; source: string }
  | { kind: "off"; id: CallId }
  | { kind: "hello" }
  | { kind: "store"; id: CallId; key: string; value: string | null }
  | { kind: "cancel"; id: CallId }
  | { kind: "bad"; id: CallId; call: string; message: string };

function callId(v: unknown): CallId | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** A bridge message from a page, or null for anything else (cf:resize, cf:theme:ack and stray messages included). */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.cf !== 1 || typeof m.type !== "string") return null;
  if (m.type === "cf:hello") return { kind: "hello" };
  if (m.type !== "cf:run" && m.type !== "cf:on" && m.type !== "cf:off" && m.type !== "cf:store" && m.type !== "cf:cancel") return null;
  const id = callId(m.id);
  if (id === null) return null;
  if (m.type === "cf:off") return { kind: "off", id };
  if (m.type === "cf:cancel") return { kind: "cancel", id };
  if (m.type === "cf:store") {
    if (typeof m.key !== "string" || m.key === "") return { kind: "bad", id, call: "cf.storage", message: "cf:store needs a key" };
    if (m.value !== null && typeof m.value !== "string") return { kind: "bad", id, call: "cf.storage", message: "cf:store value must be JSON text or null" };
    return { kind: "store", id, key: m.key, value: m.value };
  }
  if (m.type === "cf:on") {
    if (typeof m.source !== "string" || m.source === "") return { kind: "bad", id, call: "cf.on", message: "cf:on needs a source" };
    return { kind: "on", id, source: m.source };
  }
  if (typeof m.verb !== "string" || m.verb.trim() === "") return { kind: "bad", id, call: "cf.run", message: "cf:run needs a verb" };
  const verb = m.verb.trim();
  const raw: unknown = m.args ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "bad", id, call: verb, message: "cf:run args must be an object of strings" };
  const args: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return { kind: "bad", id, call: verb, message: `cf:run arg ${k} must be a string` };
    args[k] = v;
  }
  return { kind: "run", id, verb, args };
}

/** Where a page's calls run: its thread, and the checkout that thread works in (its cwd). */
export interface PagePlace {
  threadId: string;
  /** The thread's worktree path ($HOME for a thread without a project); "" when unknown. */
  cwd: string;
}

/** The arg a verb that starts a thread moves every window with (`--focus`, default true). */
const FOCUS_ARG = "focus";

/**
 * The args the CLI inside the thread would send, for every arg the page did not pass:
 * - one that defaults to `$CODE_FOUNDRY_THREAD` (ArgSpec.default_to_thread_env) gets the
 *   thread's id;
 * - one that defaults to the CLI's working directory (default_to_cwd) gets the thread's
 *   checkout, where its CLI runs;
 * - and one deviation: a verb whose `focus` defaults to true (one that starts a thread and
 *   moves every window to it) gets "false", so a page never takes the user's view, nor
 *   unmounts itself mid-handler, unless it passes `focus: true` (docs/notes/bridge-fix-c-gui.md).
 * An explicit "" stays, as `--flag=` opts out on the CLI.
 */
export function fillPageArgs(args: Readonly<Record<string, string>>, specs: readonly ArgSpecView[], place: PagePlace): Record<string, string> {
  const out = { ...args };
  for (const a of specs) {
    if (a.name in out) continue;
    if (a.defaultToThreadEnv) out[a.name] = place.threadId;
    else if (a.defaultToCwd && place.cwd) out[a.name] = place.cwd;
    else if (a.name === FOCUS_ARG && a.type === "bool" && a.defaultValue === "true") out[a.name] = "false";
  }
  return out;
}

/** A command's structured result (InvokeCommandResponse.result_json) parsed; null when it has none or it is not JSON. */
export function resultJson(s: string): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
}

/** A value as plain JSON (what a page gets): dates become strings, undefined fields go. */
export function jsonSafe(v: unknown): unknown {
  return v === undefined ? null : (JSON.parse(JSON.stringify(v)) as unknown);
}

export interface ReadyMessage {
  type: "cf:ready";
  cf: 1;
  thread: { id: string; name: string } | null;
  theme: PublishedTheme;
  readOnly: string[];
  sources: string[];
  /** The thread's page storage: key → the value's JSON text. */
  storage: Record<string, string>;
}

export function readyMessage(
  thread: { id: string; name: string } | null,
  theme: PublishedTheme,
  readOnly: readonly string[],
  storage: Readonly<Record<string, string>> = {},
): ReadyMessage {
  return {
    type: "cf:ready",
    cf: 1,
    thread,
    theme,
    readOnly: thread ? [...readOnly].sort() : [],
    sources: thread ? [...BRIDGE_SOURCES] : [],
    storage: thread ? { ...storage } : {},
  };
}

/** A run waits on the user: its confirm dialog is open, or queued behind another. */
export interface PendingMessage {
  type: "cf:pending";
  id: CallId;
  reason: "confirm";
}

/** The user answered a run's confirmation yes: its clock runs again. */
export interface ResumeMessage {
  type: "cf:resume";
  id: CallId;
}

/** The thread's whole page storage, for a frame whose copy may be behind. */
export interface StorageMessage {
  type: "cf:storage";
  values: Record<string, string>;
}

export type ResultMessage =
  | { type: "cf:result"; id: CallId; ok: true; result: { text: string; json: unknown } }
  | { type: "cf:result"; id: CallId; ok: false; error: BridgeError; result?: { text: string; json: unknown } };

export function okResult(id: CallId, res: { message: string; resultJson: string }): ResultMessage {
  return { type: "cf:result", id, ok: true, result: { text: res.message, json: resultJson(res.resultJson) } };
}

/** A failed call; `declined` carries what a declined second stage already did, when it did something. */
export function errorResult(id: CallId, error: BridgeError, declined?: { message: string; resultJson: string } | null): ResultMessage {
  return declined
    ? { type: "cf:result", id, ok: false, error, result: { text: declined.message, json: resultJson(declined.resultJson) } }
    : { type: "cf:result", id, ok: false, error };
}

export interface EventMessage {
  type: "cf:event";
  id: CallId;
  source: string;
  event: unknown;
}

/** The refusal of a page with no owning thread (a File tab opened on an arbitrary HTML file). */
export const NO_THREAD: BridgeError = { code: "unavailable", message: "this page is not shown in a thread" };
