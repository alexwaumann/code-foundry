package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/internal/store/thread/threadtest"
)

// newWakeServer is newThreadServer with the wake list's refresh set to every.
func newWakeServer(t *testing.T, every time.Duration) (*threadtest.Fake, codefoundryv1connect.ThreadServiceClient) {
	t.Helper()
	b := bus.New()
	fake := threadtest.New(b)
	h := NewThread(fake, b)
	h.wakes = every
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewThreadServiceClient(srv.Client(), srv.URL)
}

// wakeTargets are the target ids of a list.
func wakeTargets(subs []*v1.ThreadSubscription) []string {
	out := make([]string, len(subs))
	for i, s := range subs {
		out[i] = s.GetTargetId()
	}
	return out
}

// nextWakes reads the stream to the next wake list frame, past heartbeats and items.
func nextWakes(t *testing.T, stream *connect.ServerStreamForClient[v1.ThreadEvent]) *v1.ThreadSubscriptionsChange {
	t.Helper()
	for stream.Receive() {
		if w := stream.Msg().GetSubscriptions(); w != nil {
			return w
		}
	}
	t.Fatalf("stream ended: %v", stream.Err())
	return nil
}

// The snapshot carries the list; a frame follows every change of this thread's, the
// whole list, and none for another thread's.
func TestWatchThreadWakeList(t *testing.T) {
	fake, c := newThreadServer(t)
	for _, id := range []string{"s1", "s2", "s3"} {
		fake.Put(thread.Thread{ID: id, State: thread.StateConnected})
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	first, err := fake.Subscribe(ctx, thread.SubscribeOptions{SubscriberID: "s1", TargetThreadID: "s2"})
	if err != nil {
		t.Fatal(err)
	}
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	if got := wakeTargets(stream.Msg().GetSnapshot().GetSubscriptions()); !slices.Equal(got, []string{"s2"}) {
		t.Fatalf("snapshot's list %v", got)
	}

	// Another thread's change sends nothing: the next frame is the one after it.
	if _, err := fake.Subscribe(ctx, thread.SubscribeOptions{SubscriberID: "s3", TargetThreadID: "s2"}); err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Subscribe(ctx, thread.SubscribeOptions{SubscriberID: "s1", TargetThreadID: "s3"}); err != nil {
		t.Fatal(err)
	}
	w := nextWakes(t, stream)
	if got := wakeTargets(w.GetSubscriptions()); w.GetThreadId() != "s1" || !slices.Equal(got, []string{"s2", "s3"}) {
		t.Fatalf("after a subscribe: %s %v", w.GetThreadId(), got)
	}
	if _, err := fake.Unsubscribe(ctx, thread.UnsubscribeOptions{ID: first.Subscription.ID}); err != nil {
		t.Fatal(err)
	}
	if got := wakeTargets(nextWakes(t, stream).GetSubscriptions()); !slices.Equal(got, []string{"s3"}) {
		t.Fatalf("after an unsubscribe: %v", got)
	}
	if _, err := c.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: "s1"})); err != nil {
		t.Fatal(err)
	}
	if got := nextWakes(t, stream).GetSubscriptions(); len(got) != 0 {
		t.Fatalf("after stop waiting: %v", got)
	}
}

// A target's status changes with no event for the list: the feed's look finds it, and
// sends nothing while nothing changed.
func TestWatchThreadWakeListRefresh(t *testing.T) {
	fake, c := newWakeServer(t, 10*time.Millisecond)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected})
	fake.Put(thread.Thread{ID: "s2", State: thread.StateConnected, Status: thread.StatusBusy})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := fake.Subscribe(ctx, thread.SubscribeOptions{SubscriberID: "s1", TargetThreadID: "s2", Condition: thread.CondError}); err != nil {
		t.Fatal(err)
	}
	stream, err := c.WatchThread(ctx, connect.NewRequest(&v1.WatchThreadRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = stream.Close() }()
	if !stream.Receive() || stream.Msg().GetSnapshot() == nil {
		t.Fatalf("no snapshot: %v", stream.Err())
	}
	time.Sleep(50 * time.Millisecond) // several looks, nothing changed
	fake.Put(thread.Thread{ID: "s2", State: thread.StateConnected, Status: thread.StatusError})
	w := nextWakes(t, stream)
	if got := w.GetSubscriptions()[0].GetTargetStatus(); got != thread.StatusError.String() {
		t.Fatalf("target status %q", got)
	}
}

func TestStopWaitingRPC(t *testing.T) {
	fake, c := newThreadServer(t)
	fake.Put(thread.Thread{ID: "s1", State: thread.StateConnected, BackgroundShellsRunning: 1,
		BackgroundShells: []thread.BackgroundShell{{TaskID: "b1", Command: "npm run dev"}}})
	fake.Put(thread.Thread{ID: "s2", State: thread.StateConnected})
	ctx := context.Background()
	if _, err := fake.Subscribe(ctx, thread.SubscribeOptions{SubscriberID: "s1", TargetThreadID: "s2"}); err != nil {
		t.Fatal(err)
	}
	res, err := c.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: "s1"}))
	if err != nil {
		t.Fatal(err)
	}
	if got := wakeTargets(res.Msg.GetRemoved()); !slices.Equal(got, []string{"s2"}) {
		t.Errorf("removed %v", got)
	}
	if got := res.Msg.GetStoppedShells(); len(got) != 1 || got[0].GetTaskId() != "b1" {
		t.Errorf("stopped %v", got)
	}
	if res.Msg.GetThread().GetBackgroundShellsRunning() != 0 {
		t.Errorf("thread %v", res.Msg.GetThread())
	}
	if _, err := c.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: "nope"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("unknown thread: %v", err)
	}
	fake.Put(thread.Thread{ID: "ember", Kind: thread.KindResident, ResidentName: "ember"})
	if _, err := c.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: "ember"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("a resident thread: %v", err)
	}
}
