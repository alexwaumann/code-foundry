package plugin_test

import (
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

func (f *fakeFacts) fetchCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fetches
}

func (f *fakeFacts) setChecks(runs ...plugin.CheckRun) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.checks = runs
}

func waitFetches(t *testing.T, f *fakeFacts, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.fetchCount() < n {
		if time.Now().After(deadline) {
			t.Fatalf("%d fetches, want %d", f.fetchCount(), n)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// availabilityEvents counts the AvailabilityChanged events sub holds after a settle.
func availabilityEvents(sub *bus.Subscription[plugin.Event], settle time.Duration) int {
	n := 0
	timeout := time.After(settle)
	for {
		select {
		case ev := <-sub.C():
			if _, ok := ev.(plugin.AvailabilityChanged); ok {
				n++
			}
		case <-timeout:
			return n
		}
	}
}

func TestInvalidatePullRequestChecks(t *testing.T) {
	e := newSurfEnv(t, nil)
	sub := bus.Subscribe[plugin.Event](e.opts.Bus, 256)
	defer sub.Close()
	show, _ := e.reg.Get("plugin.surf.show.checks")
	actions := plugin.CheckRun{Name: "test", App: "github-actions", URL: "https://github.com/o/r/actions/runs/1/job/2"}
	jenkins := plugin.CheckRun{Name: "jenkins", URL: "https://ci.example/1"}

	// A pull request nobody asked about is not fetched.
	e.m.InvalidatePullRequestChecks("o/r", 9)

	// Invalidated while its first fetch runs: fetched again once that one ends.
	e.facts.setChecks(actions)
	show.Available(s1)
	waitFetches(t, e.facts, 1)
	e.m.InvalidatePullRequestChecks("O/R", 1)
	close(e.facts.release)
	waitFetches(t, e.facts, 2)
	if n := availabilityEvents(sub, 400*time.Millisecond); n != 1 {
		t.Errorf("first answer: %d AvailabilityChanged, want 1 (the refetch found the same)", n)
	}
	if !show.Available(s1) {
		t.Fatal("not available with a github-actions check")
	}

	// Same checks: refetched, nothing announced.
	e.m.InvalidatePullRequestChecks("o/r", 1)
	waitFetches(t, e.facts, 3)
	if n := availabilityEvents(sub, 400*time.Millisecond); n != 0 {
		t.Errorf("unchanged checks: %d AvailabilityChanged", n)
	}

	// Different checks: announced, and the fact answers with them at once (no 10 min wait).
	e.facts.setChecks(jenkins)
	e.m.InvalidatePullRequestChecks("o/r", 1)
	waitFetches(t, e.facts, 4)
	waitEvent(t, sub, func(ev plugin.Event) bool { _, ok := ev.(plugin.AvailabilityChanged); return ok })
	if show.Available(s1) {
		t.Error("still available after the github-actions check went")
	}
	if n := e.facts.fetchCount(); n != 4 {
		t.Errorf("%d fetches, want 4 (reads within checksFresh use the cache)", n)
	}
}
