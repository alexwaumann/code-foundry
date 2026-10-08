import { Code, ConnectError, createClient, type Client, type Interceptor } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import type { DescService } from "@bufbuild/protobuf";
import { GetDaemonEndpoint } from "../../bindings/github.com/awaumann/code-foundry/gui/daemonservice";

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

  async client<T extends DescService>(service: T): Promise<Client<T>> {
    const pending = (this.endpoint ??= this.resolve());
    let ep: DaemonEndpoint;
    try {
      ep = await pending;
    } catch (err) {
      if (this.endpoint === pending) this.endpoint = null;
      throw err;
    }
    const key = `${ep.baseUrl}\n${ep.token}\n${service.typeName}`;
    const cached = this.clients.get(key);
    if (cached) return cached as Client<T>;
    const auth: Interceptor = (next) => (req) => {
      req.header.set("Authorization", `Bearer ${ep.token}`);
      return next(req);
    };
    const transport = createConnectTransport({ baseUrl: ep.baseUrl, interceptors: [auth] });
    const client = createClient(service, transport);
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
