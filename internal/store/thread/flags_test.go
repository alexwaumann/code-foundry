package thread

import (
	"context"
	"slices"
	"testing"
	"time"
)

// The seen hook hears when a viewer opens the thread (attended by default), and Seen says
// so while the viewer is open.
func TestSeenHookAndSeen(t *testing.T) {
	e := newEnv(t)
	s := e.stopped("watched")
	var seen []string
	e.m.AddSeenHook(func(id string) { seen = append(seen, id) })
	if e.m.Seen(s.ID) {
		t.Fatal("Seen before a viewer")
	}
	ctx, cancel := context.WithCancel(context.Background())
	if _, err := e.m.WatchItems(ctx, s.ID); err != nil {
		t.Fatal(err)
	}
	if !e.m.Seen(s.ID) || !slices.Equal(seen, []string{s.ID}) {
		t.Fatalf("with a viewer: Seen = %v, hook heard %v", e.m.Seen(s.ID), seen)
	}
	cancel()
	deadline := time.Now().Add(5 * time.Second)
	for e.m.Seen(s.ID) {
		if time.Now().After(deadline) {
			t.Fatal("still seen after the viewer left")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// LegacyFlags reads what thread_flags kept before flags became notifications, and
// DropLegacyFlag deletes a converted row; removing the thread deletes its rows.
func TestLegacyFlags(t *testing.T) {
	e := newEnv(t)
	a, b := e.stopped("a"), e.stopped("b")
	for _, r := range []struct {
		id, source   string
		level, until int
		at           int64
	}{{a.ID, "gh", 2, 0, 2000}, {a.ID, "ci", 1, 1, 1000}, {b.ID, "gh", 1, 0, 3000}} {
		if _, err := e.m.opts.DB.Exec(`INSERT INTO thread_flags (thread_id, source, source_name, level, reason, until_seen, set_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			r.id, r.source, "Name "+r.source, r.level, "why "+r.source, r.until, r.at); err != nil {
			t.Fatal(err)
		}
	}
	summary := func() []string {
		fs, err := e.m.LegacyFlags(e.ctx())
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, f := range fs {
			line := f.ThreadID + " " + f.Source + " " + f.SourceName + " " + f.Level + " " + f.Reason
			if f.UntilSeen {
				line += " [seen]"
			}
			out = append(out, line)
		}
		return out
	}
	want := []string{a.ID + " ci Name ci attention why ci [seen]", a.ID + " gh Name gh error why gh", b.ID + " gh Name gh attention why gh"}
	if got := summary(); !slices.Equal(got, want) {
		t.Fatalf("LegacyFlags = %q, want %q", got, want)
	}
	if err := e.m.DropLegacyFlag(e.ctx(), a.ID, "ci"); err != nil {
		t.Fatal(err)
	}
	if err := e.m.Remove(e.ctx(), b.ID); err != nil {
		t.Fatal(err)
	}
	if got := summary(); !slices.Equal(got, want[1:2]) {
		t.Fatalf("after a drop and a remove: %q, want %q", got, want[1:2])
	}
}
