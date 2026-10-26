package gh

import (
	"errors"
	"fmt"
	"slices"
	"testing"
	"time"
)

// The poll fixtures are real responses to pollPlan.build documents, captured
// 2026-10-08 (see docs/notes/gh-viewer-polling.md for the recipe); their stats part
// (m<k>, r<i>_m<k>, contributions, r<i>.history) was recaptured on 2026-10-17 for six
// months (docs/notes/gh-stats-six-months.md):
//
//   - poll_partial.json: the authenticated account (no pull requests), viewer sanitized
//     to octocat, with a repository that does not exist (a partial error at r3).
//   - poll_populated.json: the same plan with mitchellh in place of @me (what
//     Options.SearchAs does), for populated lists and stats.
//
// Both used fixturePlan.
func fixturePlan(login string) *pollPlan {
	now := time.Date(2026, 10, 8, 20, 18, 0, 0, time.FixedZone("CDT", -5*3600))
	all := monthWindows(now, statsMonths)
	return &pollPlan{
		sections: dashboardSections(login, now),
		repos: []repoPlan{
			{slug: "alexwaumann/code-foundry", defaultBranch: true, branches: []string{"main", "t3code/review-gh-git-diff-services"}, months: all},
			{slug: "ghostty-org/ghostty", defaultBranch: true, months: all},
			{slug: "neovim/neovim", defaultBranch: true},
			{slug: "alexwaumann/does-not-exist-xyz", defaultBranch: true},
		},
		stats: &statsPlan{all: all, months: all, login: login, author: "A", me: login},
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
	// Per repository, six months newest first: commits on the default branch and
	// exact merged counts (one first: 0 search per month).
	if g := res.Repos["ghostty-org/ghostty"]; g.StatsErr != nil || fmt.Sprint(g.Commits) != "[75 127 455 268 47 83]" ||
		fmt.Sprint(g.Merged) != "[13 22 126 42 5 9]" {
		t.Errorf("ghostty commits = %v, merged = %v, err %v", g.Commits, g.Merged, g.StatsErr)
	}
	if n := res.Repos["neovim/neovim"]; n.DefaultBranch == nil || n.DefaultBranch.Branch != "master" || n.Commits != nil || n.Merged != nil {
		t.Errorf("neovim = %+v", n)
	}
	if gone := res.Repos["alexwaumann/does-not-exist-xyz"]; !errors.Is(gone.Err, ErrNotFound) || gone.DefaultBranch != nil {
		t.Errorf("missing repository = %+v", gone)
	}
	st := res.Stats
	if st == nil || st.Err != nil || fmt.Sprint(st.Merged) != "[13 22 126 42 7 11]" || !st.HasContrib ||
		fmt.Sprint(st.Contrib) != "[84 143 478 300 72 142]" {
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
	if cf := res.Repos["alexwaumann/code-foundry"]; fmt.Sprint(cf.Commits) != "[1462 0 0 0 0 0]" || fmt.Sprint(cf.Merged) != "[153 0 0 0 0 0]" {
		t.Errorf("code-foundry commits = %v, merged = %v", cf.Commits, cf.Merged)
	}
	if gone := res.Repos["alexwaumann/does-not-exist-xyz"]; !errors.Is(gone.Err, ErrNotFound) {
		t.Errorf("missing repository err = %v", gone.Err)
	}
	if st := res.Stats; st == nil || fmt.Sprint(st.Contrib) != "[1524 0 0 0 0 0]" || fmt.Sprint(st.Merged) != "[153 0 0 0 0 0]" {
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

// TestDecodeDetailsReviewCommits decodes a real capture of open pull requests whose
// latest reviews are on the current head (14693) and on older commits (14815, 14318),
// plus a merged one (summary only, no reviews).
func TestDecodeDetailsReviewCommits(t *testing.T) {
	got, err := decodeDetails(fixtureData(t, "pull_request_details_reviews.json"))
	if err != nil {
		t.Fatal(err)
	}
	type review struct{ author, state, commit string }
	tests := []struct {
		id      string
		head    string
		reviews []review
	}{
		{"PR_kwDOHFhdAs8AAAABKJ9v7Q", "3085c8ea685bfcfffaa06c6d0e7a287bb0696da5", []review{
			{"mitchellh", "CHANGES_REQUESTED", "fece54e14b936559065ff957ef3283ee41e75d9a"},
			{"jcollie", "APPROVED", "fece54e14b936559065ff957ef3283ee41e75d9a"},
		}},
		{"PR_kwDOHFhdAs8AAAABIS8BwQ", "09bd8e5591677ca3a3508a569dded3c8c5578c6a", []review{
			{"jcollie", "CHANGES_REQUESTED", "09bd8e5591677ca3a3508a569dded3c8c5578c6a"},
		}},
		{"PR_kwDOHFhdAs8AAAABESLwlQ", "687307d71c10b9bfef286664e06b7d07b4e78106", []review{
			{"jcollie", "COMMENTED", "b09721d1b0e124c4bd05f38ee1bbb0b3c962089d"},
			{"trag1c", "CHANGES_REQUESTED", "00a28201b3ed63a61d4065c8e98318d065c1bac4"},
		}},
	}
	for _, tt := range tests {
		p, ok := got[tt.id]
		if !ok {
			t.Errorf("%s: missing", tt.id)
			continue
		}
		if p.HeadSHA != tt.head || !p.ReviewCommits {
			t.Errorf("%s: head %s reviewCommits %v", tt.id, p.HeadSHA, p.ReviewCommits)
		}
		var have []review
		for _, r := range p.LatestReviews {
			if r.SubmittedAt.IsZero() {
				t.Errorf("%s: %s has no submittedAt", tt.id, r.Author)
			}
			have = append(have, review{r.Author, r.State, r.CommitSHA})
		}
		if !slices.Equal(have, tt.reviews) {
			t.Errorf("%s: reviews = %v, want %v", tt.id, have, tt.reviews)
		}
	}
	m := got["PR_kwDOHFhdAs8AAAABHOg8hA"]
	if m.State != PullRequestMerged || len(m.LatestReviews) != 0 || m.ReviewCommits {
		t.Errorf("merged summary = %+v", m)
	}
	// A review GitHub has no commit for decodes with an empty CommitSHA.
	null := []byte(`{"open":[{"__typename":"PullRequest","id":"P","state":"OPEN","latestReviews":{"nodes":[{"author":{"login":"a"},"state":"COMMENTED","commit":null}]}}],"closed":[]}`)
	if got, err := decodeDetails(null); err != nil || len(got["P"].LatestReviews) != 1 || got["P"].LatestReviews[0].CommitSHA != "" || !got["P"].ReviewCommits {
		t.Errorf("null commit: %+v %v", got["P"], err)
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
		{"reviews without commits", func(p *PullRequest) { p.LatestReviews, p.ReviewCommits = []Review{{Author: "a"}}, false }, nil, true, true},
		{"reviews with commits", func(p *PullRequest) { p.LatestReviews, p.ReviewCommits = []Review{{Author: "a"}}, true }, nil, true, false},
		{"merged, reviews without commits", func(p *PullRequest) {
			p.State, p.LatestReviews, p.ReviewCommits = PullRequestMerged, []Review{{Author: "a"}}, false
		}, func(f *prFingerprint) { f.State = PullRequestMerged }, true, false},
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
		{time.Date(2027, 2, 10, 9, 0, 0, 0, ny),
			"2027-02-01T00:00:00-05:00..2027-02-28T23:59:59-05:00",
			"2027-01-01T00:00:00-05:00..2027-01-31T23:59:59-05:00", "2027-02", "2027-01"},
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
		ws := monthWindows(tt.now, 2)
		this, last := ws[0], ws[1]
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
