package wstunnel_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/wstunnel"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

const (
	origin = "wails://localhost"
	token  = "the-secret-token"
)

// handler is what a test's Attach does.
type handler = func(context.Context, *connect.ServerStream[v1.AttachEvent]) error

// rig is a tunnel on a real server, its requests under a context the test can cancel the
// way the daemon does at shutdown.
type rig struct {
	t        *testing.T
	tunnel   *wstunnel.Tunnel
	srv      *httptest.Server
	shutdown context.CancelFunc
	logs     *lockedBuffer
	// seen is the last request the Connect handler's mux received.
	seen chan *http.Request
}

type lockedBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuffer) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}

func (l *lockedBuffer) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

func newRig(t *testing.T, opts wstunnel.Options, fn handler) *rig {
	t.Helper()
	r := &rig{t: t, logs: &lockedBuffer{}, seen: make(chan *http.Request, 1)}
	path, h := wstunneltest.Attach(fn)
	mux := http.NewServeMux()
	mux.Handle(path, h)
	opts.Next = http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		select {
		case r.seen <- req.Clone(req.Context()): // Connect edits the original's headers.
		default:
		}
		mux.ServeHTTP(w, req)
	})
	opts.AllowOrigin = func(o string) bool { return o == origin }
	opts.Log = slog.New(slog.NewTextHandler(r.logs, nil))
	r.tunnel = wstunnel.New(opts)
	base, cancel := context.WithCancel(context.Background())
	r.shutdown = cancel
	t.Cleanup(cancel)
	m := http.NewServeMux()
	m.Handle(wstunnel.Prefix, r.tunnel)
	r.srv = httptest.NewUnstartedServer(m)
	r.srv.Config.BaseContext = func(net.Listener) context.Context { return base }
	r.srv.Start()
	t.Cleanup(r.srv.Close)
	return r
}

func (r *rig) url(proc string) string {
	return "ws" + strings.TrimPrefix(r.srv.URL, "http") + "/stream" + proc
}

func (r *rig) dial(ctx context.Context) *wstunneltest.Client {
	r.t.Helper()
	c, _, err := wstunneltest.Dial{URL: r.url(wstunneltest.Stream), Origins: []string{origin}}.Open(ctx)
	if err != nil {
		r.t.Fatal(err)
	}
	r.t.Cleanup(func() { _ = c.Conn.CloseNow() })
	return c
}

// call dials and sends a good request.
func (r *rig) call(ctx context.Context) *wstunneltest.Client {
	r.t.Helper()
	c := r.dial(ctx)
	if err := c.Send(ctx, wstunneltest.Headers(token), requestBody(r.t)); err != nil {
		r.t.Fatal(err)
	}
	return c
}

func requestBody(t *testing.T) []byte {
	t.Helper()
	b, err := wstunneltest.Body(&v1.AttachRequest{Id: "t-1"})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	t.Cleanup(cancel)
	return ctx
}

// waitDone fails the test unless ch closes within d.
func waitDone(t *testing.T, ch <-chan struct{}, d time.Duration, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(d):
		t.Fatalf("%s: not within %v", what, d)
	}
}

// hold is a handler that sends one event, then waits for its context. It closes ended on
// the way out.
func hold(ended chan struct{}) handler {
	return func(ctx context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		defer close(ended)
		if err := s.Send(wstunneltest.Output([]byte("hello"))); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}
}

// The whole wire: the head as text, each Flush as one binary message, the end of stream,
// close 1000.
func TestStreamsThroughConnect(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{}, func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		for _, m := range []string{"one", "two"} {
			if err := s.Send(wstunneltest.Output([]byte(m))); err != nil {
				return err
			}
		}
		return nil
	})
	c := r.call(ctx)
	head, err := c.ReadHead(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != http.StatusOK || head.Headers["Content-Type"] != "application/connect+proto" {
		t.Errorf("head = %+v", head)
	}
	for _, want := range []string{"one", "two"} {
		f, err := c.ReadFrame(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if f.End() || !bytes.Contains(f.Payload, []byte(want)) {
			t.Errorf("frame = %+v, want a message with %q", f, want)
		}
	}
	end, err := c.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !end.End() {
		t.Errorf("last frame = %+v, want the end of stream", end)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("close = %v, want 1000", code)
	}
}

// The handler sees the upgrade's Host, remote address and checked Origin and the head's
// allow-listed headers, whatever else the head names.
func TestHeadCannotSpoofTheRequest(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c := r.dial(ctx)
	headers := wstunneltest.Headers(token)
	for k, v := range map[string]string{
		"Host": "evil.example", "Origin": "http://evil.example", "X-Forwarded-For": "1.2.3.4",
		"X-Real-Ip": "1.2.3.4", "Forwarded": "for=1.2.3.4", "Content-Length": "1", "Transfer-Encoding": "chunked",
		"Cookie": "a=b", "X-Http-Method-Override": "GET", "Connection": "close", ":authority": "evil.example",
		"Grpc-Timeout": "1S", "X-Grpc-Web": "1",
	} {
		headers[k] = v
	}
	if err := c.Send(ctx, headers, requestBody(t)); err != nil {
		t.Fatal(err)
	}
	var req *http.Request
	select {
	case req = <-r.seen:
	case <-ctx.Done():
		t.Fatal("handler not reached")
	}
	wantHost := strings.TrimPrefix(r.srv.URL, "http://")
	if req.Host != wantHost {
		t.Errorf("Host = %q, want %q", req.Host, wantHost)
	}
	if req.Method != http.MethodPost || req.URL.Path != wstunneltest.Stream || req.URL.RawQuery != "" {
		t.Errorf("request = %s %s", req.Method, req.URL)
	}
	if !strings.HasPrefix(req.RemoteAddr, "127.0.0.1:") {
		t.Errorf("RemoteAddr = %q", req.RemoteAddr)
	}
	if req.ContentLength != int64(len(requestBody(t))) {
		t.Errorf("ContentLength = %d", req.ContentLength)
	}
	want := map[string]string{
		"Authorization": "Bearer " + token, "Content-Type": "application/connect+proto",
		"Connect-Protocol-Version": "1", "Origin": origin,
	}
	if len(req.Header) != len(want) {
		t.Errorf("headers = %v, want only %v", req.Header, want)
	}
	for k, v := range want {
		if got := req.Header.Values(k); len(got) != 1 || got[0] != v {
			t.Errorf("%s = %q, want %q", k, got, v)
		}
	}
}

// What is on the upgrade request is not the call's: the token comes from the head alone.
func TestUpgradeHeadersDoNotReachTheHandler(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c, _, err := wstunneltest.Dial{URL: r.url(wstunneltest.Stream), Origins: []string{origin}, Header: http.Header{
		"Authorization": {"Bearer " + token}, "X-Forwarded-For": {"1.2.3.4"},
	}}.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = c.Conn.CloseNow() }()
	if err := c.Send(ctx, wstunneltest.Headers(""), requestBody(t)); err != nil {
		t.Fatal(err)
	}
	req := <-r.seen
	if got := req.Header.Get("Authorization"); got != "" {
		t.Errorf("Authorization = %q, want none", got)
	}
	if got := req.Header.Get("X-Forwarded-For"); got != "" {
		t.Errorf("X-Forwarded-For = %q, want none", got)
	}
}

func TestPathAndOriginBeforeTheUpgrade(t *testing.T) {
	hijacked := func(t *testing.T) *wstunnel.Tunnel {
		t.Helper()
		return wstunnel.New(wstunnel.Options{
			AllowOrigin: func(o string) bool { return o == origin },
			Next:        http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("handler reached") }),
			Log:         slog.New(slog.DiscardHandler),
		})
	}
	stream := "/stream" + wstunneltest.Stream
	tests := []struct {
		name    string
		target  string
		origins []string
		want    int
	}{
		// 426: everything passed, and this request is no upgrade (the recorder cannot hijack).
		{"server stream", stream, []string{origin}, http.StatusUpgradeRequired},
		{"unary procedure", "/stream" + wstunneltest.Unary, []string{origin}, http.StatusNotFound},
		{"client stream procedure", "/stream" + wstunneltest.ClientStream, []string{origin}, http.StatusNotFound},
		{"unknown method", "/stream/codefoundry.v1.TerminalService/Nope", []string{origin}, http.StatusNotFound},
		{"unknown service", "/stream/codefoundry.v1.Nope/Watch", []string{origin}, http.StatusNotFound},
		{"a message, not a service", "/stream/codefoundry.v1.AttachRequest/id", []string{origin}, http.StatusNotFound},
		{"bare prefix", "/stream/", []string{origin}, http.StatusNotFound},
		{"service only", "/stream/codefoundry.v1.TerminalService", []string{origin}, http.StatusNotFound},
		{"trailing slash", stream + "/", []string{origin}, http.StatusNotFound},
		{"extra segment", stream + "/more", []string{origin}, http.StatusNotFound},
		{"preview route", "/stream/preview/grant/index.html", []string{origin}, http.StatusNotFound},
		{"page library", "/stream/cf/theme.css", []string{origin}, http.StatusNotFound},
		{"encoded slash", "/stream/codefoundry.v1.TerminalService%2FAttach", []string{origin}, http.StatusNotFound},
		{"encoded letter", "/stream/codefoundry.v1.TerminalService/%41ttach", []string{origin}, http.StatusNotFound},
		{"encoded query", stream + "%3Fa=b", []string{origin}, http.StatusNotFound},
		{"encoded fragment", stream + "%23a", []string{origin}, http.StatusNotFound},
		{"encoded dot segment", "/stream/%2e%2e/preview/x", []string{origin}, http.StatusNotFound},
		{"token in the query", stream + "?token=" + token, []string{origin}, http.StatusNotFound},
		{"no origin", stream, nil, http.StatusForbidden},
		{"empty origin", stream, []string{""}, http.StatusForbidden},
		{"other origin", stream, []string{"http://127.0.0.1:1"}, http.StatusForbidden},
		{"a good origin second", stream, []string{"http://evil.example", origin}, http.StatusForbidden},
		{"a good origin first", stream, []string{origin, "http://evil.example"}, http.StatusForbidden},
		{"origin before path", "/stream/nope", []string{"http://evil.example"}, http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.target, nil)
			req.Header["Origin"] = tc.origins
			rec := httptest.NewRecorder()
			hijacked(t).ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Errorf("status %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

// A socket that never sends its first frames is closed at the deadline, without a handler.
func TestFirstFrameDeadline(t *testing.T) {
	tests := []struct {
		name string
		send func(context.Context, *wstunneltest.Client) error
	}{
		{"nothing", func(context.Context, *wstunneltest.Client) error { return nil }},
		{"head only", func(ctx context.Context, c *wstunneltest.Client) error {
			return c.Conn.Write(ctx, websocket.MessageText, []byte(`{"headers":{}}`))
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx := testContext(t)
			r := newRig(t, wstunnel.Options{FirstFrameTimeout: 100 * time.Millisecond}, func(context.Context, *connect.ServerStream[v1.AttachEvent]) error {
				t.Error("handler reached")
				return nil
			})
			c := r.dial(ctx)
			if err := tc.send(ctx, c); err != nil {
				t.Fatal(err)
			}
			start := time.Now()
			c.ReadClose(ctx)
			if d := time.Since(start); d > 5*time.Second {
				t.Errorf("closed after %v", d)
			}
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Error(err)
			}
		})
	}
}

// A bad first frame is a 1008 and no handler; over the limit, a 1009.
func TestBadFirstFrames(t *testing.T) {
	head := func() []byte { return []byte(`{"headers":{"Authorization":"Bearer x"}}`) }
	big := make([]byte, 64<<10+1)
	frame := func(typ websocket.MessageType, b []byte) struct {
		typ websocket.MessageType
		b   []byte
	} {
		return struct {
			typ websocket.MessageType
			b   []byte
		}{typ, b}
	}
	type sends = []struct {
		typ websocket.MessageType
		b   []byte
	}
	tests := []struct {
		name  string
		sends sends
		want  websocket.StatusCode
	}{
		{"binary head", sends{frame(websocket.MessageBinary, head())}, websocket.StatusPolicyViolation},
		{"not JSON", sends{frame(websocket.MessageText, []byte("Authorization: Bearer x"))}, websocket.StatusPolicyViolation},
		{"headers not strings", sends{frame(websocket.MessageText, []byte(`{"headers":{"Authorization":["a","b"]}}`))}, websocket.StatusPolicyViolation},
		{"two spellings of a header", sends{frame(websocket.MessageText, []byte(`{"headers":{"Authorization":"Bearer a","authorization":"Bearer b"}}`))}, websocket.StatusPolicyViolation},
		{"text body", sends{frame(websocket.MessageText, head()), frame(websocket.MessageText, []byte("x"))}, websocket.StatusPolicyViolation},
		{"oversize head", sends{frame(websocket.MessageText, big)}, websocket.StatusMessageTooBig},
		{"oversize body", sends{frame(websocket.MessageText, head()), frame(websocket.MessageBinary, big)}, websocket.StatusMessageTooBig},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx := testContext(t)
			r := newRig(t, wstunnel.Options{}, func(context.Context, *connect.ServerStream[v1.AttachEvent]) error {
				t.Error("handler reached")
				return nil
			})
			c := r.dial(ctx)
			for _, s := range tc.sends {
				if err := c.Conn.Write(ctx, s.typ, s.b); err != nil {
					t.Fatal(err)
				}
			}
			if code := c.ReadClose(ctx); code != tc.want {
				t.Errorf("close = %v, want %v", code, tc.want)
			}
			if logs := r.logs.String(); strings.Contains(logs, "Bearer") {
				t.Errorf("a head value reached the log: %s", logs)
			}
		})
	}
}

// A body of exactly the limit is served.
func TestBodyAtTheLimit(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c := r.dial(ctx)
	body, err := wstunneltest.Body(&v1.AttachRequest{Id: strings.Repeat("x", 64<<10-9)})
	if err != nil {
		t.Fatal(err)
	}
	if len(body) != 64<<10 {
		t.Fatalf("body is %d bytes", len(body))
	}
	if err := c.Send(ctx, wstunneltest.Headers(token), body); err != nil {
		t.Fatal(err)
	}
	head, err := c.ReadHead(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if head.Status != http.StatusOK {
		t.Errorf("head = %+v", head)
	}
}

// However the client goes, the handler's context ends.
func TestClientGoneCancelsTheHandler(t *testing.T) {
	tests := []struct {
		name string
		gone func(context.Context, *wstunneltest.Client) error
	}{
		{"close handshake", func(_ context.Context, c *wstunneltest.Client) error {
			return c.Conn.Close(websocket.StatusNormalClosure, "")
		}},
		{"socket dropped", func(_ context.Context, c *wstunneltest.Client) error { return c.Conn.CloseNow() }},
		{"data after the body", func(ctx context.Context, c *wstunneltest.Client) error {
			return c.Conn.Write(ctx, websocket.MessageBinary, []byte("more"))
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ctx := testContext(t)
			ended := make(chan struct{})
			r := newRig(t, wstunnel.Options{}, hold(ended))
			c := r.call(ctx)
			if _, err := c.ReadHead(ctx); err != nil {
				t.Fatal(err)
			}
			if err := tc.gone(ctx, c); err != nil {
				t.Fatal(err)
			}
			waitDone(t, ended, 3*time.Second, "handler end")
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Error(err)
			}
		})
	}
}

// At shutdown the requests' context is cancelled first. The handler's error must still
// reach the client as Connect's end of stream, then a clean close: without the detached
// socket the client sees "missing EndStreamResponse". Drain sees it through.
func TestEndStreamDeliveredAtShutdown(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadFrame(ctx); err != nil {
		t.Fatal(err)
	}
	r.shutdown()
	end, err := c.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !end.Contains("canceled") {
		t.Errorf("last frame = %+v %q, want the end of stream with the handler's error", end, end.Payload)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("close = %v, want 1000", code)
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Error(err)
	}
}

// A handler slower than FinalTimeout to unwind still gets its end of stream out.
func TestEndStreamAfterASlowUnwind(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{FinalTimeout: 100 * time.Millisecond}, func(hctx context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		if err := s.Send(wstunneltest.Output([]byte("hello"))); err != nil {
			return err
		}
		<-hctx.Done()
		time.Sleep(300 * time.Millisecond)
		return hctx.Err()
	})
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadFrame(ctx); err != nil {
		t.Fatal(err)
	}
	r.shutdown()
	end, err := c.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !end.End() {
		t.Errorf("last frame = %+v", end)
	}
}

func TestDrain(t *testing.T) {
	t.Run("waits for a tunnel and then refuses new ones", func(t *testing.T) {
		ctx := testContext(t)
		release := make(chan struct{})
		ended := make(chan struct{})
		r := newRig(t, wstunnel.Options{}, func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
			defer close(ended)
			if err := s.Send(wstunneltest.Output(nil)); err != nil {
				return err
			}
			<-release
			return nil
		})
		c := r.call(ctx)
		if _, err := c.ReadHead(ctx); err != nil {
			t.Fatal(err)
		}
		drained := make(chan struct{})
		go func() {
			defer close(drained)
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Error(err)
			}
		}()
		select {
		case <-drained:
			t.Fatal("drained with a handler running")
		case <-time.After(100 * time.Millisecond):
		}
		_, resp, err := wstunneltest.Dial{URL: r.url(wstunneltest.Stream), Origins: []string{origin}}.Open(ctx)
		if err == nil || resp == nil || resp.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("dial while draining: resp %v, err %v", resp, err)
		}
		close(release)
		waitDone(t, drained, 5*time.Second, "drain")
	})

	t.Run("gives up with its context", func(t *testing.T) {
		ctx := testContext(t)
		release := make(chan struct{})
		t.Cleanup(func() { close(release) })
		r := newRig(t, wstunnel.Options{}, func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
			if err := s.Send(wstunneltest.Output(nil)); err != nil {
				return err
			}
			<-release
			return nil
		})
		c := r.call(ctx)
		if _, err := c.ReadHead(ctx); err != nil {
			t.Fatal(err)
		}
		short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
		defer cancel()
		if err := r.tunnel.Drain(short); !errors.Is(err, context.DeadlineExceeded) {
			t.Errorf("Drain = %v, want the deadline", err)
		}
	})
}

// flood sends until a Send fails and reports that on done.
func flood(done chan<- error) handler {
	return func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		chunk := make([]byte, 1<<20)
		for {
			if err := s.Send(wstunneltest.Output(chunk)); err != nil {
				done <- err
				return err
			}
		}
	}
}

// A client that stopped reading fills the socket; the write deadline frees the handler.
func TestStuckClientHitsTheWriteDeadline(t *testing.T) {
	ctx := testContext(t)
	done := make(chan error, 1)
	r := newRig(t, wstunnel.Options{WriteTimeout: 200 * time.Millisecond, FinalTimeout: 100 * time.Millisecond}, flood(done))
	r.call(ctx) // and never reads
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("handler still pinned")
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Error(err)
	}
	if !strings.Contains(r.logs.String(), `reason="write timeout"`) {
		t.Errorf("logs: %s", r.logs.String())
	}
}

// A browser takes everything off the socket whether or not its page runs, so a client that
// reads but counts nothing is the stuck page: it gets the window, then the write deadline.
func TestPageThatStoppedHitsTheWriteDeadline(t *testing.T) {
	ctx := testContext(t)
	done := make(chan error, 1)
	r := newRig(t, wstunnel.Options{Window: 3 << 20, WriteTimeout: 200 * time.Millisecond, FinalTimeout: 100 * time.Millisecond}, flood(done))
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	var taken int
	for {
		f, err := c.ReadFrame(ctx)
		if err != nil {
			break // the deadline closed the socket
		}
		taken += len(f.Payload)
	}
	if taken > 4<<20 { // the window, and the message that went into its last room
		t.Errorf("%d bytes went out on a window of 3 MiB", taken)
	}
	if err := <-done; err == nil {
		t.Error("the handler's Send did not fail")
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.logs.String(), `reason="write timeout"`) {
		t.Errorf("logs: %s", r.logs.String())
	}
}

// Counts keep a stream going past its window for as long as they come.
func TestCountsReopenTheWindow(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{Window: 1 << 20, WriteTimeout: 2 * time.Second}, func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		for range 20 {
			if err := s.Send(wstunneltest.Output(make([]byte, 1<<20))); err != nil {
				return err
			}
		}
		return nil
	})
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	var taken int64
	for range 20 {
		_, b, err := c.Conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		taken += int64(len(b))
		if err := c.Ack(ctx, taken); err != nil {
			t.Fatal(err)
		}
	}
	f, err := c.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if !f.End() {
		t.Errorf("flags = %d, want the end of stream", f.Flags)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Errorf("close = %v", code)
	}
}

// A count that is no count is data past the request, which ends the tunnel: the bytes sent
// are the daemon's own, so no client may claim more.
func TestBadCountsCloseTheTunnel(t *testing.T) {
	for _, count := range []string{"not a number", "-1", "99999999", "1.5", ""} {
		t.Run(count, func(t *testing.T) {
			ctx := testContext(t)
			ended := make(chan struct{})
			r := newRig(t, wstunnel.Options{}, hold(ended))
			c := r.call(ctx)
			if _, err := c.ReadHead(ctx); err != nil {
				t.Fatal(err)
			}
			if err := c.Conn.Write(ctx, websocket.MessageText, []byte(count)); err != nil {
				t.Fatal(err)
			}
			waitDone(t, ended, 3*time.Second, "handler")
		})
	}
}

// A good count leaves the stream alone.
func TestCountDoesNotEndTheStream(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	f, err := c.ReadFrame(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Ack(ctx, int64(len(f.Payload)+5)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ended:
		t.Fatal("a count ended the handler")
	case <-time.After(100 * time.Millisecond):
	}
}

// PluginService.WatchSurface flushes its headers with an empty Send before its first update,
// which may wait on the plugin: the head must go out alone.
func TestHeadersFlushBeforeTheFirstMessage(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{}, func(ctx context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		if err := s.Send(nil); err != nil {
			return err
		}
		<-ctx.Done()
		return nil
	})
	c := r.call(ctx)
	if h, err := c.ReadHead(ctx); err != nil || h.Status != http.StatusOK {
		t.Fatalf("head = %+v, %v", h, err)
	}
}

// At shutdown a stuck client gets FinalTimeout, not the rest of the write deadline.
func TestStuckClientDoesNotHoldShutdown(t *testing.T) {
	ctx := testContext(t)
	done := make(chan error, 1)
	r := newRig(t, wstunnel.Options{WriteTimeout: time.Minute, FinalTimeout: 100 * time.Millisecond}, flood(done))
	r.call(ctx) // and never reads
	time.Sleep(200 * time.Millisecond)
	r.shutdown()
	start := time.Now()
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(start); d > 3*time.Second {
		t.Errorf("drained after %v", d)
	}
}

// A client that takes the end of stream but never answers the close frame does not hold
// the tunnel for the library's 5 s.
func TestClientThatNeverAnswersTheClose(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{FinalTimeout: 100 * time.Millisecond}, func(context.Context, *connect.ServerStream[v1.AttachEvent]) error { return nil })
	r.call(ctx) // and never reads, so never answers
	start := time.Now()
	for r.drainNow(ctx) != nil {
		if time.Since(start) > 3*time.Second {
			t.Fatal("tunnel still open")
		}
	}
}

// A client that leaves on purpose reads as that whatever the close says, even though the end
// of stream then fails to write; one that loses the connection does not.
func TestCloseReason(t *testing.T) {
	tests := []struct {
		name  string
		leave func(context.Context, *testing.T, *wstunneltest.Client)
		want  string
	}{
		{"a close, as a resync sends", func(_ context.Context, t *testing.T, c *wstunneltest.Client) {
			if err := c.Conn.Close(websocket.StatusNormalClosure, ""); err != nil {
				t.Fatal(err)
			}
		}, "client closed"},
		{"a page going away", func(_ context.Context, t *testing.T, c *wstunneltest.Client) {
			if err := c.Conn.Close(websocket.StatusGoingAway, ""); err != nil {
				t.Fatal(err)
			}
		}, "client closed"},
		{"data past the request", func(ctx context.Context, t *testing.T, c *wstunneltest.Client) {
			if err := c.Conn.Write(ctx, websocket.MessageBinary, []byte("more")); err != nil {
				t.Fatal(err)
			}
		}, "client closed"},
		{"a connection dropped with no close", func(_ context.Context, t *testing.T, c *wstunneltest.Client) {
			if err := c.Conn.CloseNow(); err != nil {
				t.Fatal(err)
			}
		}, "client gone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := testContext(t)
			r := newRig(t, wstunnel.Options{FinalTimeout: 100 * time.Millisecond}, hold(make(chan struct{})))
			c := r.call(ctx)
			if _, err := c.ReadHead(ctx); err != nil {
				t.Fatal(err)
			}
			tt.leave(ctx, t, c)
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Fatal(err)
			}
			if want := `reason="` + tt.want + `"`; !strings.Contains(r.logs.String(), want) {
				t.Errorf("want %s in: %s", want, r.logs.String())
			}
		})
	}
}

// A real write failure: the connection resets under a handler that is writing, with no close
// frame to read. It must not pass for a client's close or for a stuck client.
func TestResetUnderAWriteIsClientGone(t *testing.T) {
	ctx := testContext(t)
	done := make(chan error, 1)
	r := newRig(t, wstunnel.Options{FinalTimeout: 100 * time.Millisecond}, flood(done))
	var raw net.Conn
	dial := func(ctx context.Context, network, addr string) (net.Conn, error) {
		c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
		raw = c
		return c, err
	}
	httpClient := &http.Client{Transport: &http.Transport{DialContext: dial}}
	c, _, err := wstunneltest.Dial{URL: r.url(wstunneltest.Stream), Origins: []string{origin}, HTTPClient: httpClient}.Open(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Send(ctx, wstunneltest.Headers(token), requestBody(t)); err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadHead(ctx); err != nil { // the handler is writing
		t.Fatal(err)
	}
	if err := raw.(*net.TCPConn).SetLinger(0); err != nil {
		t.Fatal(err)
	}
	if err := raw.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("the handler's write did not fail")
		}
	case <-ctx.Done():
		t.Fatal("handler still pinned")
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.logs.String(), `reason="client gone"`) {
		t.Errorf("logs: %s", r.logs.String())
	}
}

// The daemon ending the stream is served, though the client answers its close frame.
func TestAnswerToTheDaemonsCloseIsServed(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{}, func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		return s.Send(wstunneltest.Output([]byte("bye")))
	})
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure { // reading answers the close
		t.Fatalf("close = %v", code)
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.logs.String(), `reason=served`) {
		t.Errorf("logs: %s", r.logs.String())
	}
}

// drainNow is Drain with a short leash.
func (r *rig) drainNow(ctx context.Context) error {
	short, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	return r.tunnel.Drain(short)
}

// One Info line each way, with the procedure and the origin; no token, no head value.
func TestLogsOpenAndClose(t *testing.T) {
	ctx := testContext(t)
	ended := make(chan struct{})
	r := newRig(t, wstunnel.Options{}, hold(ended))
	c := r.call(ctx)
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	if err := c.Conn.Close(websocket.StatusNormalClosure, ""); err != nil {
		t.Fatal(err)
	}
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	logs := r.logs.String()
	for _, want := range []string{"tunnel open", "tunnel closed", "procedure=" + wstunneltest.Stream, "origin=" + origin, "level=INFO", `reason="client closed"`} {
		if !strings.Contains(logs, want) {
			t.Errorf("logs lack %q: %s", want, logs)
		}
	}
	if strings.Contains(logs, token) {
		t.Errorf("the token reached the log: %s", logs)
	}
}
