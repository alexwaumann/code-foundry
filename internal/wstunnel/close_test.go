package wstunnel_test

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"runtime/pprof"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"connectrpc.com/connect"
	"github.com/coder/websocket"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/wstunnel"
	"github.com/alexwaumann/code-foundry/internal/wstunnel/wstunneltest"
)

// countStep is ACK_BYTES in api/wsFetch.ts.
const countStep = 2 << 20

// sendBytes is a handler that sends n bytes of output in 64 KiB messages and returns.
func sendBytes(n int) handler {
	return func(_ context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		chunk := make([]byte, 64<<10)
		for sent := 0; sent < n; sent += len(chunk) {
			if err := s.Send(wstunneltest.Output(chunk)); err != nil {
				return err
			}
		}
		return nil
	}
}

// pageResult is what a page got of a stream.
type pageResult struct {
	end   bool
	close websocket.StatusCode
}

// readAsPage is WebKit as measured (docs/notes/tunnel-close-drain.md), which a Go client does not
// do by itself: the network side takes frames off the socket and answers the close frame ahead of
// the page, and a count the page sends after that fails the socket, with close 1006 and whatever
// the page had not taken lost. The page counts as wsFetch does. With behind it starts only once
// the socket has gone quiet, so it is as far behind as the daemon lets it be.
func readAsPage(ctx context.Context, c *wstunneltest.Client, behind bool) pageResult {
	queue := make(chan []byte, 1<<12)
	var closeSeen atomic.Bool
	var last atomic.Int64
	last.Store(time.Now().UnixNano())
	var code websocket.StatusCode
	go func() {
		defer close(queue)
		for {
			typ, b, err := c.Conn.Read(ctx)
			if err != nil {
				code = websocket.CloseStatus(err)
				closeSeen.Store(true)
				return
			}
			last.Store(time.Now().UnixNano())
			if typ == websocket.MessageBinary {
				queue <- b
			}
		}
	}()
	for behind && !closeSeen.Load() && time.Since(time.Unix(0, last.Load())) < 50*time.Millisecond {
		time.Sleep(time.Millisecond)
	}
	var got pageResult
	var received, told int64
	for b := range queue {
		received += int64(len(b))
		got.end = got.end || b[0]&wstunneltest.EndStream != 0
		if received-told < countStep {
			continue
		}
		told = received
		if closeSeen.Load() {
			return pageResult{close: 1006}
		}
		if err := c.Ack(ctx, received); err != nil {
			return pageResult{close: -1}
		}
	}
	got.close = code
	return got
}

// A stream ending while a count is due reaches a page that is behind whole: no close frame crosses
// a count. A flood lost about 5% of its ends this way, as dead sockets.
func TestCloseFrameWaitsForTheLastCount(t *testing.T) {
	tests := []struct {
		name   string
		bytes  int
		behind bool
	}{
		{"a page behind by one count", countStep + countStep/4, true},
		{"a page behind by two counts", 2*countStep + countStep/4, true},
		{"a page behind on a stream that ends on a step", countStep, true},
		{"a page keeping up", 2*countStep + countStep/4, false},
		{"a stream too short to count", countStep / 2, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := testContext(t)
			r := newRig(t, wstunnel.Options{FinalTimeout: 5 * time.Second}, sendBytes(tt.bytes))
			c := r.call(ctx)
			if _, err := c.ReadHead(ctx); err != nil {
				t.Fatal(err)
			}
			got := readAsPage(ctx, c, tt.behind)
			if !got.end || got.close != websocket.StatusNormalClosure {
				t.Fatalf("end of stream = %v, close = %v; want it delivered and a 1000", got.end, got.close)
			}
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(r.logs.String(), "reason=served") {
				t.Errorf("logs: %s", r.logs.String())
			}
		})
	}
}

// A stream with no count due closes at once, whatever the deadline.
func TestNoCountDueClosesAtOnce(t *testing.T) {
	ctx := testContext(t)
	r := newRig(t, wstunnel.Options{FinalTimeout: 10 * time.Second}, sendBytes(countStep-(128<<10)))
	c := r.call(ctx) // never counts
	start := time.Now()
	if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
		t.Fatalf("close = %v", code)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Errorf("closed after %v", d)
	}
}

// readAllBody takes the head and the body up to the end of stream, and says how many bytes that
// was: what a client has when it owes the daemon its last count.
func readAllBody(ctx context.Context, t *testing.T, c *wstunneltest.Client) int64 {
	t.Helper()
	if _, err := c.ReadHead(ctx); err != nil {
		t.Fatal(err)
	}
	var n int64
	for {
		_, b, err := c.Conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		n += int64(len(b))
		if b[0]&wstunneltest.EndStream != 0 {
			return n
		}
	}
}

// A stream that finished is served, whatever the client does while the daemon waits for its count:
// its close frame there is not its leaving early. Each of these ends the wait at once, except the
// count's silence, which costs the deadline.
func TestReasonWhileWaitingForTheLastCount(t *testing.T) {
	const final = 2 * time.Second
	tests := []struct {
		name  string
		leave func(context.Context, *testing.T, *wstunneltest.Client, int64)
		slow  bool
	}{
		{"the count, then the close answered", func(ctx context.Context, t *testing.T, c *wstunneltest.Client, n int64) {
			if err := c.Ack(ctx, n); err != nil {
				t.Fatal(err)
			}
			if code := c.ReadClose(ctx); code != websocket.StatusNormalClosure {
				t.Errorf("close = %v", code)
			}
		}, false},
		{"a close frame", func(_ context.Context, t *testing.T, c *wstunneltest.Client, _ int64) {
			if err := c.Conn.Close(websocket.StatusNormalClosure, ""); err != nil {
				t.Fatal(err)
			}
		}, false},
		{"data past the request", func(ctx context.Context, t *testing.T, c *wstunneltest.Client, _ int64) {
			if err := c.Conn.Write(ctx, websocket.MessageBinary, []byte("more")); err != nil {
				t.Fatal(err)
			}
			c.ReadClose(ctx)
		}, false},
		{"a connection dropped", func(_ context.Context, t *testing.T, c *wstunneltest.Client, _ int64) {
			if err := c.Conn.CloseNow(); err != nil {
				t.Fatal(err)
			}
		}, false},
		{"silence", func(context.Context, *testing.T, *wstunneltest.Client, int64) {}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ctx := testContext(t)
			r := newRig(t, wstunnel.Options{FinalTimeout: final}, sendBytes(countStep+countStep/4))
			c := r.call(ctx)
			n := readAllBody(ctx, t, c)
			start := time.Now()
			tt.leave(ctx, t, c, n)
			if err := r.tunnel.Drain(ctx); err != nil {
				t.Fatal(err)
			}
			if d := time.Since(start); tt.slow != (d >= final/2) {
				t.Errorf("tunnel ended after %v (final timeout %v)", d, final)
			}
			if !strings.Contains(r.logs.String(), "reason=served") {
				t.Errorf("logs: %s", r.logs.String())
			}
		})
	}
}

// rawFrame is one masked client frame, its key zero so the payload goes as it is.
func rawFrame(opcode byte, payload []byte) []byte {
	h := []byte{0x80 | opcode, 0x80 | 127}
	h = binary.BigEndian.AppendUint64(h, uint64(len(payload)))
	h = append(h, 0, 0, 0, 0)
	return append(h, payload...)
}

// A client that owes a count, takes everything and answers nothing cannot hold the tunnel past the
// two deadlines, the count's and the close's, and leaves no goroutine behind.
func TestClientThatNeverCountsNorAnswersTheClose(t *testing.T) {
	const final = 200 * time.Millisecond
	ctx := testContext(t)
	returned := make(chan time.Time, 1)
	send := sendBytes(countStep + countStep/4)
	r := newRig(t, wstunnel.Options{FinalTimeout: final}, func(ctx context.Context, s *connect.ServerStream[v1.AttachEvent]) error {
		defer func() { returned <- time.Now() }()
		return send(ctx, s)
	})
	c := rawUpgrade(t, r)
	head, err := json.Marshal(map[string]any{"headers": wstunneltest.Headers(token)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Write(append(rawFrame(1, head), rawFrame(2, requestBody(t))...)); err != nil {
		t.Fatal(err)
	}
	taken := make(chan struct{})
	go func() {
		defer close(taken)
		_, _ = io.Copy(io.Discard, c)
	}()
	if err := r.tunnel.Drain(ctx); err != nil {
		t.Fatal(err)
	}
	if d := time.Since(<-returned); d > 2*final+time.Second {
		t.Errorf("tunnel ended %v after the handler (final timeout %v)", d, final)
	}
	waitDone(t, taken, 2*time.Second, "the daemon closing the connection")
	if !strings.Contains(r.logs.String(), "reason=served") {
		t.Errorf("logs: %s", r.logs.String())
	}
	waitNoReader(t)
}

// waitNoReader fails the test if a tunnel's read loop outlives its tunnel by more than a moment:
// it is only ever ended by the connection closing, which is what ends the tunnel.
func waitNoReader(t *testing.T) {
	t.Helper()
	var stacks bytes.Buffer
	for start := time.Now(); time.Since(start) < time.Second; time.Sleep(5 * time.Millisecond) {
		stacks.Reset()
		if err := pprof.Lookup("goroutine").WriteTo(&stacks, 1); err != nil {
			t.Fatal(err)
		}
		if !bytes.Contains(stacks.Bytes(), []byte("wstunnel.readUntilGone")) {
			return
		}
	}
	t.Errorf("a read loop is still running:\n%s", stacks.String())
}
