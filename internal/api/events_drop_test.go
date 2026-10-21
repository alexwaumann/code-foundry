package api

import (
	"context"
	"fmt"
	"testing"
	"time"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// After the hub's own subscription drops events, the stream must end on the store's
// state: the events still buffered behind the drop predate the resync snapshot and must
// not be applied on top of it (fuzz 2026-10-21: clients ended on n257 of n400).
func TestEventsDropDoesNotReplayStaleEvents(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	s := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_THREAD_LIST)
	evs := make(chan *v1.Event, 4096)
	go func() {
		defer close(evs)
		for s.s.Receive() {
			evs <- s.s.Msg()
		}
	}()
	view := map[string]string{}
	apply := func(ev *v1.Event) {
		tl := ev.GetThreadList()
		if snap := tl.GetSnapshot(); snap != nil {
			clear(view)
			for _, x := range snap.GetThreads() {
				view[x.GetId()] = x.GetName()
			}
		}
		if u := tl.GetUpdated(); u != nil {
			view[u.GetId()] = u.GetName()
		}
	}
	// settle applies events until none has arrived for a while.
	settle := func() {
		t.Helper()
		for {
			select {
			case ev, ok := <-evs:
				if !ok {
					t.Fatalf("stream ended: %v", s.s.Err())
				}
				apply(ev)
			case <-time.After(300 * time.Millisecond):
				return
			}
		}
	}
	settle()
	hub := f.events.eventHub()
	n := 0
	for round := range 15 {
		// Hold the hub so its tap stalls and the subscription overflows (a busy daemon).
		hub.mu.Lock()
		for range 400 {
			n++
			f.th.Put(thread.Thread{ID: "x", Name: fmt.Sprintf("n%d", n)})
		}
		hub.mu.Unlock()
		settle()
		if got, want := view["x"], fmt.Sprintf("n%d", n); got != want {
			t.Fatalf("round %d: client ended on %q, store has %q", round, got, want)
		}
	}
}
