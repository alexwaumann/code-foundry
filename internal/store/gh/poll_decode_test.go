package gh

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

// The poll fixtures are real responses to pollPlan.build documents, captured
// 2026-10-08 (zz: see docs/notes/gh-viewer-polling.md for the recipe):
//
//   - poll_partial.json: the authenticated account (no pull requests), viewer sanitized
//     to octocat, with a repository that does not exist (a partial error at r3).
//   - poll_populated.json: the same plan with mitchellh in place of @me (what
//     Options.SearchAs does), for populated lists and stats.
//
// Both used fixturePlan.
func fixturePlan(login string) *pollPlan {
	now := time.Date(2026, 10, 8, 20, 18, 0, 0, time.FixedZone("CDT", -5*3600))
	this, last := monthWindows(now)
	return &pollPlan{
		sections: dashboardSections(login, now),
		repos: []repoPlan{
			{slug: "alexwaumann/code-foundry", defaultBranch: true, branches: []string{"main", "t3code/review-gh-git-diff-services"}, history: true},
			{slug: "ghostty-org/ghostty", defaultBranch: true, history: true},
			{slug: "neovim/neovim", defaultBranch: true},
			{slug: "alexwaumann/does-not-exist-xyz", defaultBranch: true},
		},
		stats: &statsPlan{this: this, last: last, login: login, author: "A", me: login},
	}
}

func decodeFixturePoll(t *testing.T, name string, plan *pollPlan) pollResult {
	t.Helper()
	data, err := parseGraphQLResponse(httpResult{status: 200, body: fixture(t, name)})
	var partial *PartialError
	if err != nil && !errors.As(err, &partial) {
		t.Fatal(err)
	}
	res, err := decodePoll(plan, data, partial)
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func TestDecodePollPopulated(t *testing.T) {
	res := decodeFixturePoll(t, "poll_populated.json", fixturePlan("mitchellh"))
	if res.Viewer == nil || res.Viewer.Login != "octocat" || res.Viewer.ID == "" {
		t.Errorf("viewer = %+v", res.Viewer)
	}
	tests := []struct {
		section  string
		total, n int
	}{
		{sectionAuthored, 5, 5},
		{sectionReview, 87, 50},
		{sectionReviewed, 36, 36},
		{sectionMerged, 9, 9},
	}
	for _, tt := range tests {
		r := res.Sections[tt.section]
		if r.Err != nil || r.Total != tt.total || len(r.PRs) != tt.n {
			t.Errorf("%s: total %d, %d PRs, err %v; want %d, %d", tt.section, r.Total, len(r.PRs), r.Err, tt.total, tt.n)
		}
	}
	want := prFingerprint{
		ID: "PR_kwDOHFhdAs7jWSZB", Number: 12938, Repo: "ghostty-org/ghostty",
		UpdatedAt: time.Date(2026, 6, 6, 4, 25, 7, 0, time.UTC), State: PullRequestOpen,
		HeadSHA: "4b1d34c4a960a74746a73753b7d131fd46f20ba8", Author: "mitchellh", HasChecks: true,
		Checks: CheckRollup{State: RollupSuccess, Total: 186, Passed: 174, Skipped: 12},
	}
	if got := res.Sections[sectionAuthored].PRs[0]; got != want {
		t.Errorf("authored[0] = %+v\nwant %+v", got, want)
	}
	// Merged PRs carry identity only.
	if m := res.Sections[sectionMerged].PRs[0]; m.HasChecks || m.State != PullRequestMerged || !m.IsCross || m.Number != 14588 {
		t.Errorf("merged[0] = %+v", m)
	}

	cf := res.Repos["alexwaumann/code-foundry"]
	if cf.Err != nil || cf.DefaultBranch == nil || cf.DefaultBranch.SHA != "a0a498be5609f463418f939f9d333c898770393b" ||
		cf.DefaultBranch.Branch != "main" || cf.DefaultBranch.Headline == "" || cf.DefaultBranch.Rollup.Total != 1 {
		t.Errorf("code-foundry = %+v %+v", cf, cf.DefaultBranch)
	}
	if b, ok := cf.Branches["main"]; !ok || len(b) != 0 || len(cf.BranchErr) != 0 {
		t.Errorf("branches = %+v, errs %v", cf.Branches, cf.BranchErr)
	}
	if g := res.Repos["ghostty-org/ghostty"]; g.History == nil || *g.History != [2]int{23, 127} {
		t.Errorf("ghostty history = %v", g.History)
	}
	if n := res.Repos["neovim/neovim"]; n.DefaultBranch == nil || n.DefaultBranch.Branch != "master" || n.History != nil {
		t.Errorf("neovim = %+v", n)
	}
	if gone := res.Repos["alexwaumann/does-not-exist-xyz"]; !errors.Is(gone.Err, ErrNotFound) || gone.DefaultBranch != nil {
		t.Errorf("missing repository = %+v", gone)
	}
	st := res.Stats
	if st == nil || st.Err != nil || st.MergedThis != 4 || st.MergedLast != 22 || st.RecentTotal != 26 || len(st.Recent) != 26 ||
		!st.HasContrib || st.ContribThis != 36 || st.ContribLast != 143 || st.Recent[0].Repo != "ghostty-org/ghostty" {
		t.Errorf("stats = %+v", st)
	}
}

func TestDecodePollPartial(t *testing.T) {
	res := decodeFixturePoll(t, "poll_partial.json", fixturePlan("@me"))
	for _, sec := range []string{sectionAuthored, sectionReview, sectionReviewed, sectionMerged} {
		if r := res.Sections[sec]; r.Err != nil || r.Total != 0 || len(r.PRs) != 0 {
			t.Errorf("%s = %+v", sec, r)
		}
	}
	if h := res.Repos["alexwaumann/code-foundry"].History; h == nil || h[0] != 135 {
		t.Errorf("history = %v", h)
	}
	if gone := res.Repos["alexwaumann/does-not-exist-xyz"]; !errors.Is(gone.Err, ErrNotFound) {
		t.Errorf("missing repository err = %v", gone.Err)
	}
	if st := res.Stats; st == nil || st.ContribThis != 214 || st.MergedThis != 0 {
		t.Errorf("stats = %+v", st)
	}
}

func TestDecodePollErrors(t *testing.T) {
	plan := fixturePlan("@me")
	if _, err := decodePoll(plan, []byte(`{"viewer":null}`), nil); !errors.Is(err, ErrNotAuthenticated) {
		t.Errorf("null viewer err = %v", err)
	}
	if _, err := decodePoll(plan, []byte(`not json`), nil); err == nil {
		t.Error("bad JSON: want error")
	}
	// A search that failed alone is that section's error.
	pe := &PartialError{Errors: []graphQLError{{Type: "SERVICE_UNAVAILABLE", Message: "search down", Path: []any{"s_review"}}}}
	res, err := decodePoll(plan, []byte(`{"viewer":{"login":"octocat"},"s_review":null}`), pe)
	if err != nil {
		t.Fatal(err)
	}
	if e := res.Sections[sectionReview].Err; e == nil || e.Error() != "github graphql: search down" {
		t.Errorf("review section err = %v", e)
	}
	// A section the plan asked for but the response lacks is an error too.
	if res.Sections[sectionAuthored].Err == nil {
		t.Error("missing section: want an error")
	}
}

func TestDecodeDetails(t *testing.T) {
	got, err := decodeDetails(fixtureData(t, "pull_request_details.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("details = %d, want 5", len(got))
	}
	p := got["PR_kwDOHFhdAs7jWSZB"]
	if p.Number != 12938 || p.Repo != "ghostty-org/ghostty" || p.MergeStateStatus != "DIRTY" || p.Mergeable != MergeableConflicting ||
		p.ReviewDecision != ReviewRequired || p.Additions != 809 || p.Comments != 1 || p.Title == "" || p.HeadRepoSlug != "ghostty-org/ghostty" ||
		p.Checks.Total != 186 || p.State != PullRequestOpen || p.Partial {
		t.Errorf("open detail = %+v", p)
	}
	// Team requests the token cannot see come back null and are skipped.
	if len(p.ReviewRequests) != 0 {
		t.Errorf("review requests = %v", p.ReviewRequests)
	}
	m := got["PR_kwDOHFhdAs8AAAABHOg8hA"]
	if m.State != PullRequestMerged || m.MergedAt.IsZero() || m.MergeStateStatus != "" || m.Title == "" {
		t.Errorf("merged summary = %+v", m)
	}
	// A deleted pull request is a null node.
	if got, err := decodeDetails([]byte(`{"open":[null],"closed":[]}`)); err != nil || len(got) != 0 {
		t.Errorf("null node: %v %v", got, err)
	}
}

func TestDecodeDefaultBranchChecks(t *testing.T) {
	reqs := []ciRequest{{"neovim/neovim", "402a494f47808442f3de9266b147b274f8c7a5be"}, {"alexwaumann/code-foundry", "cfd8bdf4f3da13280a2186a0be3cbcb88fa1dd7e"}}
	pages, errs := decodeDefaultBranchChecks(reqs, fixtureData(t, "default_branch_checks.json"), nil)
	if len(errs) != 0 {
		t.Fatalf("errs = %v", errs)
	}
	if p := pages["neovim/neovim"]; p.SHA != reqs[0].sha || len(p.Runs) != 31 || p.Rollup.Total != 31 {
		t.Errorf("neovim = sha %s, %d runs, %+v", p.SHA, len(p.Runs), p.Rollup)
	}
	if p := pages["alexwaumann/code-foundry"]; len(p.Runs) != 1 || p.Runs[0].Workflow != "ci" {
		t.Errorf("code-foundry = %+v", p)
	}
	_, errs = decodeDefaultBranchChecks(reqs[:1], []byte(`{"r0":{"object":null}}`), nil)
	if !errors.Is(errs["neovim/neovim"], ErrNotFound) {
		t.Errorf("unknown head err = %v", errs)
	}
}

func TestReviewerName(t *testing.T) {
	tests := []struct {
		in   *requestedReviewerJSON
		want string
	}{
		{nil, ""},
		{&requestedReviewerJSON{Typename: "User", Login: "kim"}, "kim"},
		{&requestedReviewerJSON{Typename: "Bot", Login: "copilot"}, "copilot"},
		{&requestedReviewerJSON{Typename: "Team", Slug: "core", Organization: &loginJSON{Login: "acme"}}, "acme/core"},
		{&requestedReviewerJSON{Typename: "Team", Slug: "core"}, "core"},
	}
	for _, tt := range tests {
		if got := reviewerName(tt.in); got != tt.want {
			t.Errorf("reviewerName(%+v) = %q, want %q", tt.in, got, tt.want)
		}
	}
}

func TestNeedsDetail(t *testing.T) {
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	known := fakePR("P", "o/r", 1, t0)
	fp := prFingerprint{ID: "P", Number: 1, Repo: "o/r", UpdatedAt: t0, State: PullRequestOpen, HeadSHA: known.HeadSHA,
		HasChecks: true, Checks: known.Checks}
	tests := []struct {
		name string
		k    func(*PullRequest)
		f    func(*prFingerprint)
		ok   bool
		want bool
	}{
		{"unchanged", nil, nil, true, false},
		{"unknown", nil, nil, false, true},
		{"placeholder", func(p *PullRequest) { p.Partial = true }, nil, true, true},
		{"updatedAt", nil, func(f *prFingerprint) { f.UpdatedAt = t0.Add(time.Second) }, true, true},
		{"state", nil, func(f *prFingerprint) { f.State = PullRequestMerged }, true, true},
		{"head", nil, func(f *prFingerprint) { f.HeadSHA = "x" }, true, true},
		{"rollup state", nil, func(f *prFingerprint) { f.Checks.State = RollupPending }, true, true},
		{"counts only", nil, func(f *prFingerprint) { f.Checks.Passed, f.Checks.Total = 9, 9 }, true, false},
		{"no checks selected", nil, func(f *prFingerprint) { f.HasChecks, f.Checks = false, CheckRollup{} }, true, false},
		{"open, stored as summary", func(p *PullRequest) { p.Mergeable, p.MergeStateStatus = "", "" }, nil, true, true},
	}
	for _, tt := range tests {
		k, f := known, fp
		if tt.k != nil {
			tt.k(&k)
		}
		if tt.f != nil {
			tt.f(&f)
		}
		s := &Store{recheck: map[string]int{}}
		if got := s.needsDetail(k, tt.ok, f); got != tt.want {
			t.Errorf("%s: needsDetail = %v, want %v", tt.name, got, tt.want)
		}
	}
	// A pending mergeability recheck refetches, a limited number of times.
	s := &Store{recheck: map[string]int{"P": 2}}
	var got []bool
	for range 3 {
		got = append(got, s.needsDetail(known, true, fp))
	}
	if fmt.Sprint(got) != "[true true false]" {
		t.Errorf("recheck refetches = %v, want [true true false]", got)
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
		if !this.contains(this.Start) || !this.contains(this.End) || this.contains(last.End) {
			t.Errorf("contains(%v) wrong", tt.now)
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
