package gh

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Fixtures in testdata/ are real `gh api graphql` responses captured from
// ghostty-org/ghostty with the queries in queries/ (viewer identity sanitized), except
// files named *_synthetic.json. See docs/notes/phase1c-gh.md.

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// fixtureData returns a fixture's "data" object, as Runner.GraphQL does.
func fixtureData(t *testing.T, name string) json.RawMessage {
	t.Helper()
	data, err := parseGraphQLOutput(0, fixture(t, name), nil)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return data
}

func TestDecodeViewer(t *testing.T) {
	v, rl, err := decodeViewer(fixtureData(t, "viewer.json"))
	if err != nil {
		t.Fatal(err)
	}
	want := Viewer{Login: "octocat", Name: "The Octocat",
		AvatarURL: "https://avatars.githubusercontent.com/u/583231?v=4", URL: "https://github.com/octocat"}
	if v != want {
		t.Errorf("viewer = %+v, want %+v", v, want)
	}
	if rl == nil || rl.Limit != 5000 || rl.Cost != 1 || rl.ResetAt.IsZero() {
		t.Errorf("rateLimit = %+v", rl)
	}
	if _, _, err := decodeViewer([]byte(`{"viewer":null}`)); !errors.Is(err, ErrNotAuthenticated) {
		t.Errorf("null viewer err = %v, want ErrNotAuthenticated", err)
	}
}

func TestDecodePullRequestsPage(t *testing.T) {
	page, rl, err := decodePullRequestsPage(fixtureData(t, "pull_requests_page1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if rl == nil || rl.Remaining == 0 {
		t.Errorf("rateLimit = %+v", rl)
	}
	if page.TotalCount != 129 || len(page.PullRequests) != 25 {
		t.Fatalf("total=%d len=%d, want 129/25", page.TotalCount, len(page.PullRequests))
	}
	if !page.Next.HasNextPage || page.Next.EndCursor == "" {
		t.Errorf("pageInfo = %+v, want a next page", page.Next)
	}
	byNum := map[int]PullRequest{}
	for _, pr := range page.PullRequests {
		byNum[pr.Number] = pr
	}

	got := byNum[13745]
	want := PullRequest{
		Number: 13745, Title: "macos,gtk: add broadcast support to sync across panes",
		Author: "dave92082", HeadRef: "feature/multi-pane-broadcast",
		HeadSHA: "72607587674b4d15922dcc024d6911d87b0b2711", BaseRef: "main",
		ReviewDecision: ReviewChangesRequested, Mergeable: MergeableMergeable,
		IsCrossRepository: true, URL: "https://github.com/ghostty-org/ghostty/pull/13745",
		UpdatedAt: time.Date(2026, 10, 8, 6, 1, 42, 0, time.UTC),
		Checks:    CheckRollup{State: RollupSuccess, Total: 102, Passed: 97, Skipped: 5},
	}
	if !got.UpdatedAt.Equal(want.UpdatedAt) {
		t.Errorf("updatedAt = %v, want %v", got.UpdatedAt, want.UpdatedAt)
	}
	got.UpdatedAt = want.UpdatedAt
	if got != want {
		t.Errorf("PR 13745 =\n %+v\nwant\n %+v", got, want)
	}

	rollups := []struct {
		number int
		want   CheckRollup
	}{
		{14586, CheckRollup{State: RollupSuccess, Total: 104, Passed: 96, Skipped: 8}},
		{13776, CheckRollup{State: RollupFailure, Total: 103, Passed: 99, Failed: 2, Skipped: 2}},
		{13605, CheckRollup{}}, // statusCheckRollup: null (no checks ran)
	}
	for _, tt := range rollups {
		if got := byNum[tt.number].Checks; got != tt.want {
			t.Errorf("PR %d checks = %+v, want %+v", tt.number, got, tt.want)
		}
	}
	if pr := byNum[14055]; !pr.Draft || pr.Checks.State != RollupPending || pr.Checks.Pending != 4 {
		t.Errorf("PR 14055 = draft %v checks %+v, want draft with 4 pending", pr.Draft, pr.Checks)
	}

	page2, _, err := decodePullRequestsPage(fixtureData(t, "pull_requests_page2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(page2.PullRequests) != 25 || page2.PullRequests[0].Number != 13779 {
		t.Errorf("page2 len=%d first=%d", len(page2.PullRequests), page2.PullRequests[0].Number)
	}
}

func TestDecodePullRequest(t *testing.T) {
	pr, p1, _, err := decodePullRequest(fixtureData(t, "pull_request_14586_page1.json"))
	if err != nil {
		t.Fatal(err)
	}
	if pr.Number != 14586 || pr.HeadRepoSlug != "kgni/ghostty" || pr.MergeStateStatus != "BLOCKED" ||
		pr.HeadSHA != "7b60f9bf5f057394038f81653eaa7cc5a55bb5df" {
		t.Errorf("pr = %+v", pr)
	}
	if p1.SHA != pr.HeadSHA || len(p1.Runs) != 100 || !p1.Next.HasNextPage || p1.Next.EndCursor != "MTAw" {
		t.Errorf("page1 sha=%s runs=%d next=%+v", p1.SHA, len(p1.Runs), p1.Next)
	}
	wantRollup := CheckRollup{State: RollupSuccess, Total: 104, Passed: 96, Skipped: 8}
	if p1.Rollup != wantRollup || pr.Checks != wantRollup {
		t.Errorf("rollup = %+v / %+v, want %+v", p1.Rollup, pr.Checks, wantRollup)
	}
	first := p1.Runs[0]
	if first.Name != "check-zig-cache-hash" || first.Workflow != "Nix" || first.Status != StatusCompleted ||
		first.Conclusion != ConclusionSuccess || first.StartedAt.IsZero() || first.CompletedAt.IsZero() ||
		first.URL != "https://github.com/ghostty-org/ghostty/actions/runs/37631637544/job/112890661487" {
		t.Errorf("first run = %+v", first)
	}

	_, p2, _, err := decodePullRequest(fixtureData(t, "pull_request_14586_page2.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(p2.Runs) != 4 || p2.Next.HasNextPage {
		t.Errorf("page2 runs=%d next=%+v", len(p2.Runs), p2.Next)
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
