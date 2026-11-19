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

// A write that changes a page's storage publishes StorageChanged with the page's resolved
// path, so every open copy of the page in any client reads it again; a write that changes
// nothing, or is refused, is no news (docs/notes/page-storage-change-event.md).
func TestStorageChangedPublished(t *testing.T) {
	e := newEnv(t)
	b := bus.New()
	s, err := New(context.Background(), Options{
		DB: e.db, Home: e.home, PagesRoot: e.pages, StorageRoot: e.storage, Bus: b,
		ThreadExists: func(id string) bool { return !e.gone[id] },
	})
	if err != nil {
		t.Fatal(err)
	}
	sub := bus.Subscribe[StorageChanged](b, 16)
	defer sub.Close()
	answers := bus.Subscribe[Changed](b, 16)
	defer answers.Close()
	ctx := context.Background()
	p := e.file(e.home, "p/counter.html")
	if err := s.Record(ctx, "t-a", p, Shown); err != nil {
		t.Fatal(err)
	}
	<-answers.C() // the new owner's Changed; a storage write publishes none
	alone := e.file(e.home, "p/alone.html")
	if _, err := s.SetConsent(ctx, alone, true); err != nil {
		t.Fatal(err)
	}
	<-answers.C()
	want, wantAlone := real(t, p), real(t, alone)
	str := func(v string) *string { return &v }
	for _, tc := range []struct {
		name    string
		path    string
		key     string
		value   *string
		fails   bool
		changed string // "" for none
	}{
		{"a new key", p, "c:n", str("1"), false, want},
		{"the same value", p, "c:n", str("1"), false, ""},
		{"another value", p, "c:n", str("2"), false, want},
		{"removed", p, "c:n", nil, false, want},
		{"removing a missing key", p, "c:n", nil, false, ""},
		{"not JSON", p, "c:n", str("{"), true, ""},
		{"an allowed page no thread owns", alone, "k", str(`"v"`), false, wantAlone},
		{"a page not allowed", e.file(e.home, "p/asks.html"), "k", str("1"), true, ""},
	} {
		_, err := s.SetStorage(ctx, tc.path, tc.key, tc.value)
		if (err != nil) != tc.fails {
			t.Fatalf("%s: %v", tc.name, err)
		}
		select {
		case ev := <-sub.C():
			if ev.Path != tc.changed {
				t.Errorf("%s: StorageChanged{%q}, want %q", tc.name, ev.Path, tc.changed)
			}
		default: // Publish is synchronous
			if tc.changed != "" {
				t.Errorf("%s: nothing published, want %q", tc.name, tc.changed)
			}
		}
		select {
		case ev := <-answers.C():
			t.Errorf("%s: Changed{%q}: a storage write is no change of answer", tc.name, ev.Path)
		default:
		}
	}
}
