package gh

import (
	"errors"
	"testing"
)

func TestDecodePullRequest(t *testing.T) {
	pr, p1, _, err := decodePullRequest(fixtureData(t, "pull_request_14586_page1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 14586 || pr.HeadRepoSlug != "kgni/ghostty" || pr.ReviewDecision != ReviewApproved || pr.Author != "kgni" ||
		pr.HeadSHA != "7b60f9bf5f057394038f81653eaa7cc5a55bb5df" || pr.ID != "PR_kwDOHFhdAs8AAAABHIegzw" ||
		pr.Comments != 9 || pr.Reviews != 2 || len(pr.LatestReviews) != 2 || pr.LatestReviews[1].Author != "trag1c" ||
		pr.LatestReviews[1].State != "APPROVED" || pr.Additions != 51 || pr.MergedAt.IsZero() {
		t.Errorf("pr = %+v", pr)
	}
	if p1.SHA != pr.HeadSHA || len(p1.Runs) != 100 || !p1.Next.HasNextPage || p1.Next.EndCursor != "MTAw" {
		t.Errorf("page1 sha=%s runs=%d next=%+v", p1.SHA, len(p1.Runs), p1.Next)
	}
	wantRollup := CheckRollup{State: RollupSuccess, Total: 105, Passed: 97, Skipped: 8}
	if p1.Rollup != wantRollup || pr.Checks != wantRollup {
		t.Errorf("rollup = %+v / %+v, want %+v", p1.Rollup, pr.Checks, wantRollup)
	}
	first := p1.Runs[0]
	if first.Name != "Milestone Update" || first.Workflow != "Milestone Action" || first.Status != StatusCompleted ||
		first.Conclusion != ConclusionSuccess || first.StartedAt.IsZero() || first.CompletedAt.IsZero() ||
		first.URL != "https://github.com/ghostty-org/ghostty/actions/runs/37739181637/job/113185665976" {
		t.Errorf("first run = %+v", first)
	}

	_, p2, _, err := decodePullRequest(fixtureData(t, "pull_request_14586_page2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Runs) != 5 || p2.Next.HasNextPage {
		t.Errorf("page2 runs=%d next=%+v", len(p2.Runs), p2.Next)
	}
	if _, _, _, err := decodePullRequest(fixtureData(t, "graphql_pr_not_found.json")); !errors.Is(err, ErrNotFound) {
		t.Errorf("not found err = %v", err)
	}
}

func TestDecodeChecks(t *testing.T) {
	page, _, err := decodeChecks(fixtureData(t, "checks_main.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := CheckRollup{State: RollupSuccess, Total: 54, Passed: 4, Skipped: 50}
	if page.SHA != "a60e9e2a57f73e1eef2bd1cf2995a467f69e7fb0" || page.Rollup != want || len(page.Runs) != 54 {
		t.Errorf("sha=%s rollup=%+v runs=%d", page.SHA, page.Rollup, len(page.Runs))
	}

	if _, _, err := decodeChecks(fixtureData(t, "checks_unknown_ref.json")); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown ref err = %v, want ErrNotFound", err)
	}
	if _, _, err := decodeChecks([]byte(`{"repository":{"object":{}}}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("non-commit ref err = %v, want ErrNotFound", err)
	}
}

func TestDecodeMixedStatusContexts(t *testing.T) {
	page, _, err := decodeChecks(fixtureData(t, "checks_mixed_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	wantRollup := CheckRollup{State: RollupFailure, Total: 6, Passed: 2, Failed: 2, Pending: 2}
	if page.Rollup != wantRollup {
		t.Errorf("rollup = %+v, want %+v", page.Rollup, wantRollup)
	}
	sortRuns(page.Runs)
	type nsc struct {
		name       string
		status     CheckStatus
		conclusion CheckConclusion
	}
	var got []nsc
	for _, r := range page.Runs {
		got = append(got, nsc{r.Name, r.Status, r.Conclusion})
	}
	// Failed first, then pending, passed, skipped; ties by workflow then name.
	want := []nsc{
		{"legacy/lint", StatusCompleted, ConclusionFailure},
		{"valgrind", StatusCompleted, ConclusionFailure},
		{"netlify/deploy-preview", StatusPending, ""},
		{page.Runs[3].Name, StatusInProgress, ""},
		{"ci/circleci: build", StatusCompleted, ConclusionSuccess},
		{page.Runs[5].Name, StatusCompleted, ConclusionSuccess},
	}
	if len(got) != len(want) {
		t.Fatalf("runs = %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("run %d = %+v, want %+v", i, got[i], want[i])
		}
	}
	for _, r := range page.Runs {
		if r.Name == "ci/circleci: build" && (r.Description == "" || r.URL == "" || r.StartedAt.IsZero()) {
			t.Errorf("status context lost fields: %+v", r)
		}
	}
}

func TestBucketOf(t *testing.T) {
	tests := []struct {
		state string
		want  checkBucket
	}{
		{"SUCCESS", bucketPassed},
		{"SKIPPED", bucketSkipped},
		{"NEUTRAL", bucketSkipped},
		{"STALE", bucketSkipped},
		{"FAILURE", bucketFailed},
		{"ERROR", bucketFailed},
		{"CANCELLED", bucketFailed},
		{"TIMED_OUT", bucketFailed},
		{"ACTION_REQUIRED", bucketFailed},
		{"STARTUP_FAILURE", bucketFailed},
		{"QUEUED", bucketPending},
		{"IN_PROGRESS", bucketPending},
		{"WAITING", bucketPending},
		{"PENDING", bucketPending},
		{"EXPECTED", bucketPending},
		{"SOMETHING_NEW", bucketPending},
	}
	for _, tt := range tests {
		if got := bucketOf(tt.state); got != tt.want {
			t.Errorf("bucketOf(%s) = %d, want %d", tt.state, got, tt.want)
		}
	}
}

func TestMapContext(t *testing.T) {
	tests := []struct {
		name string
		in   contextNodeJSON
		want CheckRun
		ok   bool
	}{
		{"check run without suite", contextNodeJSON{Typename: "CheckRun", Name: "lint", Status: "QUEUED"},
			CheckRun{Name: "lint", Status: StatusQueued}, true},
		{"status success", contextNodeJSON{Typename: "StatusContext", Context: "ci", State: "SUCCESS", TargetURL: "u"},
			CheckRun{Name: "ci", Status: StatusCompleted, Conclusion: ConclusionSuccess, URL: "u"}, true},
		{"status error", contextNodeJSON{Typename: "StatusContext", Context: "ci", State: "ERROR"},
			CheckRun{Name: "ci", Status: StatusCompleted, Conclusion: ConclusionFailure}, true},
		{"status failure", contextNodeJSON{Typename: "StatusContext", Context: "ci", State: "FAILURE"},
			CheckRun{Name: "ci", Status: StatusCompleted, Conclusion: ConclusionFailure}, true},
		{"status expected", contextNodeJSON{Typename: "StatusContext", Context: "ci", State: "EXPECTED"},
			CheckRun{Name: "ci", Status: StatusPending}, true},
		{"unknown type", contextNodeJSON{Typename: "Other"}, CheckRun{}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := mapContext(&tt.in)
			if ok != tt.ok || got != tt.want {
				t.Errorf("mapContext = %+v, %v; want %+v, %v", got, ok, tt.want, tt.ok)
			}
		})
	}
}
