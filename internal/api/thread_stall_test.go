package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// threadWatchIdleBudget is how long an idle ThreadService.Watch may stay silent in the
// fix (docs/notes/thread-render-stall.md, cause 1): HeartbeatInterval plus slack.
const threadWatchIdleBudget = 8 * time.Second

// TestThreadWatchIdleHeartbeat: an idle Watch sends a heartbeat. After the Wails
// window was hidden, minimized or covered, WKWebView holds the last bytes of a streaming
// response until more bytes arrive (reproduced live; see the note). A Watch that goes
// quiet after a turn's last events (the turn ended, or a long tool call started) then
// leaves the thread showing a stale tail indefinitely. Bytes on an idle stream release
// the held tail, and give the client something to detect a dead stream with.
func TestThreadWatchIdleHeartbeat(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Session{ID: "s1", State: thread.StateConnected})
	fake.PutItems("s1", thread.Item{ID: "u1", Kind: thread.KindUserMessage, Text: "hi"})
	ctx, cancel := context.WithTimeout(context.Background(), threadWatchIdleBudget+5*time.Second)
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchThreadRequest{SessionId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	got := make(chan bool, 1)
	go func() { got <- stream.Receive() }()
	select {
	case ok := <-got:
		if !ok {
			t.Fatalf("stream ended: %v", stream.Err())
		}
	case <-time.After(threadWatchIdleBudget):
		t.Fatalf("an idle Watch sent nothing for %s after its snapshot: no heartbeat", threadWatchIdleBudget)
	}
}
