/**
 * The WebSocket tunnel at /stream/<procedure>, like the daemon's (internal/wstunnel, whose
 * package comment has the wire). The daemon replays a call through its handlers; this replays
 * it as a real request to the mock's own port, so every route, /__mock/streams and the bearer
 * check apply unchanged. Origin and procedure checks stay the daemon's, tested in Go.
 */
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";

const PREFIX = "/stream/";

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : (v ?? "")]));
}

/** Sends one call to the mock and its answer down the socket: 1000 at its end, a dropped socket if it breaks. */
function replay(ws: WebSocket, port: number, path: string, headers: Record<string, string>, body: RawData): void {
  const call = request({ host: "127.0.0.1", port, path, method: "POST", headers, agent: false });
  const drop = () => {
    ws.terminate();
  };
  call.on("error", drop);
  call.on("response", (res) => {
    ws.send(JSON.stringify({ status: res.statusCode, headers: flatHeaders(res.headers) }));
    res.on("data", (chunk: Buffer) => {
      ws.send(chunk);
    });
    res.on("end", () => {
      ws.close(1000);
    });
    res.on("error", drop);
  });
  ws.on("close", () => {
    call.destroy();
  });
  call.end(body);
}

/** Serves the tunnel on `server`, which listens on `port`. Returns what drops every open socket. */
export function serveTunnel(server: Server, port: number): () => void {
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const { pathname } = new URL(req.url ?? "/", "http://mock");
    if (!pathname.startsWith(PREFIX)) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      // An unhandled "error" would end the mock, and with it a worker's whole run.
      ws.on("error", () => {
        ws.terminate();
      });
      ws.once("message", (first: RawData) => {
        const { headers } = JSON.parse((first as Buffer).toString()) as { headers: Record<string, string> };
        ws.once("message", (body: RawData) => {
          replay(ws, port, pathname.slice(PREFIX.length - 1), headers, body);
        });
      });
    });
  });
  return () => {
    for (const ws of sockets.clients) ws.terminate();
  };
}
