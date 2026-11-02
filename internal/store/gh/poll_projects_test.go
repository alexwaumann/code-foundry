package gh

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
)

// setTotal makes section's issueCount n (a capped list).
func (g *fakeGitHub) setTotal(section string, n int) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.totals == nil {
		g.totals = map[string]int{}
	}
	g.totals[section] = n
}

func TestProjectSections(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 30, 0, 0, time.UTC)
	tests := []struct {
		name       string
		login      string
		slugs      []string
		wantOpen   string
		wantMerged string
	}{
		{name: "nothing tracked", login: "@me"},
		{
			name: "one repository", login: "@me", slugs: []string{"o/r"},
			wantOpen:   "is:pr is:open archived:false repo:o/r -author:@me -reviewed-by:@me -review-requested:@me sort:updated-desc",
			wantMerged: "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 repo:o/r sort:updated-desc",
		},
		{
			name: "several repositories, search as a login", login: "mitchellh", slugs: []string{"a/one", "a/two", "b/three"},
			wantOpen:   "is:pr is:open archived:false repo:a/one repo:a/two repo:b/three -author:mitchellh -reviewed-by:mitchellh -review-requested:mitchellh sort:updated-desc",
			wantMerged: "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 repo:a/one repo:a/two repo:b/three sort:updated-desc",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := projectSections(tt.login, tt.slugs, now)
			if tt.wantOpen == "" {
				if got != nil {
					t.Fatalf("sections = %+v, want none", got)
				}
				return
			}
			if len(got) != 2 {
				t.Fatalf("sections = %+v, want open and merged", got)
			}
			open, merged := got[0], got[1]
			if open.name != sectionProjectOpen || open.query != tt.wantOpen || open.first != searchFirstProjectOpen || !open.checks {
				t.Errorf("open = %+v\nwant query %s", open, tt.wantOpen)
			}
			if merged.name != sectionProjectMerged || merged.query != tt.wantMerged || merged.first != searchFirstProjectMerged || merged.checks {
				t.Errorf("merged = %+v\nwant query %s", merged, tt.wantMerged)
			}
			// ISSUE ORs repeated repo: qualifiers; ISSUE_ADVANCED ANDs them and silently
			// finds nothing (verified against GitHub 2026-11-02).
			for _, sec := range got {
				if sec.typ != "ISSUE" {
					t.Errorf("%s type = %s, want ISSUE", sec.name, sec.typ)
				}
			}
		})
	}
}

// The merged search covers the same window as the dashboard's recently merged list.
func TestProjectSectionsMergedWindowMatchesDashboard(t *testing.T) {
	now := time.Date(2026, 11, 2, 12, 30, 0, 0, time.FixedZone("CST", -6*3600))
	var dash string
	for _, sec := range dashboardSections("@me", now) {
		if sec.name == sectionMerged {
			dash = sec.query
		}
	}
	merged := projectSections("@me", []string{"o/r"}, now)[1].query
	since := "merged:>=" + now.Add(-recentlyMergedWindow).Format(searchTimeLayout)
	if !strings.Contains(dash, since) || !strings.Contains(merged, since) {
		t.Errorf("dashboard %q, projects %q, want both %q", dash, merged, since)
	}
}

func TestProjectsDocument(t *testing.T) {
	plan := pollPlan{projects: true, sections: projectSections("@me", []string{"o/r", "o/s"}, time.Now())}
	doc, vars, err := plan.build()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(doc, "query PollProjects(") {
		t.Errorf("doc starts %.40q, want query PollProjects", doc)
	}
	for _, want := range []string{
		"s_project_open: search(query: $q_project_open, type: ISSUE, first: 50) { issueCount nodes { __typename ...PullRequestFingerprint } }",
		"s_project_merged: search(query: $q_project_merged, type: ISSUE, first: 50) { issueCount nodes { __typename ...PullRequestIdentity } }",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("doc lacks %q:\n%s", want, doc)
		}
	}
	if strings.Contains(doc, "ISSUE_ADVANCED") || strings.Contains(doc, "repository(") {
		t.Errorf("doc has more than the two ISSUE searches:\n%s", doc)
	}
	if q, _ := vars["q_project_open"].(string); !strings.Contains(q, "repo:o/r repo:o/s ") {
		t.Errorf("q_project_open = %q", q)
	}
}

func TestProjectListSearchURL(t *testing.T) {
	tests := []struct {
		query, want string
	}{
		{"", ""},
		{"is:pr is:open repo:o/r -author:@me sort:updated-desc",
			"https://github.com/search?q=is%3Apr+is%3Aopen+repo%3Ao%2Fr+-author%3A%40me+sort%3Aupdated-desc&type=pullrequests"},
		{"merged:>=2026-10-26T12:30:00+01:00", "https://github.com/search?q=merged%3A%3E%3D2026-10-26T12%3A30%3A00%2B01%3A00&type=pullrequests"},
	}
	for _, tt := range tests {
		if got := (ProjectList{Query: tt.query}).SearchURL(); got != tt.want {
			t.Errorf("SearchURL(%q) = %s, want %s", tt.query, got, tt.want)
		}
	}
}

func TestDecodeProjects(t *testing.T) {
	plan := pollPlan{projects: true, sections: projectSections("@me", []string{"o/r"}, time.Now())}
	data := `{"viewer":{"id":"V","login":"octocat"},
	  "s_project_open":{"issueCount":64,"nodes":[
	    {"__typename":"PullRequest","id":"PR_x","number":7,"updatedAt":"2026-11-01T10:00:00Z","state":"OPEN","headRefOid":"abc",
	     "author":{"login":"someone"},"repository":{"nameWithOwner":"O/R"},
	     "statusCheckRollup":{"state":"SUCCESS","contexts":{"checkRunCount":2,"checkRunCountsByState":[{"state":"SUCCESS","count":2}],"statusContextCount":0,"statusContextCountsByState":[]}}},
	    {"__typename":"Issue"}]},
	  "s_project_merged":null}`
	res, err := decodePoll(&plan, []byte(data), &PartialError{Errors: []graphQLError{{Type: "SERVICE_UNAVAILABLE", Message: "busy", Path: []any{"s_project_merged"}}}})
	if err != nil {
		t.Fatal(err)
	}
	open := res.Sections[sectionProjectOpen]
	if open.Err != nil || open.Total != 64 || len(open.PRs) != 1 {
		t.Fatalf("open = %+v", open)
	}
	if f := open.PRs[0]; f.Repo != "o/r" || f.Author != "someone" || !f.HasChecks || f.Checks.Passed != 2 {
		t.Errorf("open fingerprint = %+v", f)
	}
	if m := res.Sections[sectionProjectMerged]; m.Err == nil || !strings.Contains(m.Err.Error(), "busy") {
		t.Errorf("merged = %+v, want the part's error", m)
	}
}

// projectsWorld is changeDrivenWorld plus the project-wide lists: someone's open pull
// request in o/r and one in o/s, and a merged one by someone else.
func projectsWorld() (*fakeGitHub, time.Time) {
	g, t0 := changeDrivenWorld()
	g.setRepo("o/s", &fakeRepo{branch: "main", sha: "s1"})
	x := fakePR("PR_x", "o/r", 7, t0.Add(-3*time.Hour))
	x.Author, x.Additions, x.Deletions, x.Comments, x.Reviews = "someone", 412, 58, 4, 2
	x.ReviewRequests = []string{"teammate"}
	g.addPR(x, sectionProjectOpen)
	y := fakePR("PR_y", "o/s", 3, t0.Add(-4*time.Hour))
	y.Author, y.Draft, y.Checks = "other", true, CheckRollup{State: RollupPending, Total: 1, Pending: 1}
	g.addPR(y, sectionProjectOpen)
	m := fakePR("PR_m", "o/s", 2, t0.Add(-5*time.Hour))
	m.Author, m.State, m.MergedAt, m.Additions, m.Deletions = "other", PullRequestMerged, t0.Add(-5*time.Hour), 30, 4
	m.ReviewDecision, m.Mergeable, m.MergeStateStatus = "", "", ""
	g.addPR(m, sectionProjectMerged)
	// The viewer's merged PR_c is in both merged lists.
	g.mu.Lock()
	g.sections[sectionProjectMerged] = append(g.sections[sectionProjectMerged], "PR_c")
	g.mu.Unlock()
	return g, t0
}

func TestPollProjects(t *testing.T) {
	b := bus.New()
	dash := bus.Subscribe[DashboardUpdated](b, 64)
	polled := bus.Subscribe[Polled](b, 64)
	changed := bus.Subscribe[PullRequestChanged](b, 64)
	g, _ := projectsWorld()
	g.setTotal(sectionProjectMerged, 64)
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(openTestDB(t), f, b))
	for _, slug := range []string{"o/s", "o/r"} {
		if err := s.Track(slug); err != nil {
			t.Fatal(err)
		}
	}
	pollOnce(t, s, f)
	pollOnce(t, s, f) // a baseline for PullRequestChanged

	// One PollProjects per cycle, over every tracked repository, after the poll.
	calls, _ := f.snapshot()
	var last fakeCall
	for i, c := range calls {
		if c.op == "PollProjects" {
			if i == 0 || calls[i-1].op == "PollProjects" {
				t.Errorf("PollProjects did not follow a poll (call %d)", i)
			}
			last = c
		}
	}
	if q, _ := last.vars["q_project_open"].(string); !strings.Contains(q, "repo:o/r repo:o/s -author:@me") {
		t.Errorf("q_project_open = %q", q)
	}

	p := s.Snapshot().Projects
	if got := prNumbers(p.Open.PullRequests); got != "[o/r#7 o/s#3]" || p.Open.Total != 2 {
		t.Errorf("open = %s (total %d)", got, p.Open.Total)
	}
	if got := prNumbers(p.Merged.PullRequests); got != "[o/s#2 o/r#3]" || p.Merged.Total != 64 {
		t.Errorf("merged = %s (total %d), want capped at 2 of 64", got, p.Merged.Total)
	}
	x := p.Open.PullRequests[0]
	if x.Partial || x.Title != "PR 7" || x.Additions != 412 || x.Deletions != 58 || x.Comments != 4 || x.Reviews != 2 ||
		x.ReviewDecision != ReviewRequired || fmt.Sprint(x.ReviewRequests) != "[teammate]" || x.Checks.Passed != 3 || x.MergeStateStatus != "BLOCKED" {
		t.Errorf("open detail = %+v", x)
	}
	if y := p.Open.PullRequests[1]; !y.Draft || y.Checks.State != RollupPending {
		t.Errorf("draft = %+v", y)
	}
	if m := p.Merged.PullRequests[0]; m.Partial || m.Additions != 30 || m.Deletions != 4 || m.MergedAt.IsZero() {
		t.Errorf("merged detail = %+v", m)
	}
	if p.FetchedAt.IsZero() || p.LastError != "" || p.Open.SearchURL() == "" || !strings.Contains(p.Merged.Query, "is:merged merged:>=") {
		t.Errorf("projects = fetched %v error %q open url %q merged query %q", p.FetchedAt, p.LastError, p.Open.SearchURL(), p.Merged.Query)
	}
	// Every dashboard table carries the diff size too, merged ones included.
	d := s.Snapshot().Dashboard
	for _, l := range [][]PullRequest{d.Authored, d.ReviewRequested, d.RecentlyMerged} {
		if l[0].Additions != 10 || l[0].Deletions != 2 {
			t.Errorf("dashboard %s additions/deletions = %d/%d", prNumbers(l), l[0].Additions, l[0].Deletions)
		}
	}
	var ev Polled
	for drained := false; !drained; {
		select {
		case ev = <-polled.C():
		default:
			drained = true
		}
	}
	if !ev.ProjectsFetchedAt.Equal(p.FetchedAt) || ev.ProjectsLastError != "" {
		t.Errorf("Polled = %+v, want the projects' fetch time %v", ev, p.FetchedAt)
	}

	// Isolation: nothing else sees the project lists.
	drain(dash)
	drain(changed)
	g.edit("PR_x", func(p *PullRequest) {
		p.UpdatedAt = p.UpdatedAt.Add(time.Minute)
		p.Comments = 9
		p.ReviewDecision = ReviewApproved
	})
	pollOnce(t, s, f)
	if got := s.Snapshot().Projects.Open.PullRequests[0]; got.Comments != 9 || got.ReviewDecision != ReviewApproved {
		t.Errorf("open after edit = %+v", got)
	}
	if n := drain(changed); n != 0 {
		t.Errorf("PullRequestChanged = %d for a project-only pull request, want none", n)
	}
	if n := drain(dash); n != 1 {
		t.Errorf("DashboardUpdated = %d, want 1 (the project list changed)", n)
	}
	d = s.Snapshot().Dashboard
	for _, l := range [][]PullRequest{d.Authored, d.ReviewRequested, d.Reviewed, d.RecentlyMerged} {
		for _, pr := range l {
			if pr.ID == "PR_x" || pr.ID == "PR_y" || pr.ID == "PR_m" {
				t.Errorf("dashboard holds project pull request %s", pr.ID)
			}
		}
	}
	for _, pr := range s.CachedPullRequests() { // the linked PRs branch source
		if pr.ID == "PR_x" || pr.ID == "PR_y" || pr.ID == "PR_m" {
			t.Errorf("CachedPullRequests holds project pull request %s", pr.ID)
		}
	}

	// Nothing moved: no event, no detail request.
	drain(dash)
	from := f.ncalls()
	pollOnce(t, s, f)
	if n := drain(dash); n != 0 {
		t.Errorf("unchanged projects published %d DashboardUpdated", n)
	}
	if n := f.countSince(from, "PullRequestDetails"); n != 0 {
		t.Errorf("unchanged projects fetched details %d times", n)
	}

	// A failed fetch keeps the lists, records the error, and says so in Polled; the
	// dashboard poll is unaffected.
	fetched := s.Snapshot().Projects.FetchedAt
	g.failNext("PollProjects", fmt.Errorf("boom: %w", ErrNotFound))
	drain(polled)
	pollOnce(t, s, f)
	p = s.Snapshot().Projects
	if len(p.Open.PullRequests) != 2 || !p.FetchedAt.Equal(fetched) || !strings.Contains(p.LastError, "boom") {
		t.Errorf("after failure = %d open, fetched %v (was %v), error %q", len(p.Open.PullRequests), p.FetchedAt, fetched, p.LastError)
	}
	if e := s.Snapshot().Poll.LastError; e != "" {
		t.Errorf("poll error = %q, want the dashboard poll unaffected", e)
	}
	if n := drain(dash); n != 1 {
		t.Errorf("DashboardUpdated on error = %d, want 1", n)
	}
	ev = <-polled.C()
	if !strings.Contains(ev.ProjectsLastError, "boom") || !ev.ProjectsFetchedAt.Equal(fetched) {
		t.Errorf("Polled = %+v", ev)
	}
	pollOnce(t, s, f)
	if p := s.Snapshot().Projects; p.LastError != "" || !p.FetchedAt.After(fetched) {
		t.Errorf("after recovery = %+v", p)
	}

	// A 502/504 halves the project searches for the next cycles.
	g.failNext("PollProjects", fmt.Errorf("x: %w", ErrServerTimeout))
	pollOnce(t, s, f)
	from = f.ncalls()
	pollOnce(t, s, f)
	if doc := f.docSince(from, "PollProjects"); !strings.Contains(doc, "s_project_open: search(query: $q_project_open, type: ISSUE, first: 25)") {
		t.Errorf("after a timeout the projects document is:\n%s", doc)
	}

	// Untracking everything empties the lists without a request.
	for _, slug := range []string{"o/r", "o/s"} {
		if err := s.Untrack(slug); err != nil {
			t.Fatal(err)
		}
	}
	from = f.ncalls()
	pollOnce(t, s, f)
	if n := f.countSince(from, "PollProjects"); n != 0 {
		t.Errorf("PollProjects with nothing tracked = %d", n)
	}
	if p := s.Snapshot().Projects; len(p.Open.PullRequests)+len(p.Merged.PullRequests) != 0 || p.Open.Query != "" || !p.FetchedAt.IsZero() {
		t.Errorf("projects with nothing tracked = %+v", p)
	}
}

// The lists come back from the cache after a restart.
func TestPollProjectsCache(t *testing.T) {
	db := openTestDB(t)
	g, _ := projectsWorld()
	f := (&fakeRunner{}).serve(g)
	s := startStore(t, testOptions(db, f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	pollOnce(t, s, f)
	want := s.Snapshot().Projects

	s2, err := New(context.Background(), testOptions(db, f, nil))
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Snapshot().Projects
	if prNumbers(got.Open.PullRequests) != prNumbers(want.Open.PullRequests) || got.Merged.Total != want.Merged.Total ||
		got.Open.Query != want.Open.Query || !got.FetchedAt.Equal(want.FetchedAt) || got.Open.PullRequests[0].Additions != 412 {
		t.Errorf("cached projects = %+v, want %+v", got, want)
	}
}

// countSince counts the calls of op since call index from.
func (f *fakeRunner) countSince(from int, op string) int {
	calls, _ := f.snapshot()
	n := 0
	for _, c := range calls[min(from, len(calls)):] {
		if c.op == op {
			n++
		}
	}
	return n
}

// docSince is the document of the first call of op since call index from.
func (f *fakeRunner) docSince(from int, op string) string {
	calls, _ := f.snapshot()
	for _, c := range calls[min(from, len(calls)):] {
		if c.op == op {
			return c.doc
		}
	}
	return ""
}

func prNumbers(prs []PullRequest) string {
	out := make([]string, 0, len(prs))
	for _, p := range prs {
		out = append(out, fmt.Sprintf("%s#%d", p.Repo, p.Number))
	}
	return "[" + strings.Join(out, " ") + "]"
}
