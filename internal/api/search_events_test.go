package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/search"
)

type fakeSearchActivity struct{ a search.Activity }

func (f fakeSearchActivity) Activity() search.Activity { return f.a }

// The search source: the state on connect, then each published activity, whole.
func TestSearchEventSource(t *testing.T) {
	b := bus.New()
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	st := fakeSearchActivity{a: search.Activity{Running: 2, RunningID: "q-run"}}
	route := NewEvents(EventsDeps{Bus: b, Search: st, Done: done}).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	cl := codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	stream, err := cl.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_SEARCH}}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.Event {
		t.Helper()
		for stream.Receive() {
			if m := stream.Msg(); m.GetHeartbeat() == nil {
				return m
			}
		}
		t.Fatalf("stream ended: %v", stream.Err())
		return nil
	}
	snap := next()
	if a := snap.GetSearch(); snap.GetSeq() != 0 || a.GetRunning() != 2 || a.GetRunningId() != "q-run" || a.GetUnseenId() != "" {
		t.Errorf("snapshot = %v", snap)
	}
	bus.Publish(b, search.Activity{UnseenID: "q-end", UnseenStatus: search.StatusFailed, UnseenHits: 3})
	live := next()
	a := live.GetSearch()
	if live.GetSeq() == 0 || a.GetRunning() != 0 || a.GetRunningId() != "" || a.GetUnseenId() != "q-end" ||
		a.GetUnseenStatus() != v1.SearchStatus_SEARCH_STATUS_FAILED || a.GetUnseenHits() != 3 {
		t.Errorf("live = %v", live)
	}
}
