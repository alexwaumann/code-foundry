package gh

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// changedEvents empties a PullRequestChanged subscription.
func changedEvents(sub *bus.Subscription[PullRequestChanged]) []PullRequestChanged {
	var out []PullRequestChanged
	for {
		select {
		case e := <-sub.C():
			out = append(out, e)
		default:
			return out
		}
	}
}

// moveSection moves a pull request between the fake's dashboard sections.
func (g *fakeGitHub) moveSection(id, from, to string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.sections[from] = slices.DeleteFunc(g.sections[from], func(x string) bool { return x == id })
	g.sections[to] = append(g.sections[to], id)
}

func TestPollPublishesPullRequestChanged(t *testing.T) {
	db := openTestDB(t)
	b := bus.New()
	sub := bus.Subscribe[PullRequestChanged](b, 64)
	g, t0 := changeDrivenWorld()
	g.setBranch("o/r", "branch-1", "PR_a")
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(db, f, b))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.BranchPullRequests(context.Background(), "o/r", "branch-1"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	pollOnce(t, s, f)
	if evs := changedEvents(sub); len(evs) != 0 {
		t.Fatalf("first polls (nothing cached) announced %s", kinds(evs))
	}

	steps := []struct {
		name  string
		edit  func()
		want  string
		check func(t *testing.T, e PullRequestChanged)
	}{
		{"nothing moved", func() {}, "", nil},
		{"check counts moved: one event though PR_a is authored and on a watched branch", func() {
			g.edit("PR_a", func(p *PullRequest) { p.Checks = CheckRollup{State: RollupPending, Total: 4, Passed: 3, Pending: 1} })
		}, "#1:checks", func(t *testing.T, e PullRequestChanged) {
			c := e.Changes[0]
			if c.OldChecks.State != RollupSuccess || c.NewChecks.State != RollupPending || c.NewChecks.Pending != 1 {
				t.Errorf("checks change %+v", c)
			}
			if e.Slug != "o/r" || e.HeadRef != "branch-1" || e.URL == "" || e.PullRequest.Title != "PR 1" {
				t.Errorf("event %+v", e)
			}
		}},
		{"a push", func() {
			g.edit("PR_a", func(p *PullRequest) {
				p.HeadSHA, p.UpdatedAt = "feedface", t0.Add(time.Minute)
				p.Checks = CheckRollup{State: RollupPending, Total: 2, Pending: 2}
			})
		}, "#1:head_pushed,checks", func(t *testing.T, e PullRequestChanged) {
			if c := e.Changes[0]; c.OldHeadSHA == "" || c.NewHeadSHA != "feedface" {
				t.Errorf("head change %+v", c)
			}
		}},
		{"a review and comments", func() {
			g.edit("PR_a", func(p *PullRequest) {
				p.UpdatedAt, p.Reviews, p.Comments, p.ReviewDecision = t0.Add(2*time.Minute), 1, 2, ReviewChangesRequested
			})
		}, "#1:review_decision,reviews,comments", nil},
		{"a new pull request", func() { g.addPR(fakePR("PR_d", "o/r", 4, t0), sectionAuthored) }, "#4:appeared", nil},
		{"the viewer asked to review", func() {
			g.edit("PR_d", func(p *PullRequest) { p.UpdatedAt, p.ReviewRequests = t0.Add(time.Minute), []string{"octocat"} })
			g.mu.Lock()
			g.sections[sectionReview] = append(g.sections[sectionReview], "PR_d")
			g.mu.Unlock()
		}, "#4:review_requested", func(t *testing.T, e PullRequestChanged) {
			if c := e.Changes[0]; !c.Viewer || !slices.Equal(c.Requested, []string{"octocat"}) {
				t.Errorf("review requested %+v", c)
			}
		}},
		{"merged: leaves authored, stays on its branch", func() {
			g.edit("PR_a", func(p *PullRequest) {
				p.State, p.MergedAt, p.UpdatedAt = PullRequestMerged, t0.Add(3*time.Minute), t0.Add(3*time.Minute)
			})
			g.moveSection("PR_a", sectionAuthored, sectionMerged)
		}, "#1:merged", nil},
		{"closed and gone from every list: state unknown, nothing", func() {
			g.edit("PR_d", func(p *PullRequest) { p.State, p.UpdatedAt = PullRequestClosed, t0.Add(4*time.Minute) })
			g.moveSection("PR_d", sectionAuthored, "none")
			g.moveSection("PR_d", sectionReview, "none")
		}, "", nil},
	}
	for _, st := range steps {
		st.edit()
		pollOnce(t, s, f)
		evs := changedEvents(sub)
		if got := kinds(evs); got != st.want {
			t.Errorf("%s: events %q, want %q", st.name, got, st.want)
			continue
		}
		if st.check != nil && len(evs) == 1 {
			st.check(t, evs[0])
		}
	}

	// Restart on the same cache: the cached lists are the previous state, so the first
	// poll announces nothing.
	waitFor(t, "poll row", func() bool {
		p, ok, err := loadActivityRow[pollRow](context.Background(), s.cache, activityPoll)
		return err == nil && ok && !p.FetchedAt.IsZero()
	})
	b2 := bus.New()
	sub2 := bus.Subscribe[PullRequestChanged](b2, 64)
	f2 := (&fakeRunner{}).serve(g)
	s2 := startStore(t, testOptions(db, f2, b2))
	if err := s2.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	if _, err := s2.BranchPullRequests(context.Background(), "o/r", "branch-1"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s2, f2)
	if evs := changedEvents(sub2); len(evs) != 0 {
		t.Errorf("first poll after a restart announced %s", kinds(evs))
	}
	g.edit("PR_b", func(p *PullRequest) { p.Title, p.UpdatedAt = "Renamed", t0.Add(5*time.Minute) })
	pollOnce(t, s2, f2)
	if got := kinds(changedEvents(sub2)); got != "#2:title" {
		t.Errorf("after a restart: events %q, want #2:title", got)
	}
}

// A poll that saw a pull request move makes PullRequest (the plugins' pr.checks)
// refetch a cached detail younger than DetailTTL.
func TestPollMovesCachedPullRequest(t *testing.T) {
	g, _ := changeDrivenWorld()
	f := &fakeRunner{}
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		if op != "PullRequest" {
			return g.respond(op, doc, vars)
		}
		g.mu.Lock()
		defer g.mu.Unlock()
		pr := prJSON(g.prs["PR_a"])
		pr["checks"] = rollupOrNil(g.prs["PR_a"].Checks)
		return json.Marshal(map[string]any{"repository": map[string]any{"pullRequest": pr}})
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	ctx := context.Background()
	read := func() (PullRequestDetail, int) {
		t.Helper()
		from := f.count("PullRequest")
		d, err := s.PullRequest(ctx, "o/r", 1)
		if err != nil {
			t.Fatal(err)
		}
		return d, f.count("PullRequest") - from
	}
	if _, n := read(); n != 1 {
		t.Fatalf("first read fetched %d times", n)
	}
	if _, n := read(); n != 0 {
		t.Errorf("second read fetched %d times, want the cache", n)
	}
	pollOnce(t, s, f) // nothing moved
	if _, n := read(); n != 0 {
		t.Errorf("read after an unchanged poll fetched %d times, want the cache", n)
	}
	g.edit("PR_a", func(p *PullRequest) { p.Checks = CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1} })
	pollOnce(t, s, f)
	d, n := read()
	if n != 1 || d.PullRequest.Checks.Failed != 1 {
		t.Errorf("read after the checks moved: %d fetches, checks %+v; want a fetch with the new checks", n, d.PullRequest.Checks)
	}
	if _, n := read(); n != 0 {
		t.Errorf("read after the refetch fetched %d times, want the cache", n)
	}
}
