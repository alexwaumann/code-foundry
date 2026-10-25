package gh

import (
	"context"
	"fmt"
	"slices"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

func TestOverlayMerges(t *testing.T) {
	t0 := time.Date(2026, 10, 25, 12, 0, 0, 0, time.UTC)
	open := fakePR("PR_1", "o/r", 1, t0)
	other := fakePR("PR_2", "o/r", 2, t0)
	merged := open
	merged.State, merged.MergedAt = PullRequestMerged, t0
	k := fullKey{"o/r", 1}
	marks := map[fullKey]mergeMark{k: {pr: merged, at: t0}}
	numbers := func(prs []PullRequest) string {
		var out []string
		for _, p := range prs {
			out = append(out, fmt.Sprintf("#%d %s", p.Number, p.State))
		}
		return fmt.Sprint(out)
	}
	tests := []struct {
		name                     string
		d                        Dashboard
		now                      time.Time
		authored, review, recent string
		totals                   [2]int // authored, recently merged
		done                     bool
	}{
		{name: "still open in the searches: moved to recently merged",
			d:   Dashboard{Authored: []PullRequest{open, other}, AuthoredTotal: 2, RecentlyMerged: nil},
			now: t0.Add(time.Minute), authored: "[#2 OPEN]", recent: "[#1 MERGED]", totals: [2]int{1, 1}},
		{name: "in review requested too: dropped from both",
			d:   Dashboard{Authored: []PullRequest{open}, AuthoredTotal: 1, ReviewRequested: []PullRequest{open}, ReviewRequestedTotal: 1},
			now: t0.Add(time.Minute), authored: "[]", review: "[]", recent: "[#1 MERGED]", totals: [2]int{0, 1}},
		{name: "open and already in recently merged: not added twice",
			d:   Dashboard{Authored: []PullRequest{open}, AuthoredTotal: 1, RecentlyMerged: []PullRequest{merged}, RecentlyMergedTotal: 1},
			now: t0.Add(time.Minute), authored: "[]", recent: "[#1 MERGED]", totals: [2]int{0, 1}},
		{name: "gone from open, not yet in recently merged: kept",
			d:   Dashboard{Authored: []PullRequest{other}, AuthoredTotal: 1},
			now: t0.Add(time.Minute), authored: "[#2 OPEN]", recent: "[#1 MERGED]", totals: [2]int{1, 1}},
		{name: "the searches agree: done, nothing changed",
			d:   Dashboard{Authored: []PullRequest{other}, AuthoredTotal: 1, RecentlyMerged: []PullRequest{merged}, RecentlyMergedTotal: 1},
			now: t0.Add(time.Minute), authored: "[#2 OPEN]", recent: "[#1 MERGED]", totals: [2]int{1, 1}, done: true},
		{name: "expired: done, the searches win",
			d:   Dashboard{Authored: []PullRequest{open}, AuthoredTotal: 1},
			now: t0.Add(mergeMarkTTL), authored: "[#1 OPEN]", recent: "[]", totals: [2]int{1, 0}, done: true},
		{name: "dashboards off: done",
			d:   Dashboard{Disabled: true},
			now: t0.Add(time.Minute), authored: "[]", recent: "[]", done: true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := numbers(tt.d.Authored)
			got, done := overlayMerges(tt.d, marks, tt.now)
			if a := numbers(got.Authored); a != tt.authored {
				t.Errorf("authored = %s, want %s", a, tt.authored)
			}
			if r := numbers(got.ReviewRequested); tt.review != "" && r != tt.review {
				t.Errorf("review requested = %s, want %s", r, tt.review)
			}
			if r := numbers(got.RecentlyMerged); r != tt.recent {
				t.Errorf("recently merged = %s, want %s", r, tt.recent)
			}
			if got.AuthoredTotal != tt.totals[0] || got.RecentlyMergedTotal != tt.totals[1] {
				t.Errorf("totals = %d, %d, want %v", got.AuthoredTotal, got.RecentlyMergedTotal, tt.totals)
			}
			if (len(done) == 1) != tt.done {
				t.Errorf("done = %v, want %t", done, tt.done)
			}
			if numbers(tt.d.Authored) != before {
				t.Error("the input dashboard was changed")
			}
		})
	}
}

// A merge from the app shows in the dashboard at once and stays shown while the
// searches still list the pull request as open; the poll still announces the merge,
// and once the searches agree the mark goes.
func TestMergeShownBeforeTheSearches(t *testing.T) {
	ctx := context.Background()
	var b *bus.Bus
	g, w, s, _, _ := mergeWorld(t, func(o *Options) { b = o.Bus })
	dash := bus.Subscribe[DashboardUpdated](b, 64)
	changes := bus.Subscribe[PullRequestChanged](b, 64)
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, w.fakeRunner)
	if a := s.Snapshot().Dashboard.Authored; len(a) != 1 || a[0].Number != 1 {
		t.Fatalf("authored before the merge = %+v", a)
	}
	drain(dash)
	drain(changes)

	if _, err := s.MergePullRequest(ctx, "o/r", 1, MergeRequest{Method: MergeSquash}); err != nil {
		t.Fatal(err)
	}
	shownMerged := func(when string) {
		t.Helper()
		d := s.Snapshot().Dashboard
		if len(d.Authored) != 0 || d.AuthoredTotal != 0 {
			t.Errorf("%s: authored = %+v (total %d), want #1 gone", when, d.Authored, d.AuthoredTotal)
		}
		n := 0
		for _, p := range d.RecentlyMerged {
			if p.Number == 1 {
				n++
				if p.State != PullRequestMerged || p.MergedAt.IsZero() {
					t.Errorf("%s: recently merged #1 = %+v", when, p)
				}
			}
		}
		if n != 1 {
			t.Errorf("%s: #1 is %d times in recently merged", when, n)
		}
	}
	shownMerged("at once")
	if drain(dash) == 0 {
		t.Error("no DashboardUpdated for the merge")
	}

	// The fake's searches still list #1 as authored (as GitHub's index does for a while).
	pollOnce(t, s, w.fakeRunner)
	shownMerged("after a lagging poll")
	// The poll's diff still sees the merge (its baseline is the dashboard it left).
	announced := false
	for len(changes.C()) > 0 {
		if e := <-changes.C(); e.Number == 1 && e.Has(ChangeMerged) {
			announced = true
		}
	}
	if !announced {
		t.Error("the poll did not announce #1's merge")
	}
	g.mu.Lock()
	g.sections[sectionAuthored] = nil
	g.sections[sectionMerged] = []string{"PR_1"}
	g.mu.Unlock()
	pollOnce(t, s, w.fakeRunner)
	shownMerged("after the searches agree")
	s.mergedShown.mu.Lock()
	marks, polled := len(s.mergedShown.marks), s.mergedShown.polled
	s.mergedShown.mu.Unlock()
	if marks != 0 || polled != nil {
		t.Errorf("marks = %d, polled = %v, want none once the searches agree", marks, polled != nil)
	}
	if !slices.ContainsFunc(s.Snapshot().Dashboard.RecentlyMerged, func(p PullRequest) bool { return p.ID == "PR_1" }) {
		t.Error("the searches' #1 is not in recently merged")
	}
}
