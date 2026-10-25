/**
 * ThreadService.ProxyFetch (docs/notes/bridge-fetch.md) against a fake upstream: the mock
 * reaches no network. `https://upstream.test/issues` answers a list of issues to
 * `Authorization: Bearer good` and 401 to anything else; `/slow` holds until the caller
 * aborts (a page's cancel reaches the daemon). The daemon's own refusals are mirrored:
 * loopback, unspecified and link-local hosts are InvalidArgument, with its message.
 */
import { Code, ConnectError } from "@connectrpc/connect";

export interface MockFetch {
  url: string;
  method: string;
  headers: Record<string, string>;
  aborted: boolean;
}

const fetches: MockFetch[] = [];

const refused = /^(127\.|0\.|169\.254\.|localhost$|\[::1?\]$|\[fe80:)/i;

const text = (s: string) => new TextEncoder().encode(s);

export async function mockProxyFetch(req: { url: string; method: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number }, signal: AbortSignal) {
  let u: URL;
  try {
    u = new URL(req.url);
  } catch {
    throw new ConnectError(`"${req.url}" is not an absolute http or https URL`, Code.InvalidArgument);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new ConnectError(`only http and https URLs are fetched, not ${u.protocol}`, Code.InvalidArgument);
  if (refused.test(u.hostname)) throw new ConnectError(`${u.hostname} is a loopback address (${u.hostname}), which a page may not reach`, Code.InvalidArgument);
  const f: MockFetch = { url: req.url, method: req.method || "GET", headers: { ...req.headers }, aborted: false };
  fetches.push(f);
  if (u.host !== "upstream.test") throw new ConnectError(`${f.method} ${u.host} failed: the mock reaches no network`, Code.Unavailable);
  if (u.pathname === "/slow") {
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        f.aborted = true;
        reject(new Error("the request was cancelled"));
      });
    });
  }
  const auth = Object.entries(req.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  const json = { "content-type": "application/json" };
  if (auth !== "Bearer good") {
    return { status: 401, statusText: "Unauthorized", headers: json, body: text('{"error":"bad token"}'), url: req.url };
  }
  const issues = [
    { id: "ENG-1", title: "Flaky login test" },
    { id: "ENG-2", title: "Search is slow" },
    { id: "ENG-3", title: "Dark mode contrast" },
  ];
  return { status: 200, statusText: "OK", headers: json, body: text(JSON.stringify(issues)), url: req.url };
}

/** The requests the mock was asked to make (GET /__mock/fetches). */
export function mockFetches(): readonly MockFetch[] {
  return fetches;
}

export function resetFetches(): void {
  fetches.length = 0;
}
