// Package wstunnel carries one server-streaming Connect call over one WebSocket, for the
// GUI: fetch streams count against WebKit's six connections per origin, and WebSockets do
// not (docs/notes/ws-tunnel.md).
//
// The wire, on a socket opened at Prefix + <procedure> (/stream/codefoundry.v1.EventService/Watch):
//
//	client: text    {"headers":{"Authorization":"Bearer ...","Content-Type":"application/connect+proto"}}
//	client: binary  the request body, as it would be POSTed
//	daemon: text    {"status":200,"headers":{...}}
//	daemon: binary  one message per Flush of the handler: Connect's envelopes, unchanged
//	daemon: close   1000 once the handler has returned
//
// The tunnel owns no RPC: it replays the call as a POST through Options.Next, so a new
// stream needs nothing here, and the bearer check, its scopes and Connect's framing and
// errors are the same as over HTTP.
package wstunnel

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/reflect/protoreflect"
	"google.golang.org/protobuf/reflect/protoregistry"
)

// Prefix is the path the tunnel serves under.
const Prefix = "/stream/"

const (
	// readLimit caps each client message. Requests that open a stream are small.
	readLimit = 64 << 10
	// bigBuffer is the most a response keeps between messages: a thread's snapshot can be
	// tens of megabytes, and the stream it opens may then stay idle for hours.
	bigBuffer = 1 << 20

	defaultFirstFrameTimeout = 5 * time.Second
	defaultWriteTimeout      = 30 * time.Second
	defaultFinalTimeout      = time.Second
)

// forwarded are the head's headers a handler sees: Connect's, and the token. The rest are
// dropped, so a head cannot name a Host, an Origin, a forwarded address or a body length.
var forwarded = map[string]bool{
	"Authorization":            true,
	"Content-Type":             true,
	"Connect-Protocol-Version": true,
	"Connect-Timeout-Ms":       true,
	"Connect-Accept-Encoding":  true,
	"Connect-Content-Encoding": true,
}

// Options configures a Tunnel.
type Options struct {
	// AllowOrigin decides, before the upgrade, whether a page at origin may open a socket.
	AllowOrigin func(origin string) bool
	// Next runs the replayed call: the bearer check and the Connect handlers.
	Next http.Handler
	Log  *slog.Logger

	// FirstFrameTimeout bounds the wait for the head and the body. Zero: 5 s.
	FirstFrameTimeout time.Duration
	// WriteTimeout bounds each message, so a client that stopped reading cannot pin a
	// handler. Zero: 30 s.
	WriteTimeout time.Duration
	// FinalTimeout bounds the last flush, the close handshake, and any write still blocked
	// once the handler's context has ended. Zero: 1 s.
	FinalTimeout time.Duration
}

// Tunnel is the http.Handler behind Prefix.
type Tunnel struct {
	opts Options

	mu       sync.Mutex
	draining bool
	open     sync.WaitGroup
}

// New returns a Tunnel.
func New(opts Options) *Tunnel {
	if opts.FirstFrameTimeout == 0 {
		opts.FirstFrameTimeout = defaultFirstFrameTimeout
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = defaultWriteTimeout
	}
	if opts.FinalTimeout == 0 {
		opts.FinalTimeout = defaultFinalTimeout
	}
	return &Tunnel{opts: opts}
}

// Drain refuses new tunnels and waits for open ones to finish, or for ctx. http.Server's
// Shutdown does not wait for hijacked connections, so this is what keeps a handler from
// outliving the stores behind it. It ends nothing itself: tunnels end when the requests'
// base context does.
func (t *Tunnel) Drain(ctx context.Context) error {
	t.mu.Lock()
	t.draining = true
	t.mu.Unlock()
	done := make(chan struct{})
	go func() {
		t.open.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("drain tunnels: %w", ctx.Err())
	}
}

// enter counts a tunnel in; false once draining. Under the lock, so that no Add can race
// Drain's Wait.
func (t *Tunnel) enter() bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.draining {
		return false
	}
	t.open.Add(1)
	return true
}

// ServeHTTP checks the upgrade and serves the tunnel. Origin comes first and needs no
// token: a WebSocket is exempt from CORS, so this is what keeps a page from the socket
// even holding a leaked token. The one Origin value checked here is the one handlers see;
// a second header is refused rather than picked from.
func (t *Tunnel) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	origins := r.Header.Values("Origin")
	if len(origins) != 1 || !t.opts.AllowOrigin(origins[0]) {
		t.opts.Log.Info("tunnel refused", "origin", strings.Join(origins, ", "))
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	origin := origins[0]
	proc, ok := procedure(r.URL)
	if !ok {
		http.NotFound(w, r)
		return
	}
	if !t.enter() {
		http.Error(w, "shutting down", http.StatusServiceUnavailable)
		return
	}
	defer t.open.Done()
	// InsecureSkipVerify only because Origin has passed AllowOrigin above: the library's
	// own check passes an empty Origin and refuses wails://localhost, the production page.
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled})
	if err != nil {
		return // Accept has answered.
	}
	defer func() { _ = c.CloseNow() }()
	c.SetReadLimit(readLimit)
	log := t.opts.Log.With("procedure", proc, "origin", origin)
	log.Info("tunnel open")
	start := time.Now()
	reason := t.serve(r, c, proc, origin)
	log.Info("tunnel closed", "reason", reason, "dur", time.Since(start).Round(time.Millisecond).String())
}

// procedure is the one value everything downstream uses: the path of the server-streaming
// procedure u names, or false. Only a name the generated code registered passes, so no
// path reaches another route, and a unary or client-streaming procedure stops here, before
// the upgrade: it would need a body the tunnel never reads, and unary calls stay on HTTP.
// Anything percent-encoded is refused rather than decoded into a name.
func procedure(u *url.URL) (string, bool) {
	name, ok := strings.CutPrefix(u.Path, Prefix)
	if !ok || u.RawPath != "" || u.RawQuery != "" {
		return "", false
	}
	service, method, ok := strings.Cut(name, "/")
	if !ok {
		return "", false
	}
	d, err := protoregistry.GlobalFiles.FindDescriptorByName(protoreflect.FullName(service))
	if err != nil {
		return "", false
	}
	sd, ok := d.(protoreflect.ServiceDescriptor)
	if !ok {
		return "", false
	}
	md := sd.Methods().ByName(protoreflect.Name(method))
	if md == nil || !md.IsStreamingServer() || md.IsStreamingClient() {
		return "", false
	}
	return "/" + name, true
}

// serve runs one accepted tunnel and says how it ended.
//
// The socket must outlive the handler's context, or the end of the stream is lost at
// shutdown: the daemon cancels requests first. So the context readUntilGone reads under,
// which closes the socket when it ends, is detached from r's, and so are writes
// (response.send). The client going cancels the handler; the handler's context ending does
// not touch the socket.
func (t *Tunnel) serve(r *http.Request, c *websocket.Conn, proc, origin string) string {
	read, stopRead := context.WithCancel(context.Background())
	defer stopRead()

	first, cancelFirst := context.WithTimeout(r.Context(), t.opts.FirstFrameTimeout)
	defer cancelFirst()
	header, body, err := readRequest(first, c)
	if err != nil {
		// A deadline or an oversized message has closed the socket already.
		go readUntilGone(read, c, func() {})
		t.hangUp(c, websocket.StatusPolicyViolation, "bad request", stopRead)
		return "no request"
	}

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	go readUntilGone(read, c, cancel)

	header.Set("Origin", origin)
	req := (&http.Request{
		Method: http.MethodPost,
		// Built, not parsed: proc is what was validated, and nothing can re-read it as a
		// query or another path. Host and RemoteAddr are the upgrade's, already checked.
		URL:           &url.URL{Path: proc},
		RequestURI:    proc,
		Proto:         "HTTP/1.1",
		ProtoMajor:    1,
		ProtoMinor:    1,
		Header:        header,
		Body:          io.NopCloser(bytes.NewReader(body)),
		ContentLength: int64(len(body)),
		Host:          r.Host,
		RemoteAddr:    r.RemoteAddr,
	}).WithContext(ctx)
	w := &response{conn: c, header: http.Header{}, ctx: ctx, abort: cancel, writeTimeout: t.opts.WriteTimeout, finalTimeout: t.opts.FinalTimeout}
	t.opts.Next.ServeHTTP(w, req)
	cancel()
	w.Flush()
	t.hangUp(c, websocket.StatusNormalClosure, "", stopRead)
	if w.err != nil {
		return "write failed"
	}
	return "served"
}

// readUntilGone reads the socket until it is closed, calling gone on anything it reads:
// past the head and the body, any data counts as the client's close. This is CloseRead
// without its data path, which waits on itself for 20 s before it cancels (ws-tunnel.md).
// A reader must run for ping, pong and close frames to be seen at all.
func readUntilGone(ctx context.Context, c *websocket.Conn, gone func()) {
	for {
		_, _, err := c.Read(ctx)
		gone()
		if err != nil {
			return
		}
	}
}

// hangUp closes the socket with code. Close waits 5 s for a client's answer and CloseNow
// cannot cut that short, but ending readUntilGone closes the socket under it, so
// FinalTimeout bounds a client that never answers.
func (t *Tunnel) hangUp(c *websocket.Conn, code websocket.StatusCode, reason string, stopRead context.CancelFunc) {
	timer := time.AfterFunc(t.opts.FinalTimeout, stopRead)
	defer timer.Stop()
	_ = c.Close(code, reason)
}

// errBadRequest is a head or body that is not what the wire asks for. Never wraps what the
// client sent: the head holds the token.
var errBadRequest = errors.New("malformed tunnel request")

// readRequest reads the head and the body.
func readRequest(ctx context.Context, c *websocket.Conn) (http.Header, []byte, error) {
	typ, raw, err := c.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	if typ != websocket.MessageText {
		return nil, nil, errBadRequest
	}
	var head struct {
		Headers map[string]string `json:"headers"`
	}
	if json.Unmarshal(raw, &head) != nil {
		return nil, nil, errBadRequest
	}
	header, err := allowedHeaders(head.Headers)
	if err != nil {
		return nil, nil, err
	}
	typ, body, err := c.Read(ctx)
	if err != nil {
		return nil, nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, nil, errBadRequest
	}
	return header, body, nil
}

// allowedHeaders keeps the head's forwarded headers. Two spellings of one name are refused:
// map order would otherwise choose which Authorization the bearer check reads.
func allowedHeaders(in map[string]string) (http.Header, error) {
	out := make(http.Header, len(forwarded)+1)
	for k, v := range in {
		name := http.CanonicalHeaderKey(k)
		if !forwarded[name] {
			continue
		}
		if _, dup := out[name]; dup {
			return nil, errBadRequest
		}
		out[name] = []string{v}
	}
	return out, nil
}

// response is the http.ResponseWriter the replayed call writes to: the head goes out as one
// text message at the first Flush, and each Flush's bytes as one binary message.
type response struct {
	conn   *websocket.Conn
	header http.Header
	status int
	sent   bool
	buf    bytes.Buffer
	err    error

	ctx          context.Context // the handler's
	abort        context.CancelFunc
	writeTimeout time.Duration
	finalTimeout time.Duration
}

// Header implements http.ResponseWriter.
func (w *response) Header() http.Header { return w.header }

// WriteHeader implements http.ResponseWriter.
func (w *response) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

// Write implements http.ResponseWriter. Bytes wait for Flush, as they would in a buffer.
func (w *response) Write(b []byte) (int, error) {
	if w.err != nil {
		return 0, w.err
	}
	w.WriteHeader(http.StatusOK)
	return w.buf.Write(b)
}

// Flush implements http.Flusher. A failure surfaces on the next Write.
func (w *response) Flush() {
	w.WriteHeader(http.StatusOK)
	if !w.sent {
		w.sent = true
		headers := make(map[string]string, len(w.header))
		for k, v := range w.header {
			headers[k] = strings.Join(v, ", ")
		}
		head, err := json.Marshal(struct {
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
		}{w.status, headers})
		if err != nil {
			w.fail(err)
			return
		}
		w.send(websocket.MessageText, head)
	}
	if w.buf.Len() > 0 {
		w.send(websocket.MessageBinary, w.buf.Bytes())
	}
	if w.buf.Cap() > bigBuffer {
		w.buf = bytes.Buffer{}
	}
	w.buf.Reset()
}

// send writes one message, on a context of its own: Write closes the socket when its
// context ends, and the end of the stream is written after the handler's has. A write gets
// writeTimeout, or finalTimeout from the moment the handler's context is done, so a stuck
// client cannot hold shutdown for the rest of the deadline.
func (w *response) send(typ websocket.MessageType, b []byte) {
	if w.err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), w.writeTimeout)
	defer cancel()
	stop := context.AfterFunc(w.ctx, func() { time.AfterFunc(w.finalTimeout, cancel) })
	defer stop()
	if err := w.conn.Write(ctx, typ, b); err != nil {
		w.fail(err)
	}
}

// fail keeps err for the next Write and ends the handler, which may be waiting on no write.
func (w *response) fail(err error) {
	w.err = err
	w.abort()
}
