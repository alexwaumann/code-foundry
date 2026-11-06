import { Code, ConnectError, createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type { DescService } from "@bufbuild/protobuf";
import { GetDaemonEndpoint } from "../../bindings/github.com/alexwaumann/code-foundry/gui/daemonservice";
import { wsFetch } from "./wsFetch";

/** Where the daemon's loopback listener is and how to authenticate to it. */
export interface DaemonEndpoint {
  baseUrl: string;
  token: string;
}

export type EndpointResolver = () => Promise<DaemonEndpoint>;

/** Asks the Wails host, which reads daemon.port / daemon.token (starting the daemon if needed). */
export const wailsEndpoint: EndpointResolver = () => GetDaemonEndpoint();

/**
 * Development-only endpoint override, so the frontend can run against the mock daemon
 * (gui/frontend/mock) in a plain browser or inside `wails3 dev`. Precedence:
 *
 *  1. query params `?daemon=<baseUrl>&token=<token>`
 *  2. env `VITE_DAEMON_URL` / `VITE_DAEMON_TOKEN` (read by Vite at dev-server start)
 *
 * Production builds ignore both and always ask the Wails host.
 */
export function overrideEndpoint(
  search: string,
  env: { VITE_DAEMON_URL?: string; VITE_DAEMON_TOKEN?: string },
): DaemonEndpoint | null {
  const q = new URLSearchParams(search);
  const qUrl = q.get("daemon");
  if (qUrl) return { baseUrl: qUrl, token: q.get("token") ?? "" };
  if (env.VITE_DAEMON_URL) return { baseUrl: env.VITE_DAEMON_URL, token: env.VITE_DAEMON_TOKEN ?? "" };
  return null;
}

/** Whether `?json=1` asks for JSON on the wire. */
export function jsonRequested(search: string): boolean {
  return new URLSearchParams(search).get("json") === "1";
}

/**
 * Binary protobuf, which Connect-Web does not default to: parsing a large thread as JSON
 * costs about five times the rest of its load (docs/notes/binary-transport.md). Development
 * builds take `?json=1` to read the traffic in the inspector; production ignores it.
 */
function binaryWire(): boolean {
  return !(import.meta.env.DEV && typeof window !== "undefined" && jsonRequested(window.location.search));
}

/**
 * Unary calls over fetch and every stream over the tunnel (docs/notes/ws-transport.md): a fetch
 * stream would hold one of WebKit's six connections per origin. There is no fallback to fetch, so
 * a daemon from before the tunnel has to be restarted: stores/update.ts says so.
 */
function daemonTransport(ep: DaemonEndpoint): Transport {
  const auth: Interceptor = (next) => (req) => {
    req.header.set("Authorization", `Bearer ${ep.token}`);
    return next(req);
  };
  const options = { baseUrl: ep.baseUrl, interceptors: [auth], useBinaryFormat: binaryWire() };
  const http = createConnectTransport(options);
  const tunnel = createConnectTransport({ ...options, fetch: wsFetch });
  return { unary: http.unary.bind(http), stream: tunnel.stream.bind(tunnel) };
}

function defaultResolver(): EndpointResolver {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const env = import.meta.env as { VITE_DAEMON_URL?: string; VITE_DAEMON_TOKEN?: string };
    const ep = overrideEndpoint(window.location.search, env);
    if (ep) return () => Promise.resolve(ep);
  }
  return wailsEndpoint;
}

/**
 * Daemon connection: resolves the endpoint lazily, caches it, and builds Connect
 * clients against it. Call invalidate() after a failed request so the next call
 * re-resolves, which picks up a restarted daemon's new port and token.
 */
export class DaemonConnection {
  private endpoint: Promise<DaemonEndpoint> | null = null;
  private clients = new Map<string, unknown>();
  private readonly resolve: EndpointResolver;

  constructor(resolve: EndpointResolver) {
    this.resolve = resolve;
  }

  /** The daemon's endpoint, resolved once and cached (for a URL the GUI builds itself, such as the HTML preview's). */
  async resolveEndpoint(): Promise<DaemonEndpoint> {
    const pending = (this.endpoint ??= this.resolve());
    try {
      return await pending;
    } catch (err) {
      if (this.endpoint === pending) this.endpoint = null;
      throw err;
    }
  }

  async client<T extends DescService>(service: T): Promise<Client<T>> {
    const ep = await this.resolveEndpoint();
    const key = `${ep.baseUrl}\n${ep.token}\n${service.typeName}`;
    const cached = this.clients.get(key);
    if (cached) return cached as Client<T>;
    const client = createClient(service, daemonTransport(ep));
    this.clients.set(key, client);
    return client;
  }

  invalidate(): void {
    this.endpoint = null;
    this.clients.clear();
  }
}

export const daemon = new DaemonConnection(defaultResolver());

/**
 * Drops the cached endpoint after errors that suggest the daemon moved (a restart picks a
 * new port and token): transport failures and auth errors. Application errors such as
 * NotFound or Unimplemented keep it.
 */
export function invalidateOnTransportError(err: unknown, conn: DaemonConnection = daemon): void {
  if (err instanceof ConnectError && err.code !== Code.Unavailable && err.code !== Code.Unauthenticated && err.code !== Code.Unknown) return;
  conn.invalidate();
}
