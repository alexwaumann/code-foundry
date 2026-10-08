import { createClient, type Client, type Interceptor } from "@connectrpc/connect";
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
 * Daemon connection: resolves the endpoint lazily, caches it, and builds Connect
 * clients against it. Call invalidate() after a failed request so the next call
 * re-resolves, which picks up a restarted daemon's new port and token.
 */
export class DaemonConnection {
  private endpoint: Promise<DaemonEndpoint> | null = null;
  private readonly resolve: EndpointResolver;

  constructor(resolve: EndpointResolver) {
    this.resolve = resolve;
  }

  async client<T extends DescService>(service: T): Promise<Client<T>> {
    this.endpoint ??= this.resolve();
    let ep: DaemonEndpoint;
    try {
      ep = await this.endpoint;
    } catch (err) {
      this.endpoint = null;
      throw err;
    }
    const auth: Interceptor = (next) => (req) => {
      req.header.set("Authorization", `Bearer ${ep.token}`);
      return next(req);
    };
    const transport = createConnectTransport({ baseUrl: ep.baseUrl, interceptors: [auth] });
    return createClient(service, transport);
  }

  invalidate(): void {
    this.endpoint = null;
  }
}

export const daemon = new DaemonConnection(wailsEndpoint);
