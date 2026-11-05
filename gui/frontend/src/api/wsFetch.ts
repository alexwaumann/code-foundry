/**
 * A `fetch` over one WebSocket, for connect-web's `createConnectTransport({ fetch })`: fetch
 * streams count against WebKit's six connections per origin, and WebSockets do not
 * (docs/notes/ws-transport.md). connect-web's stream() only calls `fetch(url, { headers,
 * signal, body })` and reads the Response, so its framing, end-of-stream parsing and error
 * mapping all still apply, and the bytes are the same for binary and `?json=1`.
 *
 * It fails the way fetch does, so runStream cannot tell them apart: a TypeError when the daemon
 * cannot be reached or the socket dies, and the signal's reason on an abort, from the promise
 * before the head and from the body after it. The wire is in internal/wstunnel's package comment.
 */

/** The path the daemon serves the tunnel under (wstunnel.Prefix, without its last slash). */
const STREAM_PREFIX = "/stream";

/** A normal close: the handler returned, and the end of stream is already in the body. */
const CLOSE_NORMAL = 1000;

/** WebSocket.CLOSED, which a test's fake socket need not define. */
const SOCKET_CLOSED = 3;

/** Past this many open sockets something is leaking one: nothing here caps them. */
export const OPEN_SOCKETS_WARNING = 150;

let openSockets = 0;

/** The sockets open now, closing ones included. */
export function openSocketCount(): number {
  return openSockets;
}

function socketUrl(input: Parameters<typeof fetch>[0]): string {
  const url = new URL(input instanceof Request ? input.url : input);
  return `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}${STREAM_PREFIX}${url.pathname}`;
}

export const wsFetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init?.signal ?? undefined;
    // "abort" never fires on a signal that has already aborted, and a socket opened now
    // would stay open: StrictMode's first effect run does exactly this.
    if (signal?.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const body = init?.body;
    if (!ArrayBuffer.isView(body)) {
      reject(new TypeError("a WebSocket stream needs a binary request body"));
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(socketUrl(input));
    } catch (cause) {
      reject(new TypeError("could not open a WebSocket stream", { cause }));
      return;
    }
    ws.binaryType = "arraybuffer";
    openSockets++;
    if (openSockets === OPEN_SOCKETS_WARNING + 1) console.warn(`more than ${String(OPEN_SOCKETS_WARNING)} WebSockets open`);

    // Once per socket: a refused one can fire error and never close.
    let counted = true;
    const uncount = () => {
      if (counted) openSockets--;
      counted = false;
    };

    // Set once the head has arrived: the body's end, which from then on replaces the promise.
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    // The caller has its answer: the promise rejected, or the body ended, failed or was cancelled.
    let finished = false;

    const finish = () => {
      finished = true;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (finished) return;
      finish();
      if (controller) controller.error(err);
      else reject(err);
      ws.close();
    };
    function onAbort() {
      fail(signal?.reason as Error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    const onHead = (text: string) => {
      const head = JSON.parse(text) as { status: number; headers: Record<string, string> };
      const stream = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
        },
        cancel: () => {
          finish();
          ws.close();
        },
      });
      resolve(new Response(stream, { status: head.status, headers: head.headers }));
    };

    ws.onopen = () => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      ws.send(JSON.stringify({ headers }));
      ws.send(body);
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (finished) return;
      if (typeof e.data !== "string") {
        if (controller) controller.enqueue(new Uint8Array(e.data));
        else fail(new TypeError("a WebSocket stream sent its body before its head"));
        return;
      }
      if (controller) {
        fail(new TypeError("a WebSocket stream sent a second head"));
        return;
      }
      try {
        onHead(e.data);
      } catch (cause) {
        // Before anything could read the body: the promise is the one to reject.
        controller = null;
        fail(new TypeError("a WebSocket stream sent a bad head", { cause }));
      }
    };
    // A socket WebKit refuses outright (a restricted port) fires this and no close event, so
    // close alone would leave the caller pending, with no retry. Otherwise close follows.
    ws.onerror = () => {
      fail(new TypeError("a WebSocket stream failed"));
      if (ws.readyState === SOCKET_CLOSED) uncount();
    };
    ws.onclose = (e) => {
      uncount();
      if (finished) return;
      if (controller && e.code === CLOSE_NORMAL) {
        finish();
        controller.close();
        return;
      }
      fail(new TypeError(`a WebSocket stream closed with ${String(e.code)}`));
    };
  });
