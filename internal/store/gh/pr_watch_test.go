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

// watchedWorld is a store polling o/r with someone else's pull request #9 on branch
// feature-x, in no dashboard, its lookup answered like the rest of the fake.
func watchedWorld(t *testing.T) (*fakeGitHub, *fakeRunner, *Store, time.Time) {
	t.Helper()
	g, t0 := changeDrivenWorld()
	theirs := fakePR("PR_x", "o/r", 9, t0)
	theirs.Author, theirs.HeadRef = "someone", "feature-x"
	g.addPR(theirs)
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
	s := startStore(t, testOptions(openTestDB(t), f, bus.New()))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	return g, f, s, t0
}

// A branch list outlives its watch. The viewer's own pull request reopens, and the cache
// answers with the dashboard's newer copy; someone else's has only the stale one until
// watching again brings a poll of its branch.
func TestCachedPullRequestAfterTheWatchEnded(t *testing.T) {
	g, f, s, t0 := watchedWorld(t)
	g.setBranch("o/r", "branch-1", "PR_a")
	both := []PullRequestRef{{"o/r", 1}, {"o/r", 9}}
	if err := s.WatchPullRequests(both); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	pollOnce(t, s, f)
	setState := func(state PullRequestState, at time.Time) {
		for _, id := range []string{"PR_a", "PR_x"} {
			g.edit(id, func(p *PullRequest) { p.State, p.UpdatedAt = state, at })
		}
	}
	setState(PullRequestClosed, t0.Add(time.Second))
	g.mu.Lock()
	g.sections[sectionAuthored] = slices.DeleteFunc(g.sections[sectionAuthored], func(id string) bool { return id == "PR_a" })
	g.mu.Unlock()
	pollOnce(t, s, f)
	if p, ok := s.CachedPullRequest("o/r", 1); !ok || p.State != PullRequestClosed {
		t.Fatalf("after the close: %q, %v", p.State, ok)
	}

	if err := s.WatchPullRequests(nil); err != nil {
		t.Fatal(err)
	}
	setState(PullRequestOpen, t0.Add(2*time.Second))
	g.mu.Lock()
	g.sections[sectionAuthored] = append(g.sections[sectionAuthored], "PR_a")
	g.mu.Unlock()
	pollOnce(t, s, f)
	if p, _ := s.CachedPullRequest("o/r", 1); p.State != PullRequestOpen {
		t.Errorf("own pull request: %q, the dashboard says open", p.State)
	}
	if p, _ := s.CachedPullRequest("o/r", 9); p.State != PullRequestClosed {
		t.Fatalf("their pull request: %q, nothing polled it", p.State)
	}

	if err := s.WatchPullRequests(both); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	if p, _ := s.CachedPullRequest("o/r", 9); p.State != PullRequestOpen {
		t.Errorf("their pull request after the poll: %q", p.State)
	}
}

func TestNewerCopy(t *testing.T) {
	t0 := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	later := t0.Add(time.Second)
	for _, tt := range []struct {
		name    string
		p, have PullRequest
		want    bool
	}{
		{"updated later", PullRequest{UpdatedAt: later}, PullRequest{UpdatedAt: t0}, true},
		{"updated earlier", PullRequest{UpdatedAt: t0}, PullRequest{UpdatedAt: later}, false},
		{"a placeholder, later", PullRequest{UpdatedAt: later, Partial: true}, PullRequest{UpdatedAt: t0}, true},
		{"a placeholder, as late", PullRequest{UpdatedAt: t0, Partial: true}, PullRequest{UpdatedAt: t0}, false},
		{"over a placeholder, as late", PullRequest{UpdatedAt: t0}, PullRequest{UpdatedAt: t0, Partial: true}, true},
		{"as late, as complete", PullRequest{UpdatedAt: t0}, PullRequest{UpdatedAt: t0}, true},
	} {
		if got := newerCopy(tt.p, tt.have); got != tt.want {
			t.Errorf("%s: %v", tt.name, got)
		}
	}
}

// LookupPullRequest asks GitHub whatever the caches hold: only an answer without the pull
// request is "not found", and an answer with it counts beside a nested failure.
func TestLookupPullRequest(t *testing.T) {
	answer := func(pr any) json.RawMessage {
		d, err := json.Marshal(map[string]any{"repository": map[string]any{"pullRequest": pr}})
		if err != nil {
			t.Fatal(err)
		}
		return d
	}
	p := fakePR("PR_x", "o/r", 9, time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC))
	p.State = PullRequestClosed
	real := prJSON(&p)
	real["checks"] = nil
	nested := func(kind string) *PartialError {
		return &PartialError{Errors: []graphQLError{{Type: kind, Message: "x", Path: []any{"repository", "pullRequest", "reviewRequests"}}}}
	}
	for _, tt := range []struct {
		name    string
		data    json.RawMessage
		err     error
		want    PullRequestState
		wantErr error
	}{
		{name: "found", data: answer(real), want: PullRequestClosed},
		{name: "not found", err: ErrNotFound, wantErr: ErrNotFound},
		{name: "null pull request beside NOT_FOUND", data: answer(nil), wantErr: ErrNotFound,
			err: &PartialError{Errors: []graphQLError{{Type: "NOT_FOUND", Message: "x", Path: []any{"repository", "pullRequest"}}}}},
		{name: "nested NOT_FOUND beside the pull request", data: answer(real), err: nested("NOT_FOUND"), want: PullRequestClosed},
		{name: "nested FORBIDDEN beside the pull request", data: answer(real), err: nested("FORBIDDEN"), want: PullRequestClosed},
		{name: "forbidden", err: ErrPermissionDenied, wantErr: ErrPermissionDenied},
		{name: "partial forbidden", err: &PartialError{Errors: []graphQLError{{Type: "FORBIDDEN", Message: "SAML"}}}, wantErr: ErrPermissionDenied},
	} {
		t.Run(tt.name, func(t *testing.T) {
			g, _ := changeDrivenWorld()
			f := &fakeRunner{}
			var asked atomic.Int32
			f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
				if op == "PullRequest" {
					asked.Add(1)
					return tt.data, tt.err
				}
				return g.respond(op, doc, vars)
			})
			s := startStore(t, testOptions(openTestDB(t), f, bus.New()))
			got, err := s.LookupPullRequest(context.Background(), "o/r", 9)
			if !errors.Is(err, tt.wantErr) || got.State != tt.want {
				t.Fatalf("= %q, %v; want %q, %v", got.State, err, tt.want, tt.wantErr)
			}
			if tt.wantErr != nil {
				return
			}
			// The detail just saved is young enough for PullRequest; this one still asks.
			if _, err := s.LookupPullRequest(context.Background(), "o/r", 9); err != nil {
				t.Fatal(err)
			}
			if n := asked.Load(); n != 2 {
				t.Errorf("asked GitHub %d times, want 2", n)
			}
		})
	}
}

func TestLookupPullRequestRefuses(t *testing.T) {
	s := startStore(t, testOptions(openTestDB(t), &fakeRunner{}, bus.New()))
	if _, err := s.LookupPullRequest(context.Background(), "nope", 1); err == nil {
		t.Error("a bad slug was asked about")
	}
	if _, err := s.LookupPullRequest(context.Background(), "o/r", 0); !errors.Is(err, ErrInvalidArgument) {
		t.Errorf("number 0: %v", err)
	}
}
