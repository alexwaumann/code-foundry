package gh

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// failDetails makes the poll's PullRequestDetails request fail while on is set.
func failDetails(f *fakeRunner, g *fakeGitHub, on *atomic.Bool) {
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op == "PullRequestDetails" && on.Load() {
			return nil, errors.New("github: 500")
		}
		return g.respond(op, doc, vars)
	})
}

// Reopened, CI restarts, and the poll's detail batch fails: the fingerprint says open.
func TestEventStateAfterFailedDetailReopen(t *testing.T) {
	db := openTestDB(t)
	b := bus.New()
	sub := bus.Subscribe[PullRequestChanged](b, 64)
	g, t0 := changeDrivenWorld()
	g.setBranch("o/r", "branch-1", "PR_a")
	f := &fakeRunner{}
	var fail atomic.Bool
	failDetails(f, g, &fail)
	s := startStore(t, testOptions(db, f, b))
	if err := s.WatchPullRequests([]PullRequestRef{{"o/r", 1}}); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	pollOnce(t, s, f)
	g.edit("PR_a", func(p *PullRequest) { p.State, p.UpdatedAt = PullRequestClosed, t0.Add(time.Second) })
	g.moveSection("PR_a", sectionAuthored, "none")
	pollOnce(t, s, f)
	if got := kinds(changedEvents(sub)); got != "#1:closed" {
		t.Fatalf("close: %q", got)
	}

	g.edit("PR_a", func(p *PullRequest) {
		p.State, p.UpdatedAt = PullRequestOpen, t0.Add(2*time.Second)
		p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
	})
	g.moveSection("PR_a", "none", sectionAuthored)
	fail.Store(true)
	if err := s.Refresh(context.Background(), "o/any"); err != nil {
		t.Fatal(err)
	}
	evs := changedEvents(sub)
	if got := kinds(evs); got != "#1:reopened,checks" {
		t.Fatalf("reopen: %q", got)
	}
	if evs[0].PullRequest.State != PullRequestOpen {
		t.Errorf("GitHub says open, the event says %s", evs[0].PullRequest.State)
	}
}

// A branch list stale since its watch ended holds closed; the pull request reopened and
// sits in the dashboard; one detail batch fails.
func TestNoFalseCloseFromStaleBranchList(t *testing.T) {
	db := openTestDB(t)
	b := bus.New()
	sub := bus.Subscribe[PullRequestChanged](b, 64)
	g, t0 := changeDrivenWorld()
	g.setBranch("o/r", "branch-1", "PR_a")
	f := &fakeRunner{}
	var fail atomic.Bool
	failDetails(f, g, &fail)
	s := startStore(t, testOptions(db, f, b))
	if err := s.WatchPullRequests([]PullRequestRef{{"o/r", 1}}); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	pollOnce(t, s, f)
	g.edit("PR_a", func(p *PullRequest) { p.State, p.UpdatedAt = PullRequestClosed, t0.Add(time.Second) })
	g.mu.Lock()
	g.sections[sectionAuthored] = slices.DeleteFunc(g.sections[sectionAuthored], func(id string) bool { return id == "PR_a" })
	g.mu.Unlock()
	pollOnce(t, s, f)
	// The subscription ended with the close, so the watch does too.
	if err := s.WatchPullRequests(nil); err != nil {
		t.Fatal(err)
	}
	g.edit("PR_a", func(p *PullRequest) { p.State, p.UpdatedAt = PullRequestOpen, t0.Add(2*time.Second) })
	g.mu.Lock()
	g.sections[sectionAuthored] = append(g.sections[sectionAuthored], "PR_a")
	g.mu.Unlock()
	pollOnce(t, s, f)
	pollOnce(t, s, f)
	changedEvents(sub)
	if p, _ := s.CachedPullRequest("o/r", 1); p.State != PullRequestOpen {
		t.Fatalf("setup: %q", p.State)
	}

	// Nothing changes on GitHub. One detail batch fails.
	fail.Store(true)
	if err := s.Refresh(context.Background(), "o/any"); err != nil {
		t.Fatal(err)
	}
	if got := kinds(changedEvents(sub)); got != "" {
		t.Errorf("nothing changed on GitHub, yet the poll reported %s", got)
	}
}
