package api

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/db/dbtest"
	"github.com/alexwaumann/code-foundry/internal/store/page"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// A call from a page no thread owns names the page (UiContext.page_path), and Invoke runs
// it only while the page may use the bridge: owned or allowed. Refused and not asked are
// PermissionDenied with the page's access as a detail, whatever the GUI thought; a path
// that is no page is PageService's error; no path is not checked (a thread's page, an
// older GUI). docs/notes/page-access-live.md.
func TestInvokeChecksThePage(t *testing.T) {
	e := newPageEnv(t)
	reg := command.NewRegistry()
	ran := 0
	if err := reg.Register(command.Command{Name: "x.list", Title: "List", Category: "X", ReadOnly: true,
		Run: func(context.Context, command.Context, command.Args) (command.Result, error) {
			ran++
			return command.Result{}, nil
		}}); err != nil {
		t.Fatal(err)
	}
	h := NewCommand(reg).WithPages(e.store, e.root)
	for _, tc := range []struct {
		path   string
		code   connect.Code // 0: runs
		answer v1.PageConsent
	}{
		{"", 0, 0},
		{"owned.html", 0, 0},
		{".code-foundry/pages/t-1/own.html", 0, 0},
		{"allowed.html", 0, 0},
		{"~/allowed.html", 0, 0},
		{"refused.html", connect.CodePermissionDenied, v1.PageConsent_PAGE_CONSENT_REFUSED},
		{"new.html", connect.CodePermissionDenied, v1.PageConsent_PAGE_CONSENT_NOT_ASKED},
		{".ssh/key.html", connect.CodePermissionDenied, 0},
		{"notes.txt", connect.CodeInvalidArgument, 0},
		{"missing.html", connect.CodeNotFound, 0},
	} {
		path := tc.path
		if path != "" && path[0] != '~' {
			path = filepath.Join(e.root, path)
		}
		before := ran
		_, err := h.Invoke(context.Background(), connect.NewRequest(&v1.InvokeCommandRequest{Name: "x.list",
			Context: &v1.UiContext{Origin: v1.CallOrigin_CALL_ORIGIN_PAGE, PagePath: path}}))
		if code := connect.CodeOf(err); (tc.code == 0) != (err == nil) || (tc.code != 0 && code != tc.code) {
			t.Errorf("%q: %v, want code %v", tc.path, err, tc.code)
		}
		if want := before + map[bool]int{true: 1}[tc.code == 0]; ran != want {
			t.Errorf("%q: ran %d times, want %d", tc.path, ran-before, want-before)
		}
		var ce *connect.Error
		if tc.answer != 0 && connect.CodeOf(err) == connect.CodePermissionDenied {
			if !asConnect(err, &ce) {
				t.Fatalf("%q: not a connect error", tc.path)
			}
			got := pageAccessDetail(t, ce)
			if got.GetConsent() != tc.answer || got.GetPath() != filepath.Join(e.root, tc.path) {
				t.Errorf("%q: detail %v, want consent %v", tc.path, got, tc.answer)
			}
		}
	}
	// Without a page store the path is not checked (a daemon composed without one).
	if _, err := NewCommand(reg).Invoke(context.Background(), connect.NewRequest(&v1.InvokeCommandRequest{Name: "x.list",
		Context: &v1.UiContext{Origin: v1.CallOrigin_CALL_ORIGIN_PAGE, PagePath: filepath.Join(e.root, "refused.html")}})); err != nil {
		t.Errorf("no page store: %v", err)
	}
}

func asConnect(err error, ce **connect.Error) bool { return errors.As(err, ce) }

func pageAccessDetail(t *testing.T, ce *connect.Error) *v1.PageAccess {
	t.Helper()
	for _, d := range ce.Details() {
		v, err := d.Value()
		if err != nil {
			t.Fatal(err)
		}
		if a, ok := v.(*v1.PageAccess); ok {
			return a
		}
	}
	t.Fatalf("no PageAccess detail in %v", ce)
	return nil
}

// EventService's page source: every page again on connect, then the page whose owner or
// answer changed, and a removed thread (its pages lost their owner with its row).
func TestPageEventSource(t *testing.T) {
	e := newPageEnv(t)
	b := bus.New()
	s, err := page.New(context.Background(), page.Options{DB: dbtest.Open(t), Home: e.root, PagesRoot: filepath.Join(e.root, ".code-foundry", "pages"), Bus: b})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	mux := http.NewServeMux()
	r := NewEvents(EventsDeps{Bus: b, Pages: s, Done: done}).Route()
	mux.Handle(r.Path, r.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	c := codefoundryv1connect.NewEventServiceClient(srv.Client(), srv.URL)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchEventsRequest{Sources: []v1.EventSource{v1.EventSource_EVENT_SOURCE_PAGE}}))
	if err != nil {
		t.Fatal(err)
	}
	next := func() *v1.PageEvent {
		t.Helper()
		for stream.Receive() {
			if m := stream.Msg(); m.GetHeartbeat() == nil {
				return m.GetPage()
			}
		}
		t.Fatalf("stream ended: %v", stream.Err())
		return nil
	}
	if ev := next(); !ev.GetAll() || len(ev.GetPaths()) != 0 {
		t.Fatalf("snapshot = %v, want all", ev)
	}
	if _, err := s.SetConsent(ctx, filepath.Join(e.root, "new.html"), true); err != nil {
		t.Fatal(err)
	}
	if ev := next(); !slices.Equal(ev.GetPaths(), []string{filepath.Join(e.root, "new.html")}) || ev.GetAll() {
		t.Errorf("answer event = %v", ev)
	}
	bus.Publish[thread.Event](b, thread.Updated{})
	bus.Publish[thread.Event](b, thread.Removed{ID: "t-1"})
	if ev := next(); ev.GetRemovedThread() != "t-1" || len(ev.GetPaths()) != 0 {
		t.Errorf("removal event = %v", ev)
	}
}
