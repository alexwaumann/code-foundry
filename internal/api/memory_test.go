package api

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/memory"
)

var memoryT0 = time.Date(2026, 10, 22, 14, 3, 11, 0, time.UTC)

// newMemoryServer serves MemoryService and EventService (the memory source only) over
// a memory store holding one entry a thread added.
func newMemoryServer(t *testing.T) (*memory.Store, codefoundryv1connect.MemoryServiceClient, codefoundryv1connect.EventServiceClient) {
	t.Helper()
	b := bus.New()
	s := memory.New(memory.Options{Dir: filepath.Join(t.TempDir(), "memory"), Bus: b, Log: slog.New(slog.DiscardHandler),
		Now: func() time.Time { return memoryT0 }})
	if _, err := s.Add("Always open PRs as drafts", memory.Origin{ThreadID: "s-1", ThreadName: "Fix login"}); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	mux := http.NewServeMux()
	for _, r := range []Route{NewMemory(s, b).Route(), NewEvents(EventsDeps{Bus: b, Memory: s, Done: done}).Route()} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return s, codefoundryv1connect.NewMemoryServiceClient(srv.Client(), srv.URL), codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
}

func TestMemoryGet(t *testing.T) {
	s, c, _ := newMemoryServer(t)
	res, err := c.Get(context.Background(), connect.NewRequest(&v1.GetMemoryRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg.GetMemory()
	if m.GetMaxEntries() != 40 || m.GetMaxBytes() != 4096 || m.GetMaxEntryChars() != 500 || m.GetDir() != s.Dir() ||
		m.GetInjected() != 1 || m.GetInjectedBytes() != int32(len("- Always open PRs as drafts\n")) || m.GetError() != "" {
		t.Errorf("snapshot = %v", m)
	}
	if len(m.GetEntries()) != 1 {
		t.Fatalf("entries = %v", m.GetEntries())
	}
	e := m.GetEntries()[0]
	if e.GetIndex() != 1 || e.GetText() != "Always open PRs as drafts" || e.GetFile() != "always-open-prs-as-drafts.md" ||
		!e.GetCreated().AsTime().Equal(memoryT0) || e.GetThreadId() != "s-1" || e.GetThreadName() != "Fix login" || !e.GetInjected() {
		t.Errorf("entry = %v", e)
	}
	// Get reads the directory now: a file added by hand is there, with no provenance.
	if err := os.WriteFile(filepath.Join(s.Dir(), "hand.md"), []byte("Keep it short\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	res, err = c.Get(context.Background(), connect.NewRequest(&v1.GetMemoryRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if es := res.Msg.GetMemory().GetEntries(); len(es) != 2 || es[1].GetCreated() != nil || es[1].GetThreadId() != "" {
		t.Errorf("after a hand edit: %v", es)
	}
}

func TestMemoryWatch(t *testing.T) {
	s, c, _ := newMemoryServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchMemoryRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.MemorySnapshot {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg().GetSnapshot()
	}
	first := next()
	if len(first.GetEntries()) != 1 || first.GetVersion() == 0 {
		t.Fatalf("first = %v", first)
	}
	if _, err := s.Remove("1", ""); err != nil {
		t.Fatal(err)
	}
	if m := next(); len(m.GetEntries()) != 0 || m.GetVersion() != first.GetVersion()+1 {
		t.Errorf("after remove = %v", m)
	}
}

func TestMemoryEventSource(t *testing.T) {
	s, _, ev := newMemoryServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := ev.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_MEMORY}}))
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
	if snap.GetSeq() != 0 || len(snap.GetMemory().GetSnapshot().GetEntries()) != 1 {
		t.Fatalf("snapshot event = %v", snap)
	}
	if _, err := s.Add("Keep it short", memory.Origin{}); err != nil {
		t.Fatal(err)
	}
	live := next()
	if live.GetSeq() == 0 || len(live.GetMemory().GetSnapshot().GetEntries()) != 2 {
		t.Errorf("live event = %v", live)
	}
	if memoryEventToProto(nil, "") != nil {
		t.Error("a nil event converts")
	}
}
