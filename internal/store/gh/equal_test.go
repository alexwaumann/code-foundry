package gh

import (
	"reflect"
	"testing"
	"time"
)

func TestTypedEqualityMatchesSameJSON(t *testing.T) {
	t0 := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	est := time.FixedZone("EST", -5*3600)

	t.Run("sameDashboard", func(t *testing.T) {
		a := sampleDashboard()
		b := sampleDashboard()
		// Fetch times and timezone locations are ignored.
		b.FetchedAt = t0.Add(time.Hour)
		b.Stats.FetchedAt = t0.Add(time.Hour)
		b.Stats.ClosedAt = t0.Add(time.Hour)
		b.Authored[0].UpdatedAt = b.Authored[0].UpdatedAt.In(est)
		if !sameDashboard(a, b) {
			t.Fatal("equivalent dashboards differed")
		}

		// Nil vs empty slice semantics match sameJSON.
		c := sampleDashboard()
		c.Authored = nil
		d := sampleDashboard()
		d.Authored = []PullRequest{}
		if sameDashboard(c, d) != sameJSON(c, d) {
			t.Errorf("nil vs empty Authored: sameDashboard=%v sameJSON=%v", sameDashboard(c, d), sameJSON(c, d))
		}

		mutations := []struct {
			name string
			fn   func(*Dashboard)
		}{
			{"LastError", func(x *Dashboard) { x.LastError = "err" }},
			{"Disabled", func(x *Dashboard) { x.Disabled = true }},
			{"AuthoredTotal", func(x *Dashboard) { x.AuthoredTotal++ }},
			{"ReviewRequestedTotal", func(x *Dashboard) { x.ReviewRequestedTotal++ }},
			{"ReviewedTotal", func(x *Dashboard) { x.ReviewedTotal++ }},
			{"RecentlyMergedTotal", func(x *Dashboard) { x.RecentlyMergedTotal++ }},
			{"ReviewedListed", func(x *Dashboard) { x.ReviewedListed++ }},
			{"Stats.LastError", func(x *Dashboard) { x.Stats.LastError = "boom" }},
			{"Stats.CommitsSource", func(x *Dashboard) { x.Stats.CommitsSource = CommitsFromContributions }},
			{"Stats.Months", func(x *Dashboard) { x.Stats.Months[0].Commits++ }},
			{"Authored.Title", func(x *Dashboard) { x.Authored[0].Title = "changed" }},
			{"Authored.Checks", func(x *Dashboard) { x.Authored[0].Checks.Passed++ }},
			{"Authored.LatestReviews", func(x *Dashboard) { x.Authored[0].LatestReviews[0].State = "DISMISSED" }},
			{"Authored.ReviewRequests", func(x *Dashboard) { x.Authored[0].ReviewRequests[0] = "dave" }},
			{"Authored.Draft", func(x *Dashboard) { x.Authored[0].Draft = true }},
			{"Authored.MergeStateStatus", func(x *Dashboard) { x.Authored[0].MergeStateStatus = "DIRTY" }},
			{"Authored.Partial", func(x *Dashboard) { x.Authored[0].Partial = true }},
			{"ReviewRequested", func(x *Dashboard) { x.ReviewRequested = x.ReviewRequested[:1] }},
			{"Reviewed", func(x *Dashboard) { x.Reviewed[0].Comments++ }},
			{"RecentlyMerged", func(x *Dashboard) { x.RecentlyMerged[0].MergedAt = t0.Add(5 * time.Hour) }},
		}
		for _, tc := range mutations {
			m := sampleDashboard()
			tc.fn(&m)
			if sameDashboard(a, m) {
				t.Errorf("mutation %s was not detected", tc.name)
			}
		}
	})

	t.Run("sameBranchCI", func(t *testing.T) {
		a := BranchCI{
			Branch: "main", SHA: "abc", Headline: "fix", CommittedAt: t0,
			Rollup:  CheckRollup{State: RollupFailure, Total: 2, Passed: 1, Failed: 1},
			Failing: []CheckRun{{Name: "test", Workflow: "ci", Status: StatusCompleted, Conclusion: ConclusionFailure, StartedAt: t0, CompletedAt: t0.Add(time.Minute), App: "github-actions"}},
		}
		b := a
		b.FetchedAt = t0.Add(time.Hour)
		b.CommittedAt = t0.In(est)
		if !sameBranchCI(a, b) {
			t.Fatal("equivalent BranchCI differed")
		}
		b.Failing = append([]CheckRun(nil), a.Failing...)
		b.Failing[0].Conclusion = ConclusionSuccess
		if sameBranchCI(a, b) {
			t.Error("failing check conclusion change not detected")
		}
	})

	t.Run("sameProjects", func(t *testing.T) {
		a := ProjectPullRequests{
			Open:   ProjectList{PullRequests: []PullRequest{fakePR("PR_1", "o/r", 1, t0)}, Total: 1, Query: "q1", WebQuery: "wq1"},
			Merged: ProjectList{PullRequests: []PullRequest{}, Total: 0, Query: "q2", WebQuery: "wq2"},
		}
		b := a
		b.FetchedAt = t0.Add(time.Hour)
		b.Open.Query, b.Open.WebQuery = "q1-moved", "wq1-moved"
		b.Merged.Query, b.Merged.WebQuery = "q2-moved", "wq2-moved"
		if !sameProjects(a, b) {
			t.Fatal("equivalent ProjectPullRequests differed")
		}
		b.Open.Total = 2
		if sameProjects(a, b) {
			t.Error("Open.Total change not detected")
		}
	})

	t.Run("sameFull", func(t *testing.T) {
		a := FullPullRequest{
			PullRequest:      fakePR("PR_1", "o/r", 1, t0),
			Body:             "body",
			Labels:           []Label{{Name: "bug", Color: "f00"}},
			Reviewers:        []Reviewer{{Login: "alice", State: "APPROVED", SubmittedAt: t0}},
			Commits:          []Commit{{SHA: "c1", Headline: "h", CommittedAt: t0}},
			Comments:         []Comment{{ID: "C1", Kind: CommentIssue, Body: "hi", CreatedAt: t0}},
			Threads:          []ReviewThread{{ID: "T1", Path: "a.go", Line: 1, Comments: []Comment{{ID: "RC1", Body: "nit", CreatedAt: t0}}}},
			Checks:           []CheckRun{{Name: "ci", Status: StatusCompleted, Conclusion: ConclusionSuccess}},
			MergeMethods:     []MergeMethod{MergeSquash},
			ViewerPermission: "WRITE",
			AutoMerge:        true,
			AutoMergeMethod:  MergeSquash,
			DefaultBranch:    "main",
		}
		b := a
		b.FetchedAt = t0.Add(time.Hour)
		b.LastError = "ignored"
		b.FetchFailed = true
		b.Refreshing = true
		if !sameFull(a, b) {
			t.Fatal("equivalent FullPullRequest differed")
		}
		b.Threads = []ReviewThread{{ID: "T1", Path: "a.go", Line: 1, Resolved: true, Comments: b.Threads[0].Comments}}
		if sameFull(a, b) {
			t.Error("thread resolved change not detected")
		}
	})
}

// TestTypedEqualityCoversAllFields uses reflection to guard against future struct fields
// being silently ignored by equal.go's typed equality helpers. Every exported field on
// each covered struct must either be detected by its helper or appear in its explicit
// ignore set.
func TestTypedEqualityCoversAllFields(t *testing.T) {
	t1 := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)

	var distinctValue func(typ reflect.Type) reflect.Value
	distinctValue = func(typ reflect.Type) reflect.Value {
		switch typ.Kind() {
		case reflect.Bool:
			return reflect.ValueOf(true).Convert(typ)
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			return reflect.ValueOf(int64(7)).Convert(typ)
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			return reflect.ValueOf(uint64(7)).Convert(typ)
		case reflect.String:
			return reflect.ValueOf("changed").Convert(typ)
		case reflect.Struct:
			if typ == reflect.TypeOf(time.Time{}) {
				return reflect.ValueOf(t1)
			}
			v := reflect.New(typ).Elem()
			for i := range typ.NumField() {
				f := typ.Field(i)
				if !f.IsExported() {
					continue
				}
				v.Field(i).Set(distinctValue(f.Type))
			}
			return v
		case reflect.Slice:
			s := reflect.MakeSlice(typ, 1, 1)
			s.Index(0).Set(distinctValue(typ.Elem()))
			return s
		default:
			t.Fatalf("unsupported field kind %s (%s) in reflection guard", typ.Kind(), typ)
			return reflect.Value{}
		}
	}

	checkStruct := func(t *testing.T, name string, base any, equal func(a, b any) bool, ignored map[string]bool) {
		t.Helper()
		t.Run(name, func(t *testing.T) {
			typ := reflect.TypeOf(base)
			for i := range typ.NumField() {
				f := typ.Field(i)
				if !f.IsExported() {
					continue
				}
				mut := reflect.New(typ).Elem()
				mut.Set(reflect.ValueOf(base))
				mut.Field(i).Set(distinctValue(f.Type))
				same := equal(base, mut.Interface())
				if ignored[f.Name] {
					if !same {
						t.Errorf("%s.%s is listed as ignored, yet equality reported a difference", name, f.Name)
					}
				} else if same {
					t.Errorf("%s.%s was mutated but typed equality still reported equal (update equal.go or ignore list)", name, f.Name)
				}
			}
		})
	}

	checkStruct(t, "Dashboard", Dashboard{},
		func(a, b any) bool { return sameDashboard(a.(Dashboard), b.(Dashboard)) },
		map[string]bool{"FetchedAt": true})
	checkStruct(t, "MonthlyStats", MonthlyStats{},
		func(a, b any) bool { return sameStats(a.(MonthlyStats), b.(MonthlyStats)) },
		map[string]bool{"FetchedAt": true, "ClosedAt": true})
	checkStruct(t, "MonthCount", MonthCount{},
		func(a, b any) bool { return a.(MonthCount) == b.(MonthCount) },
		nil)
	checkStruct(t, "BranchCI", BranchCI{},
		func(a, b any) bool { return sameBranchCI(a.(BranchCI), b.(BranchCI)) },
		map[string]bool{"FetchedAt": true})
	checkStruct(t, "ProjectPullRequests", ProjectPullRequests{},
		func(a, b any) bool { return sameProjects(a.(ProjectPullRequests), b.(ProjectPullRequests)) },
		map[string]bool{"FetchedAt": true})
	checkStruct(t, "ProjectList", ProjectList{},
		func(a, b any) bool {
			return sameProjects(ProjectPullRequests{Open: a.(ProjectList)}, ProjectPullRequests{Open: b.(ProjectList)})
		},
		map[string]bool{"Query": true, "WebQuery": true})
	checkStruct(t, "PullRequest", PullRequest{},
		func(a, b any) bool { return samePullRequestValue(a.(PullRequest), b.(PullRequest)) },
		nil)
	checkStruct(t, "FullPullRequest", FullPullRequest{},
		func(a, b any) bool { return sameFull(a.(FullPullRequest), b.(FullPullRequest)) },
		map[string]bool{"FetchedAt": true, "LastError": true, "FetchFailed": true, "Refreshing": true})
	checkStruct(t, "Review", Review{},
		func(a, b any) bool { return sameReviews([]Review{a.(Review)}, []Review{b.(Review)}) },
		nil)
	checkStruct(t, "CheckRun", CheckRun{},
		func(a, b any) bool { return sameCheckRuns([]CheckRun{a.(CheckRun)}, []CheckRun{b.(CheckRun)}) },
		nil)
	checkStruct(t, "Reviewer", Reviewer{},
		func(a, b any) bool { return sameReviewers([]Reviewer{a.(Reviewer)}, []Reviewer{b.(Reviewer)}) },
		nil)
	checkStruct(t, "Commit", Commit{},
		func(a, b any) bool { return sameCommits([]Commit{a.(Commit)}, []Commit{b.(Commit)}) },
		nil)
	checkStruct(t, "Comment", Comment{},
		func(a, b any) bool { return sameComments([]Comment{a.(Comment)}, []Comment{b.(Comment)}) },
		nil)
	checkStruct(t, "ReviewThread", ReviewThread{},
		func(a, b any) bool {
			return sameReviewThreads([]ReviewThread{a.(ReviewThread)}, []ReviewThread{b.(ReviewThread)})
		},
		nil)
	checkStruct(t, "Label", Label{},
		func(a, b any) bool { return a.(Label) == b.(Label) },
		nil)
	checkStruct(t, "CheckRollup", CheckRollup{},
		func(a, b any) bool { return a.(CheckRollup) == b.(CheckRollup) },
		nil)
}
