package daemon

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// fakeNotificationThreads records what the glue asks the notification store.
type fakeNotificationThreads struct {
	gone  chan string
	swept chan func(string) bool
}

func (f *fakeNotificationThreads) ThreadGone(_ context.Context, id string) (int, error) {
	f.gone <- id
	return 1, nil
}

func (f *fakeNotificationThreads) WithdrawMissingThreads(_ context.Context, exists func(string) bool) (int, error) {
	f.swept <- exists
	return 0, nil
}

// A removed thread's notifications are withdrawn; the start sweep asks with the thread
// store's threads (an archived one exists); an archive does nothing.
func TestNotificationThreads(t *testing.T) {
	b := bus.New()
	f := &fakeNotificationThreads{gone: make(chan string, 4), swept: make(chan func(string) bool, 4)}
	snap := &thread.Snapshot{Threads: []thread.Thread{{ID: "s-live"}, {ID: "s-archived", ArchivedAt: time.Now()}}}
	stop := startNotificationThreads(context.Background(), slog.New(slog.DiscardHandler), f, func() *thread.Snapshot { return snap }, b)
	defer stop()
	wait := func() (string, func(string) bool) {
		t.Helper()
		select {
		case id := <-f.gone:
			return id, nil
		case exists := <-f.swept:
			return "", exists
		case <-time.After(5 * time.Second):
			t.Fatal("the glue did nothing")
		}
		return "", nil
	}
	_, exists := wait()
	if exists == nil || !exists("s-live") || !exists("s-archived") || exists("s-removed") {
		t.Fatal("the start sweep's exists does not follow the thread store")
	}
	bus.Publish[thread.Event](b, thread.Updated{Thread: thread.Thread{ID: "s-archived", ArchivedAt: time.Now()}})
	bus.Publish[thread.Event](b, thread.Removed{ID: "s-removed"})
	if id, _ := wait(); id != "s-removed" {
		t.Errorf("withdrew %q, want s-removed (and nothing for the archive)", id)
	}
}
