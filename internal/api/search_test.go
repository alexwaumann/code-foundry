package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/search"
)

// fakeSearchStore answers Get with its entry; the rest is unused.
type fakeSearchStore struct {
	SearchStore
	mu sync.Mutex
	e  search.Entry
}

func (f *fakeSearchStore) Get(string) (search.Entry, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.e, nil
}

func (f *fakeSearchStore) set(e search.Entry) {
	f.mu.Lock()
	f.e = e
	f.mu.Unlock()
}

// Watch: the snapshot, then each event in version order; a gap (a dropped event) sends a
// snapshot instead; the status ends the stream. A finished search is its snapshot alone.
func TestSearchWatch(t *testing.T) {
	b := bus.New()
	st := &fakeSearchStore{e: search.Entry{ID: "q-1", Mode: search.ModeAgent, Status: search.StatusRunning, Version: 3}}
	h := NewSearch(st, b)
	h.beat = time.Hour
	route := h.Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	cl := codefoundryv1connect.NewSearchServiceClient(srv.Client(), srv.URL)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := cl.Watch(ctx, connect.NewRequest(&v1.WatchSearchRequest{Id: "q-1"}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || stream.Msg().GetSnapshot().GetVersion() != 3 {
		t.Fatalf("first = %v, %v", stream.Msg(), stream.Err())
	}
	step := search.Step{Index: 0, Kind: search.StepSearch, Text: "Searching x…", Query: "x"}
	bus.Publish(b, search.Changed{ID: "q-other", Version: 4, Kind: search.EventStep, Step: step}) // another search
	bus.Publish(b, search.Changed{ID: "q-1", Version: 3, Kind: search.EventStep, Step: step})     // in the snapshot already
	bus.Publish(b, search.Changed{ID: "q-1", Version: 4, Kind: search.EventStep, Step: step})
	bus.Publish(b, search.Changed{ID: "q-1", Version: 5, Kind: search.EventHit, Hit: search.Hit{N: 1, ThreadID: "s-1", Quote: "q"}})
	// Version 6 is lost: 7 comes as a snapshot of the entry now.
	st.set(search.Entry{ID: "q-1", Mode: search.ModeAgent, Status: search.StatusRunning, Version: 7, Answer: "A"})
	bus.Publish(b, search.Changed{ID: "q-1", Version: 7, Kind: search.EventAnswer, Answer: "A"})
	done := search.Entry{ID: "q-1", Mode: search.ModeAgent, Status: search.StatusDone, Version: 8, Unseen: true, CostUSD: 0.5}
	bus.Publish(b, search.Changed{ID: "q-1", Version: 8, Kind: search.EventStatus, Entry: done})
	var got []string
	for stream.Receive() {
		m := stream.Msg()
		switch {
		case m.GetStep() != nil:
			got = append(got, "step:"+m.GetStep().GetText())
		case m.GetHit() != nil:
			got = append(got, "hit")
		case m.GetSnapshot() != nil:
			got = append(got, "snapshot:"+m.GetSnapshot().GetAnswer())
		case m.GetStatus() != nil:
			if m.GetStatus().GetStatus() != v1.SearchStatus_SEARCH_STATUS_DONE || !m.GetStatus().GetUnseen() || m.GetStatus().GetCostUsd() != 0.5 {
				t.Errorf("status = %v", m.GetStatus())
			}
			got = append(got, "status")
		}
		if m.GetVersion() == 0 {
			t.Errorf("no version on %v", m)
		}
	}
	if err := stream.Err(); err != nil {
		t.Fatal(err)
	}
	want := []string{"step:Searching x…", "hit", "snapshot:A", "status"}
	if len(got) != len(want) {
		t.Fatalf("events = %q, want %q", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("events = %q, want %q", got, want)
		}
	}
	// Finished: the snapshot, then the end.
	st.set(done)
	stream, err = cl.Watch(ctx, connect.NewRequest(&v1.WatchSearchRequest{Id: "q-1"}))
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for stream.Receive() {
		n++
	}
	if n != 1 || stream.Err() != nil {
		t.Errorf("finished watch = %d messages, %v", n, stream.Err())
	}
}
