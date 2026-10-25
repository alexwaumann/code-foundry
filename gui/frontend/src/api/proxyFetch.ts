/**
 * ThreadService.ProxyFetch (docs/notes/bridge-fetch.md): the HTTP request a page shown in a
 * thread asks for with the bridge's cf.fetch, made by the daemon so the API's CORS rules
 * do not apply. A page's own read of someone else's service, not a user action: no command.
 */
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export interface ProxyFetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The body as text, sent as UTF-8. */
  body: string;
  timeoutMs: number;
}

export interface ProxyFetchAnswer {
  status: number;
  statusText: string;
  /** Lower-case name → value. */
  headers: Record<string, string>;
  /** The body, read as UTF-8. */
  body: string;
  /** The URL that answered, after redirects. */
  url: string;
}

/** How long past the request's own timeout the call waits for the daemon to say so. */
const ANSWER_GRACE_MS = 3000;

/** ThreadService.ProxyFetch; aborting `signal` aborts the request in the daemon. */
export async function proxyFetch(threadId: string, call: ProxyFetchCall, opts: { signal?: AbortSignal } = {}, conn: DaemonConnection = daemon): Promise<ProxyFetchAnswer> {
  const c = await conn.client(ThreadService);
  const res = await c.proxyFetch(
    { threadId, url: call.url, method: call.method, headers: call.headers, body: new TextEncoder().encode(call.body), timeoutMs: call.timeoutMs },
    { signal: opts.signal, timeoutMs: call.timeoutMs + ANSWER_GRACE_MS },
  );
  return { status: res.status, statusText: res.statusText, headers: { ...res.headers }, body: new TextDecoder().decode(res.body), url: res.url };
}
