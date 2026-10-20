package gh

import (
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestKeepFingerprints(t *testing.T) {
	fps := []prFingerprint{
		{ID: "a", Number: 1, Author: "octocat"},
		{ID: "b", Number: 2, Author: "someone"},
		{ID: "c", Number: 3, Author: "octocat", IsCross: true},
		{ID: "d", Number: 4, Author: "other", IsCross: true},
	}
	ids := func(fps []prFingerprint) []string {
		var out []string
		for _, f := range fps {
			out = append(out, f.ID)
		}
		return out
	}
	for _, tt := range []struct {
		keep []int
		want []string
	}{
		{nil, []string{"a"}},
		{[]int{2}, []string{"a", "b"}},
		{[]int{4, 9}, []string{"a", "d"}},
		{[]int{1}, []string{"a"}},
	} {
		if got := ids(keepFingerprints(fps, "OctoCat", tt.keep)); !slices.Equal(got, tt.want) {
			t.Errorf("keep %v: %v, want %v", tt.keep, got, tt.want)
		}
	}
}

// branchesPlanned is the watched branches of slug in the next poll's plan.
func branchesPlanned(s *Store, slug string) ([]string, []int) {
	plan, _ := s.planPoll(s.config(), s.opts.Now())
	for _, r := range plan.repos {
		if r.slug == slug {
			return r.branches, r.keep
		}
	}
	return nil, nil
}

// A watched pull request someone else wrote, in no dashboard: its head branch is looked
// up once, polled without expiry, kept in its branch list, and its changes published;
// unwatched, its branch leaves the poll.
func TestWatchPullRequests(t *testing.T) {
	g, t0 := changeDrivenWorld()
	theirs := fakePR("PR_x", "o/r", 9, t0)
	theirs.Author, theirs.HeadRef = "someone", "feature-x"
	theirs.Checks = CheckRollup{State: RollupPending, Total: 2, Passed: 1, Pending: 1}
	g.addPR(theirs) // in no section
	g.setBranch("o/r", "feature-x", "PR_x")
	f := &fakeRunner{}
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op != "PullRequest" {
			return g.respond(op, doc, vars)
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		for _, p := range g.prs {
			if p.Repo == vars["owner"].(string)+"/"+vars["name"].(string) && float64(p.Number) == toFloat(vars["number"]) {
				pr := prJSON(p)
				pr["checks"] = rollupOrNil(p.Checks)
				return json.Marshal(map[string]any{"repository": map[string]any{"pullRequest": pr}})
			}
		}
		return nil, ErrNotFound
	})
	b := bus.New()
	sub := bus.Subscribe[PullRequestChanged](b, 64)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	if _, ok := s.CachedPullRequest("o/r", 9); ok {
		t.Fatal("PR 9 is cached before it is watched")
	}
	if p, ok := s.CachedPullRequest("O/R", 1); !ok || p.HeadRef != "branch-1" {
		t.Errorf("CachedPullRequest(#1) = %+v, %v", p, ok)
	}

	if err := s.WatchPullRequests([]PullRequestRef{{"O/R", 9}, {"o/r", 404}}); err != nil {
		t.Fatal(err)
	}
	if err := s.WatchPullRequests([]PullRequestRef{{"nope", 1}}); !errors.Is(err, ErrInvalidSlug) {
		t.Errorf("a bad slug: %v", err)
	}
	if err := s.WatchPullRequests([]PullRequestRef{{"o/r", 0}}); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("number 0: %v", err)
	}
	// The failed calls left the set alone (validated before replacing it).
	from := f.count("PullRequest")
	pollOnce(t, s, f)
	if n := f.count("PullRequest") - from; n != 2 {
		t.Errorf("first poll looked up %d pull requests, want 2 (9 and 404)", n)
	}
	p, ok := s.CachedPullRequest("o/r", 9)
	if !ok || p.HeadRef != "feature-x" || p.Author != "someone" || p.Checks.Pending != 1 {
		t.Fatalf("CachedPullRequest(#9) = %+v, %v", p, ok)
	}
	// CachedPullRequests: every list (dashboards and the branch list), one copy each.
	all := map[int]int{}
	for _, p := range s.CachedPullRequests() {
		all[p.Number]++
		if p.Number == 9 && p.HeadRef != "feature-x" {
			t.Errorf("CachedPullRequests #9 = %+v", p)
		}
	}
	if all[1] != 1 || all[9] != 1 {
		t.Errorf("CachedPullRequests numbers (count) = %v; want 1 and 9 once each", all)
	}
	if evs := changedEvents(sub); len(evs) != 0 {
		t.Errorf("the branch's first poll announced %s", kinds(evs))
	}
	if br, keep := branchesPlanned(s, "o/r"); !slices.Equal(br, []string{"feature-x"}) || !slices.Equal(keep, []int{9}) {
		t.Errorf("planned branches %v keep %v", br, keep)
	}

	// The unknown one is not looked up again within BranchWatch; the change is published.
	g.edit("PR_x", func(p *PullRequest) { p.Checks = CheckRollup{State: RollupSuccess, Total: 2, Passed: 2} })
	from = f.count("PullRequest")
	pollOnce(t, s, f)
	if n := f.count("PullRequest") - from; n != 0 {
		t.Errorf("second poll looked up %d pull requests, want none", n)
	}
	if got := kinds(changedEvents(sub)); got != "#9:checks" {
		t.Errorf("events %q, want #9:checks", got)
	}

	// Watching the same set again keeps the resolved head; an empty set drops the branch.
	if err := s.WatchPullRequests([]PullRequestRef{{"o/r", 9}}); err != nil {
		t.Fatal(err)
	}
	if br, _ := branchesPlanned(s, "o/r"); !slices.Equal(br, []string{"feature-x"}) {
		t.Errorf("after re-watching: planned branches %v", br)
	}
	if err := s.WatchPullRequests(nil); err != nil {
		t.Fatal(err)
	}
	if br, keep := branchesPlanned(s, "o/r"); len(br) != 0 || len(keep) != 0 {
		t.Errorf("after unwatching: planned branches %v keep %v", br, keep)
	}
}

func toFloat(v any) float64 {
	switch n := v.(type) {
	case int:
		return float64(n)
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return -1
}
