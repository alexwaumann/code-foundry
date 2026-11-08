package thread

import (
	"context"
	"strings"
	"testing"
	"time"
)

// Archiving one member of a group whose others are held: its close is slow, so the
// group's wake goes before ArchivedAt is stamped. The member is not counted as a settled
// sibling, and, archived by anyone but the subscriber, it is named.
func TestGroupMemberArchived(t *testing.T) {
	tests := []struct {
		name string
		by   func(parent string) string
		// named: the wake says it was archived.
		named bool
	}{
		{"by the user", func(string) string { return "" }, true},
		{"by another thread", func(string) string { return "s-other" }, true},
		{"by the subscriber itself", func(parent string) string { return parent }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := &batchEnv{env: newFixtureEnvAt(t, hangFixture(t), []string{"CF_FAKE_CLAUDE_EXIT_DELAY=500ms"},
				func(o *Options) { o.WakeBatch = 20 * time.Millisecond })}
			b.parent = b.stopped("parent")
			for _, name := range []string{"quick-file", "long-report"} {
				k := b.stopped(name)
				b.m.update(k.ID, false, func(rec *record) { rec.s.CreatedBy = b.parent.ID })
				b.setStep(k.ID, busy)
				b.kids = append(b.kids, k)
			}
			sleeper := b.create(CreateOptions{Name: "sleeper", InitialPrompt: "go", CreatedBy: b.parent.ID})
			b.waitFor(sleeper.ID, "busy", func(s Thread) bool { return s.Status == StatusBusy && s.State == StateConnected })
			for _, k := range append(b.kids, sleeper) {
				if _, err := b.m.Subscribe(b.ctx(), SubscribeOptions{SubscriberID: b.parent.ID, TargetThreadID: k.ID, Repeat: true, Group: "g"}); err != nil {
					t.Fatal(err)
				}
			}
			b.finishWith(b.kids[0].ID, "A-DONE")
			b.finishWith(b.kids[1].ID, "B-DONE")
			if n := b.quiet(); n != 0 {
				t.Fatalf("%d wakes while one works", n)
			}
			done := make(chan error, 1)
			go func() {
				_, err := b.m.Archive(ArchivedBy(context.Background(), tt.by(b.parent.ID)), sleeper.ID, true)
				done <- err
			}()
			items := b.waitItems(b.parent.ID, "the group's wake", func(items []Item) bool { return len(wakes(items)) > 0 })
			if got := b.snapshot(sleeper.ID); !got.ArchivedAt.IsZero() {
				t.Fatal("the close was not slow: archived before the wake")
			}
			w := wakes(items)[0]
			if strings.Contains(w.WakeTitle, "All 3") || !strings.Contains(w.WakeTitle, "All 2 of your child threads settled.") {
				t.Errorf("title counts the archived member: %s", w.WakeTitle)
			}
			named := `"sleeper" (` + sleeper.ID + `) was archived.`
			if got := strings.Contains(w.WakeTitle, named); got != tt.named {
				t.Errorf("named = %v, want %v: %s", got, tt.named, w.WakeTitle)
			}
			if got := strings.Contains(w.WakeJSON, `"archived": [`); got != tt.named {
				t.Errorf("siblings.archived = %v, want %v:\n%s", got, tt.named, w.WakeJSON)
			}
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			time.Sleep(100 * time.Millisecond)
			if n := len(wakes(b.items(b.parent.ID).Items)); n != 1 {
				t.Errorf("wakes = %d, want 1", n)
			}
		})
	}
}

func TestArchivedSentence(t *testing.T) {
	tests := []struct {
		gone []wakeSibling
		want string
	}{
		{nil, ""},
		{[]wakeSibling{{"s-1", "sleeper"}}, `"sleeper" (s-1) was archived.`},
		{[]wakeSibling{{"s-1", "a"}, {"s-2", ""}}, `"a" (s-1), s-2 were archived.`},
	}
	for _, tt := range tests {
		if got := archivedSentence(tt.gone); got != tt.want {
			t.Errorf("archivedSentence(%v) = %q, want %q", tt.gone, got, tt.want)
		}
	}
}
