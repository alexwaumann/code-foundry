package api

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/usertheme"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// newThemeServer serves ThemeService and EventService (the theme source only) over a
// themes directory holding a copy of Nord, made by a thread, and a broken file.
func newThemeServer(t *testing.T) (*usertheme.Store, codefoundryv1connect.ThemeServiceClient, codefoundryv1connect.EventServiceClient) {
	t.Helper()
	b := bus.New()
	s := usertheme.New(usertheme.Options{Dir: filepath.Join(t.TempDir(), "themes"), Bus: b, Log: slog.New(slog.DiscardHandler)})
	if _, err := s.Duplicate("nord", "Nord, quieter", "s-1"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.Dir(), "broken.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	s.Load()
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	mux := http.NewServeMux()
	for _, r := range []Route{NewTheme(s, b).Route(), NewEvents(EventsDeps{Bus: b, Themes: s, Done: done}).Route()} {
		mux.Handle(r.Path, r.Handler)
	}
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return s, codefoundryv1connect.NewThemeServiceClient(srv.Client(), srv.URL), codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
}

func TestThemeList(t *testing.T) {
	s, c, _ := newThemeServer(t)
	res, err := c.List(context.Background(), connect.NewRequest(&v1.ListThemesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	m := res.Msg.GetThemes()
	if len(m.GetCurated()) != len(theme.Themes()) || m.GetCurated()[0].GetId() != "github-dark" || m.GetCurated()[0].GetPair() != "github-light" || m.GetDir() != s.Dir() || m.GetVersion() == 0 {
		t.Errorf("snapshot = %v", m)
	}
	if len(m.GetUser()) != 1 {
		t.Fatalf("user = %v", m.GetUser())
	}
	u := m.GetUser()[0]
	nord, _ := theme.Curated("nord")
	if u.GetId() != "nord-copy" || u.GetName() != "Nord, quieter" || u.GetScheme() != "dark" || u.GetFrom() != "nord" || u.GetCreatedBy() != "s-1" ||
		u.GetPath() != filepath.Join(s.Dir(), "nord-copy.json") || u.GetBase().GetAccent() != nord.Base.Accent ||
		u.GetBase().GetTerminal().GetAnsi()[15] != nord.Base.Terminal.ANSI[15] || len(u.GetBase().GetTerminal().GetAnsi()) != 16 {
		t.Errorf("user theme = %v", u)
	}
	if is := m.GetIssues(); len(is) != 1 || is[0].GetFile() != "broken.json" || is[0].GetMessage() == "" {
		t.Errorf("issues = %v", is)
	}
}

func TestThemeWatchAndEvents(t *testing.T) {
	s, c, ev := newThemeServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchThemesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	events, err := ev.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_THEME}}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.ThemeSnapshot {
		t.Helper()
		if !stream.Receive() {
			t.Fatalf("stream ended: %v", stream.Err())
		}
		return stream.Msg().GetSnapshot()
	}
	nextEvent := func() *v1.Event {
		t.Helper()
		for events.Receive() {
			if m := events.Msg(); m.GetHeartbeat() == nil {
				return m
			}
		}
		t.Fatalf("events ended: %v", events.Err())
		return nil
	}
	first := next()
	if len(first.GetUser()) != 1 {
		t.Fatalf("first = %v", first)
	}
	if e := nextEvent(); e.GetSeq() != 0 || len(e.GetTheme().GetSnapshot().GetUser()) != 1 {
		t.Fatalf("snapshot event = %v", e)
	}
	if _, err := s.Delete("nord-copy"); err != nil {
		t.Fatal(err)
	}
	if m := next(); len(m.GetUser()) != 0 || m.GetVersion() != first.GetVersion()+1 {
		t.Errorf("after delete = %v", m)
	}
	if e := nextEvent(); e.GetSeq() == 0 || len(e.GetTheme().GetSnapshot().GetUser()) != 0 {
		t.Errorf("live event = %v", e)
	}
}
