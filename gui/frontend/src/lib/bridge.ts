/**
 * The page↔host message contract of the bridge (docs/notes/bridge-2-gui.md): what a page
 * shown in a thread posts to its parent through `/cf/bridge.js`, and what the host
 * (stores/bridgeHost.ts) posts back. Parsing, arg filling and the reply shapes; pure.
 *
 * Every frame's src carries a nonce in its query (`?cf-nonce=<nonce>`, withNonce), and the
 * script sends it back on every message: the host hears only its own frame's window, at
 * its origin, with its nonce (docs/notes/bridge-fix-frames.md). A frame navigated to any
 * other URL (another page's grant included) loses it, so it gets no bridge. The query, not
 * the fragment: the fragment is the page's own (`#/route`, `:target`; docs/notes/page-frame-states.md).
 *
 * Page → host (every message carries `cf: 1` and `nonce`):
 * - `{ type: "cf:run", id, verb, args }`, args an object of strings
 * - `{ type: "cf:on", id, source }`, `{ type: "cf:off", id }`
 * - `{ type: "cf:hello" }`: the script started; the only message `cf:ready` answers
 * - `{ type: "cf:bye" }`: the document goes (pagehide); its calls and subscriptions stop
 * - `{ type: "cf:store", id, key, value }`, value a JSON text or null to remove
 *   (docs/notes/bridge-fix-storage.md)
 * - `{ type: "cf:cancel", id }`: the page gave up on a run or a fetch (its timeout)
 * - `{ type: "cf:fetch", id, url, method, headers, body, timeout }`: an HTTP request the
 *   daemon makes (ThreadService.ProxyFetch), headers an object of strings, body a string,
 *   timeout ms; counted with the runs (docs/notes/bridge-fetch.md)
 * (`cf:resize` and `cf:theme:ack` predate the bridge: components/files/previewGrant.ts.)
 *
 * Host → page:
 * - `{ type: "cf:ready", cf: 1, thread: { id, name } | null, theme, readOnly, sources, storage, can, refusal }`
 *   (`can` and `refusal`: what the page may use whether or not it has a thread,
 *   docs/notes/page-ownership-gui.md)
 * - `{ type: "cf:asking", cf: 1 }`: the app holds cf:ready while it asks the user about the page
 * - `{ type: "cf:result", id, ok: true, result: { text, json } }`, or
 *   `{ type: "cf:result", id, ok: false, error: { code, message } }`; a fetch's ok result
 *   is `{ status, statusText, headers, body, url }`, whatever the status
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
  | { kind: "bye" }
  | { kind: "store"; id: CallId; key: string; value: string | null }
  | { kind: "cancel"; id: CallId }
  | { kind: "fetch"; id: CallId; url: string; method: string; headers: Record<string, string>; body: string; timeout: number }
  | { kind: "bad"; id: CallId; call: string; message: string };

function callId(v: unknown): CallId | null {
  if (typeof v === "string" && v !== "") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/**
 * What one page may hold at the host at once, and the largest message it hears
 * (docs/notes/bridge-fix-frames.md). The page script queues runs past `runs` itself.
 */
export const BRIDGE_LIMITS = {
  runs: 32,
  subscriptions: 16,
  messageChars: 256 * 1024,
  /** A cf:fetch's url, method, headers and body: a 1 MiB body and some. */
  fetchChars: 1024 * 1024 + 64 * 1024,
  /** cf.fetch's timeout when the page gives none, and the longest it may ask for. */
  fetchTimeoutMs: 30_000,
  fetchMaxTimeoutMs: 120_000,
} as const;

/** The query parameter of a frame's nonce (internal/bridge/bridge.js reads it). */
export const NONCE_PARAM = "cf-nonce";

/** A fresh nonce for one frame: 128 random bits, URL-safe. */
export function frameNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The frame's src: `url` with `cf-nonce=<nonce>` in its query (after the URL's own
 * parameters; its fragment, the page's own, untouched). A URL that does not parse gets it
 * appended before any fragment.
 */
export function withNonce(url: string, nonce: string): string {
  try {
    const u = new URL(url);
    u.searchParams.set(NONCE_PARAM, nonce);
    return u.toString();
  } catch {
    const hash = url.indexOf("#");
    const head = hash < 0 ? url : url.slice(0, hash);
    const tail = hash < 0 ? "" : url.slice(hash);
    return `${head}${head.includes("?") ? "&" : "?"}${NONCE_PARAM}=${nonce}${tail}`;
  }
}

/**
 * Whether a message from the frame's window may be heard by its host: it carries the
 * frame's nonce or, when `optional` (a page's own `cf:resize` and `cf:theme:ack`, which a
 * page without the script posts with no nonce), none at all. A wrong nonce never passes.
 */
export function nonceMatches(data: unknown, nonce: string, optional = false): boolean {
  if (typeof data !== "object" || data === null) return false;
  const got = (data as { nonce?: unknown }).nonce;
  if (got === undefined) return optional;
  return got === nonce;
}

/** The characters of a message's own fields the host would pass on, stopping once past the cap. */
function messageChars(m: Record<string, unknown>): number {
  let n = 0;
  for (const k of ["type", "verb", "source", "key", "value"]) if (typeof m[k] === "string") n += m[k].length;
  if (typeof m.id === "string") n += m.id.length;
  const args = m.args;
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args)) {
      n += k.length + (typeof v === "string" ? v.length : 0);
      if (n > BRIDGE_LIMITS.messageChars) break;
    }
  }
  return n;
}

/**
 * A bridge message from a page, or null for anything else (cf:resize, cf:theme:ack, stray
 * messages, and any message whose fields pass BRIDGE_LIMITS.messageChars: ignored, not
 * answered). The caller checked the nonce.
 */
export function parsePageMessage(data: unknown): PageMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.cf !== 1 || typeof m.type !== "string") return null;
  if (m.type === "cf:hello") return { kind: "hello" };
  if (m.type === "cf:bye") return { kind: "bye" };
  if (messageChars(m) > BRIDGE_LIMITS.messageChars) return null;
  if (m.type !== "cf:run" && m.type !== "cf:on" && m.type !== "cf:off" && m.type !== "cf:store" && m.type !== "cf:cancel" && m.type !== "cf:fetch") return null;
  const id = callId(m.id);
  if (id === null) return null;
  if (m.type === "cf:fetch") return parseFetch(id, m);
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

/** A cf:fetch, or null past BRIDGE_LIMITS.fetchChars (ignored, as any message too large). */
function parseFetch(id: CallId, m: Record<string, unknown>): PageMessage | null {
  const bad = (message: string): PageMessage => ({ kind: "bad", id, call: "cf.fetch", message });
  if (typeof m.url !== "string" || m.url === "") return bad("cf:fetch needs a url");
  const method = m.method === undefined ? "GET" : m.method;
  if (typeof method !== "string") return bad("cf:fetch method must be a string");
  const body = m.body ?? "";
  if (typeof body !== "string") return bad("cf:fetch body must be a string");
  const raw: unknown = m.headers ?? {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return bad("cf:fetch headers must be an object of strings");
  const headers: Record<string, string> = {};
  let n = m.url.length + method.length + body.length;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return bad(`cf:fetch header ${k} must be a string`);
    headers[k] = v;
    n += k.length + v.length;
  }
  if (n > BRIDGE_LIMITS.fetchChars) return null;
  const t = m.timeout;
  const timeout = typeof t === "number" && Number.isFinite(t) && t > 0 ? Math.min(Math.round(t), BRIDGE_LIMITS.fetchMaxTimeoutMs) : BRIDGE_LIMITS.fetchTimeoutMs;
  return { kind: "fetch", id, url: m.url, method, headers, body, timeout };
}

/** The host of a fetch's URL, for what the error strip names ("cf.fetch api.example.com"); never its path or query. */
export function fetchCall(url: string): string {
  try {
    return `cf.fetch ${new URL(url).host}`;
  } catch {
    return "cf.fetch";
  }
}

/** Where a page's calls run: its thread, and the checkout that thread works in (its cwd). */
export interface PagePlace {
  /** "" for a page no thread owns. */
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
    if (a.defaultToThreadEnv) {
      // A page no thread owns sends none, as the CLI outside a thread does.
      if (place.threadId) out[a.name] = place.threadId;
    } else if (a.defaultToCwd && place.cwd) out[a.name] = place.cwd;
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
  /** The thread the page acts for; null for a page no thread owns (allowed or not). */
  thread: { id: string; name: string } | null;
  theme: PublishedTheme;
  readOnly: string[];
  sources: string[];
  /** The page's storage: key → the value's JSON text (its thread's, or its own file's). */
  storage: Record<string, string>;
  /**
   * What the page may use, whether or not it has a thread (docs/notes/page-ownership-gui.md):
   * a page no thread owns that the user allowed has storage and fetch with `thread` null.
   * A page script from before this field reads storage and fetch as there iff `thread` is.
   */
  can: { storage: boolean; fetch: boolean };
  /** Why the page may use nothing ("" when it may): every call it makes is refused with it. */
  refusal: string;
}

/**
 * Whom a frame's bridge acts for: a thread (its own page), the page alone (no thread owns
 * it and the user allowed it: storage and fetch keyed by its file, app-wide verbs and
 * sources), or nobody, every call refused with `refusal`.
 */
export type ReadyAccess = { kind: "thread"; thread: { id: string; name: string } } | { kind: "page" } | { kind: "none"; refusal: string };

export function readyMessage(access: ReadyAccess, theme: PublishedTheme, readOnly: readonly string[], storage: Readonly<Record<string, string>> = {}): ReadyMessage {
  const some = access.kind !== "none";
  return {
    type: "cf:ready",
    cf: 1,
    thread: access.kind === "thread" ? access.thread : null,
    theme,
    readOnly: some ? [...readOnly].sort() : [],
    sources: some ? [...BRIDGE_SOURCES] : [],
    storage: some ? { ...storage } : {},
    can: { storage: some, fetch: some },
    refusal: access.kind === "none" ? access.refusal : "",
  };
}

/**
 * The app holds `cf:ready` while it asks the user whether the page may use Code Foundry
 * (docs/notes/page-ownership-gui.md): the page stops the clocks that wait for ready (cf.ready
 * itself, a run's or a fetch's wait), so nothing times out while the user reads the question.
 */
export interface AskingMessage {
  type: "cf:asking";
  cf: 1;
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

/** A fetch's answer as the page gets it: the daemon's, whatever the status. */
export interface FetchResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  url: string;
}

export type ResultMessage =
  | { type: "cf:result"; id: CallId; ok: true; result: { text: string; json: unknown } }
  | { type: "cf:result"; id: CallId; ok: true; result: FetchResult }
  | { type: "cf:result"; id: CallId; ok: false; error: BridgeError; result?: { text: string; json: unknown } };

export function okResult(id: CallId, res: { message: string; resultJson: string }): ResultMessage {
  return { type: "cf:result", id, ok: true, result: { text: res.message, json: resultJson(res.resultJson) } };
}

export function fetchResult(id: CallId, res: FetchResult): ResultMessage {
  return { type: "cf:result", id, ok: true, result: { status: res.status, statusText: res.statusText, headers: { ...res.headers }, body: res.body, url: res.url } };
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

/** The refusal of a page with no owning thread, from a daemon older than page ownership (a File tab opened on an arbitrary HTML file). */
export const NO_THREAD: BridgeError = { code: "unavailable", message: "this page is not shown in a thread" };

/** The refusal of a page no thread owns that the user did not allow (or has not yet). */
export const NOT_ALLOWED: BridgeError = { code: "unavailable", message: "the user has not allowed this page to use Code Foundry" };

/** The refusal of a file the daemon never gives a bridge (PageAccess.unavailable_reason). */
export function pageUnavailable(reason: string): BridgeError {
  return { code: "unavailable", message: reason ? `Code Foundry gives this page no bridge: ${reason}` : "Code Foundry gives this page no bridge" };
}

/** The refusal of a call that needs the page's thread, from a page no thread owns. */
export function needsThread(call: string): BridgeError {
  return { code: "unavailable", message: `this page has no thread (no thread showed or wrote it), and ${call} needs one` };
}
