package thread

import (
	"slices"
	"sync"
	"testing"
)

// Remove calls Options.Removed with each removed thread as it was, after its row is
// gone from the snapshot and its tombstone is in: the hidden children it takes with it
// first, then the thread. A failed removal calls nothing.
func TestRemoveCallsRemovedHook(t *testing.T) {
	tests := []struct {
		name string
		// children are created by the removed thread; missing removes an unknown id.
		children  int
		missing   bool
		wantCalls int
	}{
		{name: "a thread", wantCalls: 1},
		{name: "with hidden children: each of them, then the thread", children: 2, wantCalls: 3},
		{name: "an unknown id calls nothing", missing: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			type call struct {
				t                  Thread
				inSnap, tombstoned bool
			}
			var mu sync.Mutex
			var calls []call
			var e *env
			e = newEnv(t, func(o *Options) {
				o.Removed = func(s Thread) {
					_, inSnap := e.m.Snapshot().Thread(s.ID)
					_, tomb := e.m.removed.get(s.ID, e.m.opts.Now())
					mu.Lock()
					calls = append(calls, call{t: s, inSnap: inSnap, tombstoned: tomb})
					mu.Unlock()
				}
			})
			s := e.stopped("parent")
			for range tt.children {
				e.create(CreateOptions{Name: "kid", CreatedBy: s.ID})
			}
			id := s.ID
			if tt.missing {
				id = "s-000000000000"
			}
			if err := e.m.Remove(e.ctx(), id); tt.missing != (err != nil) {
				t.Fatalf("Remove = %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(calls) != tt.wantCalls {
				t.Fatalf("Removed called %d times, want %d: %+v", len(calls), tt.wantCalls, calls)
			}
			for i, c := range calls {
				if i < tt.children {
					if c.t.Name != "kid" || c.t.CreatedBy != s.ID {
						t.Errorf("call %d: got %s (created by %s), want a hidden child first", i, c.t.Name, c.t.CreatedBy)
					}
				} else if c.t.ID != s.ID || c.t.Name != "parent" || c.t.WorktreePath != s.WorktreePath || !slices.Equal(c.t.Projects(), s.Projects()) {
					t.Errorf("Removed got %+v, want the thread as it was (%+v)", c.t, s)
				}
				if c.inSnap || !c.tombstoned {
					t.Errorf("at the hook: in the snapshot %v, tombstoned %v; want gone and tombstoned", c.inSnap, c.tombstoned)
				}
			}
		})
	}
}
