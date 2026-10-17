package project

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

// An unchanged status republishes the worktree (snapshot and event) once the published
// RefreshedAt is older than republishAfter, and not before.
func TestUnchangedStatusRepublishesStaleRefreshedAt(t *testing.T) {
	f := newFixture(t)
	var clock atomic.Int64
	clock.Store(time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC).UnixNano())
	now := func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	h := startHarness(t, "", Options{Now: now})
	ctx := context.Background()
	r, err := h.store.Register(ctx, f.project)
	if err != nil {
		t.Fatal(err)
	}
	h.store.sched.close()
	first, _ := h.store.Snapshot().Worktree(r.ID, f.project)
	if first.Status.RefreshedAt.IsZero() {
		t.Fatal("first status did not publish RefreshedAt")
	}
	tests := []struct {
		name      string
		advance   time.Duration
		republish bool
	}{
		{"within republishAfter", republishAfter / 2, false},
		{"past republishAfter", republishAfter, true},
		{"right after a republish", time.Second, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			clock.Add(int64(tt.advance))
			before := h.store.Snapshot()
			drain(h)
			h.store.status(ctx, r.ID, f.project)
			after := h.store.Snapshot()
			w, _ := after.Worktree(r.ID, f.project)
			got := after != before
			if got != tt.republish {
				t.Fatalf("republished = %v, want %v", got, tt.republish)
			}
			if tt.republish {
				if !w.Status.RefreshedAt.Equal(now()) {
					t.Errorf("RefreshedAt = %v, want %v", w.Status.RefreshedAt, now())
				}
				if !sawWorktreeUpdated(h, f.project) {
					t.Error("no WorktreeUpdated for the republish")
				}
			}
		})
	}
}

func drain(h *harness) {
	for {
		select {
		case <-h.sub.C():
		default:
			return
		}
	}
}

func sawWorktreeUpdated(h *harness, path string) bool {
	for {
		select {
		case e := <-h.sub.C():
			if u, ok := e.(WorktreeUpdated); ok && u.Worktree.Path == path {
				return true
			}
		default:
			return false
		}
	}
}
