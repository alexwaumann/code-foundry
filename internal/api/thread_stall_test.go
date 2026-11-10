package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// TestThreadWatchIdleHeartbeat: an idle WatchThread sends a heartbeat once the snapshot's
// flushes are spent. After the Wails window was hidden, minimized or covered, WKWebView
// holds the last bytes of a streaming response until more bytes arrive (reproduced live;
// see docs/notes/thread-render-stall.md). A WatchThread that goes quiet after a turn's
// last events (the turn ended, or a long tool call started) then leaves the thread
// showing a stale tail indefinitely. Bytes on an idle stream release the held tail, and
// give the client something to detect a dead stream with. The interval is shortened so
// that a heartbeat sent at HeartbeatInterval instead misses the budget.
func TestThreadWatchIdleHeartbeat(t *testing.T) {
	const every = 100 * time.Millisecond
	const budget = 2 * time.Second
	b := bus.New()
	fake := threadtest.New(b)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi"})
	srv := serveOnce(t, (&Thread{store: fake, bus: b, beat: every}).Route(), make(chan struct{}))
	c := codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), budget+5*time.Second)
	defer cancel()
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	for range snapshotFlushes {
		if !stream.Receive() || stream.Msg().GetHeartbeat() == nil {
			t.Fatalf("want a flush heartbeat, got %v (%v)", stream.Msg(), stream.Err())
		}
	}
	got := make(chan bool, 1)
	go func() { got <- stream.Receive() && stream.Msg().GetHeartbeat() != nil }()
	select {
	case ok := <-got:
		if !ok {
			t.Fatalf("want a heartbeat, got %v (%v)", stream.Msg(), stream.Err())
		}
	case <-time.After(budget):
		t.Fatalf("an idle WatchThread sent nothing for %s after its flushes: no heartbeat", budget)
	}
}
