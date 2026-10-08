package gh

import (
	"errors"
	"testing"
	"time"
)

// Phase 3a fixtures (testdata/): real responses to the assembled queries, captured
// 2026-10-08. The authenticated account has no pull requests, so the searches were run
// for a public account (mitchellh, what Options.SearchAs does) in place of @me. REST
// search items are dropped; the viewer is sanitized to octocat.

func TestDecodeSearchPullRequests(t *testing.T) {
	tests := []struct {
		fixture    string
		total, n   int
		first      PullRequest
		withReview bool
	}{
		{
			fixture: "search_authored.json", total: 5, n: 5, withReview: true,
			first: PullRequest{
				Number: 12938, Title: "renderer: glyph protocol", Author: "mitchellh", Repo: "ghostty-org/ghostty",
				State: PullRequestOpen, HeadRef: "push-tuwykoykluyz", HeadSHA: "4b1d34c4a960a74746a73753b7d131fd46f20ba8",
				BaseRef: "main", ReviewDecision: ReviewRequired, URL: "https://github.com/ghostty-org/ghostty/pull/12938",
				CreatedAt: time.Date(2026, 6, 6, 3, 45, 36, 0, time.UTC),
				UpdatedAt: time.Date(2026, 6, 6, 4, 25, 7, 0, time.UTC),
				Checks:    CheckRollup{State: RollupSuccess, Total: 186, Passed: 174, Skipped: 12},
			},
		},
		{fixture: "search_review.json", total: 86, n: 6, withReview: true},
		{
			fixture: "search_merged.json", total: 12, n: 12,
			first: PullRequest{
				Number: 14530, Title: "libghostty-vt: zero the decode_png output before the callback",
				Author: "mitchellh", Repo: "ghostty-org/ghostty", State: PullRequestMerged,
				MergedAt: time.Date(2026, 10, 4, 13, 31, 41, 0, time.UTC),
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			r, err := decodeSearchPullRequests(fixtureData(t, tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			if r.Total != tt.total || len(r.PullRequests) != tt.n {
				t.Fatalf("total=%d n=%d, want %d/%d", r.Total, len(r.PullRequests), tt.total, tt.n)
			}
			for _, p := range r.PullRequests {
				if p.Repo == "" || p.Number == 0 || p.State == "" || p.URL == "" || p.CreatedAt.IsZero() {
					t.Errorf("incomplete: %+v", p)
				}
				if !tt.withReview && (p.ReviewDecision != "" || p.Checks.Total != 0) {
					t.Errorf("lean search has review fields: %+v", p)
				}
			}
			if tt.first.Number == 0 {
				return
			}
			got := r.PullRequests[0]
			w := tt.first
			if got.Number != w.Number || got.Title != w.Title || got.Author != w.Author || got.Repo != w.Repo ||
				got.State != w.State || got.ReviewDecision != w.ReviewDecision || got.Checks != w.Checks ||
				!got.MergedAt.Equal(w.MergedAt) {
				t.Errorf("first = %+v\nwant  %+v", got, w)
			}
			if w.HeadSHA != "" && (got.HeadSHA != w.HeadSHA || got.HeadRef != w.HeadRef || got.BaseRef != w.BaseRef ||
				got.URL != w.URL || !got.CreatedAt.Equal(w.CreatedAt) || !got.UpdatedAt.Equal(w.UpdatedAt)) {
				t.Errorf("first refs/times = %+v\nwant %+v", got, w)
			}
		})
	}
	if _, err := decodeSearchPullRequests([]byte(`{"rateLimit":{}}`)); err == nil {
		t.Error("missing search: want error")
	}
}

func TestDecodeStats(t *testing.T) {
	vs, err := decodeViewerStats(fixtureData(t, "viewer_stats.json"))
	if err != nil {
		t.Fatal(err)
	}
	if vs != (viewerStats{MergedThis: 4, MergedLast: 22, ContribThis: 35, ContribLast: 143}) {
		t.Errorf("viewer stats = %+v", vs)
	}
	if _, err := decodeViewerStats([]byte(`{"mergedThis":{"issueCount":1},"mergedLast":{"issueCount":1},"user":null}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown user err = %v", err)
	}

	rs, err := decodeRepoStats(fixtureData(t, "repo_stats.json"))
	if err != nil {
		t.Fatal(err)
	}
	if rs != (repoStats{CommitsThis: 22, CommitsLast: 127, MergedThis: 4, MergedLast: 22}) {
		t.Errorf("repo stats = %+v", rs)
	}
	empty, err := decodeRepoStats([]byte(`{"repository":{"defaultBranchRef":null},"mergedThis":{"issueCount":0},"mergedLast":{"issueCount":2}}`))
	if err != nil || empty != (repoStats{MergedLast: 2}) {
		t.Errorf("empty repo = %+v, %v", empty, err)
	}
	if _, err := decodeRepoStats([]byte(`{"repository":null}`)); !errors.Is(err, ErrNotFound) {
		t.Errorf("missing repo err = %v", err)
	}

	n, err := decodeSearchTotal(fixture(t, "search_commits.json"))
	if err != nil || n != 59 {
		t.Errorf("search/commits total = %d, %v; want 59", n, err)
	}
	if _, err := decodeSearchTotal([]byte(`{"message":"x"}`)); err == nil {
		t.Error("no total_count: want error")
	}

	id, err := decodeUserID(fixtureData(t, "user_id.json"))
	if err != nil || id != "MDQ6VXNlcjEyOTk=" {
		t.Errorf("user id = %q, %v", id, err)
	}
}

func TestDecodeBranchPullRequests(t *testing.T) {
	tests := []struct {
		fixture string
		login   string
		want    []int // kept numbers
	}{
		{"branch_pull_requests_open.json", "mitchellh", []int{12938}},
		{"branch_pull_requests_merged.json", "MitchellH", []int{14560}},
		{"branch_pull_requests_merged.json", "octocat", nil},
		{"branch_pull_requests_merged.json", "", []int{14560}},
		// A branch named like the default branch: every PR comes from a fork.
		{"branch_pull_requests_forks.json", "", nil},
		{"branch_pull_requests_none.json", "mitchellh", nil},
	}
	for _, tt := range tests {
		t.Run(tt.fixture+"/"+tt.login, func(t *testing.T) {
			prs, err := decodeBranchPullRequests(fixtureData(t, tt.fixture))
			if err != nil {
				t.Fatal(err)
			}
			var got []int
			for _, p := range keepViewerPullRequests(prs, tt.login) {
				got = append(got, p.Number)
			}
			if len(got) != len(tt.want) || (len(got) > 0 && got[0] != tt.want[0]) {
				t.Errorf("kept %v, want %v", got, tt.want)
			}
		})
	}
	prs, _ := decodeBranchPullRequests(fixtureData(t, "branch_pull_requests_merged.json"))
	if p := prs[0]; p.State != PullRequestMerged || p.MergedAt.IsZero() || p.Repo != "ghostty-org/ghostty" {
		t.Errorf("merged branch PR = %+v", p)
	}
}

func TestDecodeDefaultBranch(t *testing.T) {
	tests := []struct {
		fixture     string
		branch, sha string
		rollup      CheckRollup
		failing     []string
		more        bool
	}{
		{
			fixture: "pull_requests_default_branch_neovim.json", branch: "master",
			sha:     "27ee55c09d088c88b6c5ab5e8e2c4eaf86d6df71",
			rollup:  CheckRollup{State: RollupFailure, Total: 31, Passed: 30, Failed: 1},
			failing: []string{"windows / windows (functional)"},
		},
		{
			fixture: "pull_requests_default_branch_deno.json", branch: "main",
			sha:     "a18ce33715e30cd2b0d99c7e322ef11a65490e4d",
			rollup:  CheckRollup{State: RollupFailure, Total: 135, Passed: 133, Failed: 2},
			failing: []string{"test node_compat (1/3) release macos-x86_64"}, more: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.fixture, func(t *testing.T) {
			raw := decodeDefaultBranchField(fixtureData(t, tt.fixture))
			if raw == nil {
				t.Fatal("no default branch")
			}
			ci, next := mapDefaultBranch(raw)
			if ci.Branch != tt.branch || ci.SHA != tt.sha || ci.Rollup != tt.rollup || ci.CommittedAt.IsZero() || ci.Headline == "" {
				t.Errorf("ci = %+v", ci)
			}
			var names []string
			for _, r := range ci.Failing {
				names = append(names, r.Name)
				if r.URL == "" || r.Workflow == "" {
					t.Errorf("failing run lacks url/workflow: %+v", r)
				}
			}
			if len(names) != len(tt.failing) || names[0] != tt.failing[0] {
				t.Errorf("failing = %v, want %v", names, tt.failing)
			}
			if next.HasNextPage != tt.more {
				t.Errorf("hasNextPage = %v", next.HasNextPage)
			}
		})
	}
	// The phase 1c list fixtures do not select the default branch.
	if raw := decodeDefaultBranchField(fixtureData(t, "pull_requests_page1.json")); raw != nil {
		t.Errorf("page without withDefaultBranch decoded %+v", raw)
	}
}

func TestMonthWindows(t *testing.T) {
	ny := time.FixedZone("EST", -5*3600)
	tests := []struct {
		now              time.Time
		thisR, lastR     string
		thisLbl, lastLbl string
	}{
		{time.Date(2026, 10, 8, 4, 0, 0, 0, ny),
			"2026-10-01T00:00:00-05:00..2026-10-31T23:59:59-05:00",
			"2026-09-01T00:00:00-05:00..2026-09-30T23:59:59-05:00", "2026-10", "2026-09"},
		{time.Date(2027, 1, 1, 0, 0, 0, 0, ny),
			"2027-01-01T00:00:00-05:00..2027-01-31T23:59:59-05:00",
			"2026-12-01T00:00:00-05:00..2026-12-31T23:59:59-05:00", "2027-01", "2026-12"},
		{time.Date(2028, 3, 31, 23, 59, 0, 0, time.UTC),
			"2028-03-01T00:00:00+00:00..2028-03-31T23:59:59+00:00",
			"2028-02-01T00:00:00+00:00..2028-02-29T23:59:59+00:00", "2028-03", "2028-02"},
	}
	for _, tt := range tests {
		this, last := monthWindows(tt.now)
		if this.searchRange() != tt.thisR || last.searchRange() != tt.lastR || this.Label != tt.thisLbl || last.Label != tt.lastLbl {
			t.Errorf("monthWindows(%v) = %s %s / %s %s", tt.now, this.Label, this.searchRange(), last.Label, last.searchRange())
		}
	}
}

func TestDashboardSections(t *testing.T) {
	now := time.Date(2026, 10, 8, 4, 0, 0, 0, time.FixedZone("EST", -5*3600))
	got := dashboardSections("@me", now)
	want := []dashboardSection{
		{name: "authored", typ: "ISSUE", first: 50, review: true,
			query: "is:pr is:open archived:false author:@me sort:updated-desc"},
		{name: "review", typ: "ISSUE", first: 30, review: true,
			query: "is:pr is:open archived:false review-requested:@me sort:updated-desc"},
		{name: "merged", typ: "ISSUE_ADVANCED", first: 50,
			query: "is:pr is:merged merged:>=2026-10-01T04:00:00-05:00 (author:@me OR reviewed-by:@me OR assignee:@me) sort:updated-desc"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d sections", len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("section %d = %+v\nwant %+v", i, got[i], want[i])
		}
	}
}

func TestSameBranchCI(t *testing.T) {
	base := BranchCI{Branch: "main", SHA: "a", Rollup: CheckRollup{Total: 2, Failed: 1},
		Failing: []CheckRun{{Name: "x", URL: "u"}}, FetchedAt: time.Unix(1, 0)}
	later := base
	later.FetchedAt = time.Unix(99, 0)
	later.Failing = []CheckRun{{Name: "x", URL: "u"}}
	if !sameBranchCI(base, later) {
		t.Error("only FetchedAt differs: want same")
	}
	for name, mut := range map[string]func(*BranchCI){
		"sha":     func(c *BranchCI) { c.SHA = "b" },
		"rollup":  func(c *BranchCI) { c.Rollup.Failed = 0 },
		"failing": func(c *BranchCI) { c.Failing = []CheckRun{{Name: "y", URL: "u"}} },
		"error":   func(c *BranchCI) { c.LastError = "boom" },
	} {
		c := base
		c.Failing = append([]CheckRun(nil), base.Failing...)
		mut(&c)
		if sameBranchCI(base, c) {
			t.Errorf("%s changed: want different", name)
		}
	}
}
