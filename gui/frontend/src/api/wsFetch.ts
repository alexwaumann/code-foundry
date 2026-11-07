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

/**
 * How often to tell the daemon how much has arrived: its flow control (internal/wstunnel) lets
 * 8 MiB go uncounted, so this must stay below that or a stream would stop for good. A browser
 * empties the socket whether or not the page runs, so these counts are all that stops a daemon
 * filling a page that has stopped (docs/notes/ws-transport.md). Sent only to a daemon whose head
 * asks for them: one from before them, which an update leaves running until `daemon restart`,
 * reads a count as the client closing.
 */
const ACK_BYTES = 2 << 20;

/**
 * The most the body may hold unread. Counts go out as bytes arrive, so a reader that stops is
 * bounded here and not by the daemon. A live reader keeps this at 0 (measured under `yes`), and
 * a snapshot past it still arrives: thread snapshots reach 49 MB and terminal ones 104 MB.
 */
export const MAX_QUEUED_BYTES = 64 << 20;

/**
 * Past this many open sockets something is probably leaking one: a plugin's view holds at most
 * its 32 threads and 16 terminals, and two side by side stay under this. Only a log line: nothing
 * here caps them.
 */
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
    // Body bytes arrived, how many of them the daemon has been told of, and whether it wants to be.
    let received = 0;
    let told = 0;
    let counts = false;

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
      const head = JSON.parse(text) as { status: number; headers: Record<string, string>; counts?: boolean };
      counts = head.counts === true;
      const stream = new ReadableStream<Uint8Array>(
        {
          start: (c) => {
            controller = c;
          },
          cancel: () => {
            finish();
            ws.close();
          },
        },
        // In bytes, so desiredSize is the room left. A read already waiting takes a chunk
        // straight from enqueue, and desiredSize only falls for what stays queued.
        { highWaterMark: MAX_QUEUED_BYTES, size: (chunk) => chunk.byteLength },
      );
      resolve(new Response(stream, { status: head.status, headers: head.headers }));
    };

    const onBody = (c: ReadableStreamDefaultController<Uint8Array>, data: ArrayBuffer) => {
      // Past the cap before this message, so one larger than the cap can still be read.
      if ((c.desiredSize ?? 0) <= 0) {
        fail(new TypeError("a WebSocket stream's reader fell too far behind"));
        return;
      }
      c.enqueue(new Uint8Array(data));
      received += data.byteLength;
      if (counts && received - told >= ACK_BYTES) {
        told = received;
        ws.send(String(received));
      }
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
        if (controller) onBody(controller, e.data);
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
