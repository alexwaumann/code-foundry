package thread

import (
	"slices"
	"sync"
	"testing"
)

// Remove calls Options.Removed once with the removed thread as it was, after its row is
// gone from the snapshot and its tombstone is in. A removal does not cascade: the
// children it adopts are not passed. A failed removal calls nothing.
func TestRemoveCallsRemovedHook(t *testing.T) {
	tests := []struct {
		name string
		// children are created by the removed thread; missing removes an unknown id.
		children  int
		missing   bool
		wantCalls int
	}{
		{name: "a thread", wantCalls: 1},
		{name: "with children: only the thread itself", children: 2, wantCalls: 1},
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
			for _, c := range calls {
				if c.t.ID != s.ID || c.t.Name != "parent" || c.t.WorktreePath != s.WorktreePath || !slices.Equal(c.t.Projects(), s.Projects()) {
					t.Errorf("Removed got %+v, want the thread as it was (%+v)", c.t, s)
				}
				if c.inSnap || !c.tombstoned {
					t.Errorf("at the hook: in the snapshot %v, tombstoned %v; want gone and tombstoned", c.inSnap, c.tombstoned)
				}
			}
		})
	}
}
