package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/terminal/terminaltest"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

func TestHeartbeatTimer(t *testing.T) {
	const every = 40 * time.Millisecond
	fired := func(h *heartbeat, within time.Duration) bool {
		select {
		case <-h.C():
			return true
		case <-time.After(within):
			return false
		}
	}
	tests := []struct {
		name string
		run  func(t *testing.T, h *heartbeat)
	}{
		{"fires after a silent interval", func(t *testing.T, h *heartbeat) {
			if !fired(h, 5*every) {
				t.Fatal("no tick after a silent interval")
			}
		}},
		{"resets keep it quiet, then it fires", func(t *testing.T, h *heartbeat) {
			for range 8 {
				time.Sleep(every / 2)
				h.Reset()
			}
			// Eight resets every half interval: four intervals without a tick.
			select {
			case <-h.C():
				t.Fatal("ticked although reset within every interval")
			default:
			}
			if !fired(h, 5*every) {
				t.Fatal("no tick after the resets stopped")
			}
		}},
		{"a reset after a tick fires again", func(t *testing.T, h *heartbeat) {
			if !fired(h, 5*every) {
				t.Fatal("no first tick")
			}
			h.Reset()
			if !fired(h, 5*every) {
				t.Fatal("no second tick")
			}
		}},
		{"stop silences it", func(t *testing.T, h *heartbeat) {
			h.Stop()
			if fired(h, 3*every) {
				t.Fatal("ticked after Stop")
			}
		}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := newHeartbeat(every)
			defer h.Stop()
			tt.run(t, h)
		})
	}
	if got := newHeartbeat(0); got.every != HeartbeatInterval {
		t.Errorf("zero interval = %s, want HeartbeatInterval", got.every)
	}
}

// beatStream is one long-lived stream under test: msgs carries "heartbeat" or "event"
// per message received after the stream's opening snapshot(s); poke makes the daemon
// send a real event; done closes when the server handler has returned.
type beatStream struct {
	msgs chan string
	poke func(t *testing.T)
	done chan struct{}
}

// serveOnce mounts route behind a wrapper that closes done when the (single) Watch or
// Attach request's handler returns: the stream's server side ended.
func serveOnce(t *testing.T, r Route, done chan struct{}) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle(r.Path, http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		r.Handler.ServeHTTP(w, req)
		if strings.HasSuffix(req.URL.Path, "/Watch") || strings.HasSuffix(req.URL.Path, "/WatchThread") || strings.HasSuffix(req.URL.Path, "/Attach") {
			close(done)
		}
	}))
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return srv
}

// pump classifies a client stream's messages until it ends.
func pump[T any](s interface {
	Receive() bool
	Msg() *T
}, isBeat func(*T) bool) chan string {
	out := make(chan string, 1024)
	go func() {
		defer close(out)
		for s.Receive() {
			if isBeat(s.Msg()) {
				out <- "heartbeat"
			} else {
				out <- "event"
			}
		}
	}()
	return out
}

func openThreadBeats(t *testing.T, ctx context.Context, every time.Duration) beatStream {
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	done := make(chan struct{})
	srv := serveOnce(t, (&Thread{store: fake, bus: b, beat: every}).Route(), done)
	c := codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
	s, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if !s.Receive() || s.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", s.Err())
	}
	return beatStream{
		msgs: pump(s, func(m *v1.ThreadEvent) bool { return m.GetHeartbeat() != nil }),
		poke: func(t *testing.T) {
			if _, err := fake.Send(ctx, "s1", thread.Message{Text: "x"}); err != nil {
				t.Error(err)
			}
		},
		done: done,
	}
}

func openAttachBeats(t *testing.T, ctx context.Context, every time.Duration) beatStream {
	fake := terminaltest.New(nil)
	done := make(chan struct{})
	srv := serveOnce(t, (&Terminal{store: fake, beat: every}).Route(), done)
	c := codefoundryv1connect.NewTerminalServiceClient(srv.Client(), srv.URL)
	created, err := c.Create(ctx, connect.NewRequest(&v1.CreateTerminalRequest{Argv: []string{"/bin/sh"}, Cols: 80, Rows: 24}))
	if err != nil {
		t.Fatal(err)
	}
	id := created.Msg.GetTerminal().GetId()
	s, err := c.Attach(ctx, connect.NewRequest(&v1.AttachRequest{Id: id}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if !s.Receive() || s.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", s.Err())
	}
	return beatStream{
		msgs: pump(s, func(m *v1.AttachEvent) bool { return m.GetHeartbeat() != nil }),
		poke: func(t *testing.T) {
			if err := fake.Emit(id, []byte("x")); err != nil {
				t.Error(err)
			}
		},
		done: done,
	}
}

func openEventBeats(t *testing.T, ctx context.Context, every time.Duration) beatStream {
	b := bus.New()
	fake := threadtest.New(b)
	done := make(chan struct{})
	srv := serveOnce(t, (&Events{deps: EventsDeps{Bus: b, Thread: fake}, beat: every}).Route(), done)
	c := codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
	s, err := c.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_THREAD_LIST}}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	if !s.Receive() || s.Msg().GetThreadList() == nil {
		t.Fatalf("no thread snapshot: %v", s.Err())
	}
	n := 0
	return beatStream{
		msgs: pump(s, func(m *v1.Event) bool { return m.GetHeartbeat() != nil }),
		poke: func(*testing.T) {
			n++
			fake.Put(thread.Thread{ID: "s1", Name: string(rune('a' + n%26))})
		},
		done: done,
	}
}

// count drains msgs for d and counts each kind.
func count(msgs <-chan string, d time.Duration) map[string]int {
	got := map[string]int{}
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-msgs:
			if !ok {
				return got
			}
			got[m]++
		case <-deadline:
			return got
		}
	}
}

// TestStreamHeartbeats: each long-lived stream the GUI holds sends a heartbeat after an
// interval of silence, never while real events keep it busy, and stops (handler returns,
// timer stopped) when the client goes away.
func TestStreamHeartbeats(t *testing.T) {
	const every = 100 * time.Millisecond
	streams := []struct {
		name string
		open func(*testing.T, context.Context, time.Duration) beatStream
	}{
		{"ThreadService.WatchThread", openThreadBeats},
		{"TerminalService.Attach", openAttachBeats},
		{"EventService.Watch", openEventBeats},
	}
	scenarios := []struct {
		name string
		run  func(t *testing.T, s beatStream, cancel context.CancelFunc)
	}{
		{"idle stream beats every interval", func(t *testing.T, s beatStream, _ context.CancelFunc) {
			got := count(s.msgs, 4*every+every/2)
			if got["heartbeat"] < 2 || got["heartbeat"] > 5 || got["event"] != 0 {
				t.Fatalf("over 4.5 idle intervals got %v, want about 4 heartbeats and no events", got)
			}
		}},
		{"real events reset the timer", func(t *testing.T, s beatStream, _ context.CancelFunc) {
			stop := make(chan struct{})
			go func() {
				tick := time.NewTicker(every / 10)
				defer tick.Stop()
				for {
					select {
					case <-stop:
						return
					case <-tick.C:
						s.poke(t)
					}
				}
			}()
			got := count(s.msgs, 5*every)
			close(stop)
			// A busy stream would beat five times here if events did not reset the
			// timer. One is allowed: a loaded runner can starve the 10 ms ticker past an
			// interval (seen on macos-latest under -race).
			if got["heartbeat"] > 1 || got["event"] == 0 {
				t.Fatalf("while busy got %v, want events and at most one heartbeat", got)
			}
			// Quiet again: the heartbeat comes back.
			if got := count(s.msgs, 3*every); got["heartbeat"] == 0 {
				t.Fatalf("after the events stopped got %v, want a heartbeat", got)
			}
		}},
		{"client cancel ends the stream", func(t *testing.T, s beatStream, cancel context.CancelFunc) {
			cancel()
			select {
			case <-s.done:
			case <-time.After(2 * time.Second):
				t.Fatal("handler still running after the client cancelled")
			}
		}},
	}
	for _, st := range streams {
		for _, sc := range scenarios {
			t.Run(st.name+"/"+sc.name, func(t *testing.T) {
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				sc.run(t, st.open(t, ctx, every), cancel)
			})
		}
	}
}

// TestThreadWatchHeartbeatKeepsSeq: heartbeats carry no seq and do not advance it; the
// next real event follows the snapshot's seq directly.
func TestThreadWatchHeartbeatKeepsSeq(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi"})
	srv := serveOnce(t, (&Thread{store: fake, bus: b, beat: 50 * time.Millisecond}).Route(), make(chan struct{}))
	c := codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
	s, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if !s.Receive() || s.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", s.Err())
	}
	seq := s.Msg().GetSnapshot().GetSeq()
	for range 2 {
		if !s.Receive() || s.Msg().GetHeartbeat() == nil {
			t.Fatalf("want a heartbeat, got %v (%v)", s.Msg(), s.Err())
		}
	}
	if _, err := fake.Send(ctx, "s1", thread.Message{Text: "more"}); err != nil {
		t.Fatal(err)
	}
	for s.Receive() {
		if s.Msg().GetHeartbeat() != nil {
			continue
		}
		if got := s.Msg().GetAppended().GetSeq(); got != seq+1 {
			t.Fatalf("appended seq = %d after heartbeats, want %d", got, seq+1)
		}
		return
	}
	t.Fatalf("stream ended: %v", s.Err())
}
