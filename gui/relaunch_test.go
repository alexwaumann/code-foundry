package main

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/api"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/client"
	"github.com/alexwaumann/code-foundry/internal/paths"
	"github.com/alexwaumann/code-foundry/internal/store/update"
	"github.com/alexwaumann/code-foundry/internal/store/update/updatetest"
)

// serveUpdate serves UpdateService on a Unix socket in a fresh home, as the daemon
// does, and returns the paths, the store and the server.
func serveUpdate(t *testing.T) (paths.Paths, *update.Store, *http.Server) {
	t.Helper()
	home, err := os.MkdirTemp("/tmp", "cf-relaunch-") // short: sun_path is 104 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(home) })
	p := paths.New(home)

	b := bus.New()
	store := update.Start(context.Background(), update.Options{
		Current: "v0.1.0", Source: updatetest.NewSource("v0.1.0"), Installer: updatetest.NewInstaller(nil),
		InstalledVersion: updatetest.NewOnDisk("v0.1.0").Version, Bus: b, InitialDelay: time.Hour,
	})
	t.Cleanup(store.Close)
	route := api.NewUpdate(store, b, nil).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	ln, err := net.Listen("unix", p.Socket())
	if err != nil {
		t.Fatal(err)
	}
	var protocols http.Protocols
	protocols.SetHTTP1(true)
	protocols.SetUnencryptedHTTP2(true)
	srv := &http.Server{Handler: mux, Protocols: &protocols}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return p, store, srv
}

// TestWatchRelaunch checks against a served UpdateService that the host's watcher
// relaunches exactly once per request.
func TestWatchRelaunch(t *testing.T) {
	p, store, _ := serveUpdate(t)

	var relaunches atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connect := func(context.Context) (*client.Client, error) { return client.New(p), nil }
	go watchRelaunch(ctx, connect, slog.New(slog.DiscardHandler), func() { relaunches.Add(1) })

	// Wait for the watcher's stream to be subscribed: the request is then delivered.
	deadline := time.Now().Add(5 * time.Second)
	for store.RequestRelaunch() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("watcher never subscribed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	for relaunches.Load() != 1 {
		if time.Now().After(deadline) {
			t.Fatalf("relaunches = %d, want 1", relaunches.Load())
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Status changes alone never relaunch.
	if _, err := store.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	if n := relaunches.Load(); n != 1 {
		t.Fatalf("relaunches = %d after a status change, want 1", n)
	}
}

// TestWatchRelaunchAfterRestart: on restart_requested the watcher waits for the daemon
// to go away (here: the server closes), then relaunches once and stops watching.
func TestWatchRelaunchAfterRestart(t *testing.T) {
	p, store, srv := serveUpdate(t)

	var relaunches atomic.Int32
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	connect := func(context.Context) (*client.Client, error) { return client.New(p), nil }
	done := make(chan struct{})
	go func() {
		defer close(done)
		watchRelaunch(ctx, connect, slog.New(slog.DiscardHandler), func() { relaunches.Add(1) })
	}()

	deadline := time.Now().Add(5 * time.Second)
	for store.RequestRestart() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("watcher never subscribed")
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(100 * time.Millisecond)
	if n := relaunches.Load(); n != 0 {
		t.Fatalf("relaunched %d times while the daemon was still up, want 0", n)
	}
	_ = srv.Close() // the daemon exits
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("watcher did not stop after relaunching")
	}
	if n := relaunches.Load(); n != 1 {
		t.Fatalf("relaunches = %d, want 1", n)
	}
}

// fakeStream is an updateStream fed from events; closing events ends it like the
// daemon exiting. Ending the context it was opened with ends it too.
type fakeStream struct {
	ctx    context.Context
	events <-chan *v1.UpdateEvent
	msg    *v1.UpdateEvent
}

func (s *fakeStream) Receive() bool {
	select {
	case ev, ok := <-s.events:
		if !ok {
			return false
		}
		s.msg = ev
		return true
	case <-s.ctx.Done():
		return false
	}
}

func (s *fakeStream) Msg() *v1.UpdateEvent { return s.msg }
func (s *fakeStream) Err() error           { return nil }
func (s *fakeStream) Close() error         { return nil }

func relaunchEvent() *v1.UpdateEvent {
	return &v1.UpdateEvent{Event: &v1.UpdateEvent_RelaunchRequested{RelaunchRequested: &v1.RelaunchRequested{}}}
}

func restartEvent() *v1.UpdateEvent {
	return &v1.UpdateEvent{Event: &v1.UpdateEvent_RestartRequested{RestartRequested: &v1.RestartRequested{}}}
}

func statusEvent() *v1.UpdateEvent {
	return &v1.UpdateEvent{Event: &v1.UpdateEvent_Status{Status: &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_INSTALLED}}}
}

// syncBuffer is a goroutine-safe log sink.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

func TestRelaunchWatcherOnce(t *testing.T) {
	tests := []struct {
		name   string
		events []*v1.UpdateEvent
		// end closes the stream after the events (the daemon exits).
		end bool
		// quit cancels the watcher's context after the events (the app quits).
		quit bool
		// beforeEnd is the relaunch count once the events are handled, before the end.
		beforeEnd     int
		wantRelaunch  int
		wantRestarted bool
		wantWarn      bool
	}{
		{"status only", []*v1.UpdateEvent{statusEvent()}, true, false, 0, 0, false, false},
		{"relaunch request relaunches at once", []*v1.UpdateEvent{relaunchEvent()}, true, false, 1, 1, false, false},
		{"restart waits for the stream to end", []*v1.UpdateEvent{statusEvent(), restartEvent()}, true, false, 0, 1, true, false},
		{"repeated restart relaunches once", []*v1.UpdateEvent{restartEvent(), restartEvent()}, true, false, 0, 1, true, false},
		{"restart relaunches anyway after the bound", []*v1.UpdateEvent{restartEvent()}, false, false, 0, 1, true, true},
		{"app quitting while waiting does not relaunch", []*v1.UpdateEvent{restartEvent()}, false, true, 0, 0, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			events := make(chan *v1.UpdateEvent)
			var relaunches atomic.Int32
			logs := &syncBuffer{}
			w := relaunchWatcher{
				open: func(ctx context.Context) (updateStream, error) {
					return &fakeStream{ctx: ctx, events: events}, nil
				},
				log:         slog.New(slog.NewTextHandler(logs, nil)),
				relaunch:    func() { relaunches.Add(1) },
				restartWait: 300 * time.Millisecond,
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			type result struct {
				restarted bool
				err       error
			}
			res := make(chan result, 1)
			go func() {
				r, err := w.once(ctx)
				res <- result{r, err}
			}()
			for _, ev := range tt.events {
				events <- ev // unbuffered: returns once the watcher took it
			}
			time.Sleep(50 * time.Millisecond) // let it act on the last event
			if n := int(relaunches.Load()); n != tt.beforeEnd {
				t.Fatalf("relaunches before the end = %d, want %d", n, tt.beforeEnd)
			}
			if tt.end {
				close(events)
			}
			if tt.quit {
				cancel()
			}
			var got result
			select {
			case got = <-res:
			case <-time.After(5 * time.Second):
				t.Fatal("once did not return")
			}
			if got.err != nil || got.restarted != tt.wantRestarted {
				t.Fatalf("once = %v, %v; want %v, nil", got.restarted, got.err, tt.wantRestarted)
			}
			if n := int(relaunches.Load()); n != tt.wantRelaunch {
				t.Fatalf("relaunches = %d, want %d", n, tt.wantRelaunch)
			}
			if warned := strings.Contains(logs.String(), "relaunching anyway"); warned != tt.wantWarn {
				t.Fatalf("warned = %v, want %v; logs:\n%s", warned, tt.wantWarn, logs)
			}
		})
	}
}

// TestRelaunchWatcherRun: a stream that just ends is reconnected; after a restart
// relaunch the watcher stops.
func TestRelaunchWatcherRun(t *testing.T) {
	var opens atomic.Int32
	var relaunches atomic.Int32
	w := relaunchWatcher{
		open: func(ctx context.Context) (updateStream, error) {
			events := make(chan *v1.UpdateEvent, 1)
			if opens.Add(1) == 2 {
				events <- restartEvent()
			}
			close(events)
			return &fakeStream{ctx: ctx, events: events}, nil
		},
		log:         slog.New(slog.DiscardHandler),
		relaunch:    func() { relaunches.Add(1) },
		retry:       time.Millisecond,
		restartWait: time.Minute,
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		w.run(context.Background())
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not stop after the restart relaunch")
	}
	if o, r := opens.Load(), relaunches.Load(); o != 2 || r != 1 {
		t.Fatalf("opens = %d, relaunches = %d; want 2, 1", o, r)
	}
}
