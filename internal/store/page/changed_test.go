package page

import (
	"context"
	"strings"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// A new owner (Record) or another answer (SetConsent) publishes Changed with the page's
// resolved path, so every frame on it reads its access again; the same owner recording
// again, or the same answer given again, is no news (docs/notes/page-access-live.md).
func TestChangedPublished(t *testing.T) {
	e := newEnv(t)
	b := bus.New()
	s, err := New(context.Background(), Options{
		DB: e.db, Home: e.home, PagesRoot: e.pages, StorageRoot: e.storage, Bus: b,
		ThreadExists: func(id string) bool { return !e.gone[id] },
		Guarded:      func(p string) bool { return strings.Contains(p, "/secret/") },
	})
	if err != nil {
		t.Fatal(err)
	}
	sub := bus.Subscribe[Changed](b, 16)
	defer sub.Close()
	p := e.file(e.home, "p/report.html")
	own := e.file(e.pages, "t-a/own.html")
	want := real(t, p)
	ctx := context.Background()
	for _, tc := range []struct {
		name    string
		do      func() error
		changed string // "" for none
	}{
		{"first owner", func() error { return s.Record(ctx, "t-a", p, Shown) }, want},
		{"same owner again", func() error { return s.Record(ctx, "t-a", p, Written) }, ""},
		{"another owner", func() error { return s.Record(ctx, "t-b", p, Shown) }, want},
		{"the pages directory's own thread", func() error { return s.Record(ctx, "t-a", own, Written) }, ""},
		{"allowed", func() error { _, err := s.SetConsent(ctx, p, true); return err }, want},
		{"allowed again", func() error { _, err := s.SetConsent(ctx, p, true); return err }, ""},
		{"refused", func() error { _, err := s.SetConsent(ctx, p, false); return err }, want},
		{"not a page", func() error { _, err := s.SetConsent(ctx, e.file(e.home, "notes.txt"), true); return err }, ""},
	} {
		err := tc.do()
		if (err != nil) != (tc.name == "not a page") {
			t.Fatalf("%s: %v", tc.name, err)
		}
		select {
		case ev := <-sub.C():
			if ev.Path != tc.changed {
				t.Errorf("%s: Changed{%q}, want %q", tc.name, ev.Path, tc.changed)
			}
		default: // Publish is synchronous: a Changed would be buffered already
			if tc.changed != "" {
				t.Errorf("%s: nothing published, want %q", tc.name, tc.changed)
			}
		}
	}
}
