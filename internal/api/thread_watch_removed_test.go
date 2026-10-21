package api

import (
	"context"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A thread removed while a WatchThread follows it ends the stream with NOT_FOUND, the
// error a new WatchThread gets (the GUI's runStream then stops for good); archiving or
// removing another thread does not.
func TestWatchThreadEndsOnRemoval(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.Put(thread.Thread{ID: "s2", State: thread.StateConnected})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	if _, err := fake.Archive(ctx, "s1", true); err != nil {
		t.Fatal(err)
	}
	if err := fake.Remove(ctx, "s2"); err != nil {
		t.Fatal(err)
	}
	if err := fake.Remove(ctx, "s1"); err != nil {
		t.Fatal(err)
	}
	for stream.Receive() { // heartbeats until the end
	}
	if connect.CodeOf(stream.Err()) != connect.CodeNotFound {
		t.Fatalf("stream ended with %v, want not_found", stream.Err())
	}
	again, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = again.Close() }()
	if again.Receive() || connect.CodeOf(again.Err()) != connect.CodeNotFound {
		t.Fatalf("a new watch of the removed thread: %v, want not_found", again.Err())
	}
}
