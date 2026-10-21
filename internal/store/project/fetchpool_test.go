package project

import (
	"context"
	"sync"
	"testing"
	"time"
)

// stallRunner blocks `git fetch --prune` (the fetch loop's) in stall until ctx ends,
// as an unreachable remote does, and records the dirs other fetches ran in.
type stallRunner struct {
	next    Runner
	stall   string
	mu      sync.Mutex
	stalled int
	fetched []string
}

func (s *stallRunner) Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	if len(args) > 1 && args[0] == "fetch" && args[1] == "--prune" {
		s.mu.Lock()
		if dir == s.stall {
			s.stalled++
			s.mu.Unlock()
			<-ctx.Done()
			return nil, ctx.Err()
		}
		s.fetched = append(s.fetched, dir)
		s.mu.Unlock()
	}
	return s.next.Run(ctx, dir, args...)
}

func (s *stallRunner) seen(dir string) (fetched, stalled int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, d := range s.fetched {
		if d == dir {
			fetched++
		}
	}
	return fetched, s.stalled
}

// TestFetchUnreachableRemote: a fetch that hangs does not hold up the other projects'
// fetches, and the hung project is not fetched again while its fetch runs (fuzz
// finding git 9).
func TestFetchUnreachableRemote(t *testing.T) {
	stuck, ok := newFixture(t), newFixture(t)
	sr := &stallRunner{next: ExecRunner{}, stall: stuck.project}
	h := startHarness(t, "", Options{Runner: sr, FetchInterval: 200 * time.Millisecond, IdleFetchInterval: 200 * time.Millisecond})
	ctx := context.Background()
	for _, dir := range []string{stuck.project, ok.project} {
		if _, err := h.store.Register(ctx, dir); err != nil {
			t.Fatal(err)
		}
	}
	h.store.SetLiveWorktrees([]string{stuck.project, ok.project})
	// Twice: the second round comes after the hung fetch started, whatever the order.
	eventually(t, "the reachable project is fetched while the other hangs", 5*time.Second, func() bool {
		fetched, stalled := sr.seen(ok.project)
		return fetched >= 2 && stalled > 0
	})
	time.Sleep(time.Second) // several rounds
	if _, stalled := sr.seen(ok.project); stalled != 1 {
		t.Fatalf("the hung project was fetched %d times at once", stalled)
	}
}
