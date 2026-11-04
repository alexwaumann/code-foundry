package gh

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync/atomic"
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
		// github.com's syntax (SearchURL): an OR group, since its search ANDs repo:s.
		wantWebOpen, wantWebMerged string
	}{
		{name: "nothing tracked", login: "@me"},
		{
			name: "one repository", login: "@me", slugs: []string{"o/r"},
			wantOpen:      "is:pr is:open archived:false updated:>=2026-10-03T12:30:00+00:00 repo:o/r -author:@me -reviewed-by:@me -review-requested:@me sort:updated-desc",
			wantMerged:    "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 repo:o/r sort:updated-desc",
			wantWebOpen:   "is:pr is:open archived:false updated:>=2026-10-03T12:30:00+00:00 repo:o/r -author:@me -reviewed-by:@me -review-requested:@me sort:updated-desc",
			wantWebMerged: "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 repo:o/r sort:updated-desc",
		},
		{
			name: "several repositories, search as a login", login: "mitchellh", slugs: []string{"a/one", "a/two", "b/three"},
			wantOpen:      "is:pr is:open archived:false updated:>=2026-10-03T12:30:00+00:00 repo:a/one repo:a/two repo:b/three -author:mitchellh -reviewed-by:mitchellh -review-requested:mitchellh sort:updated-desc",
			wantMerged:    "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 repo:a/one repo:a/two repo:b/three sort:updated-desc",
			wantWebOpen:   "is:pr is:open archived:false updated:>=2026-10-03T12:30:00+00:00 (repo:a/one OR repo:a/two OR repo:b/three) -author:mitchellh -reviewed-by:mitchellh -review-requested:mitchellh sort:updated-desc",
			wantWebMerged: "is:pr is:merged merged:>=2026-10-26T12:30:00+00:00 (repo:a/one OR repo:a/two OR repo:b/three) sort:updated-desc",
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
			if open.webQuery != tt.wantWebOpen || merged.webQuery != tt.wantWebMerged {
				t.Errorf("web queries = %q, %q\nwant %q, %q", open.webQuery, merged.webQuery, tt.wantWebOpen, tt.wantWebMerged)
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
		{"is:pr is:open (repo:o/r OR repo:o/s) -author:@me sort:updated-desc",
			"https://github.com/search?q=is%3Apr+is%3Aopen+%28repo%3Ao%2Fr+OR+repo%3Ao%2Fs%29+-author%3A%40me+sort%3Aupdated-desc&type=pullrequests"},
		{"merged:>=2026-10-26T12:30:00+01:00", "https://github.com/search?q=merged%3A%3E%3D2026-10-26T12%3A30%3A00%2B01%3A00&type=pullrequests"},
	}
	for _, tt := range tests {
		// The URL is built from WebQuery, never from the API's Query.
		if got := (ProjectList{Query: "is:pr", WebQuery: tt.query}).SearchURL(); got != tt.want {
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

// A poll that spends the budget ends there: its project lists wait out the pause like
// the next poll, even for a repository tracked while the poll was in flight.
func TestPollProjectsWaitsOutThePause(t *testing.T) {
	reset := time.Now().Add(time.Hour).UTC().Truncate(time.Second)
	f := &fakeRunner{}
	var s *Store
	ready := make(chan struct{})
	f.set(func(string, map[string]any) (json.RawMessage, error) {
		<-ready
		if err := s.Track("a/b"); err != nil {
			t.Error(err)
		}
		return json.RawMessage(fmt.Sprintf(`{"rateLimit":{"limit":5000,"cost":1,"remaining":10,"resetAt":%q},
			"viewer":{"id":"V","login":"octocat"}}`, reset.Format(time.RFC3339))), nil
	})
	s = startStore(t, testOptions(openTestDB(t), f, nil))
	close(ready)
	waitFor(t, "the poll's end", func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return !s.lastPoll.IsZero()
	})
	if n := f.countSince(0, "PollProjects"); n != 0 {
		t.Errorf("PollProjects during the pause = %d, want none", n)
	}
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

// The lists come back from the cache after a restart, with the last cycle's fetch time
// and updated and merged windows even when that cycle changed nothing (the full row is
// written only on a change).
func TestPollProjectsCache(t *testing.T) {
	db := openTestDB(t)
	g, _ := projectsWorld()
	f := (&fakeRunner{}).serve(g)
	// A clock the test moves, so the later cycle's windows differ from the first's.
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	opts := testOptions(db, f, nil)
	opts.Now = func() time.Time { return time.Unix(0, clock.Load()) }
	s, err := New(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = s.Run(ctx) }()
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "projects", func() bool { return !s.Snapshot().Projects.FetchedAt.IsZero() })
	first := s.Snapshot().Projects
	clock.Add(int64(time.Minute))
	waitFor(t, "a later cycle", func() bool {
		pollOnce(t, s, f)
		return s.Snapshot().Projects.FetchedAt.After(first.FetchedAt)
	})
	cancel()
	<-done
	want := s.Snapshot().Projects
	if want.Open.Query == first.Open.Query || want.Merged.Query == first.Merged.Query {
		t.Fatalf("the later cycle's queries did not move: open %q, merged %q", want.Open.Query, want.Merged.Query)
	}
	full, _, err := loadActivityRow[ProjectPullRequests](context.Background(), s.cache, activityProjects)
	if err != nil || !full.FetchedAt.Before(want.FetchedAt) {
		t.Fatalf("full row fetched %v (err %v), want older than the last cycle's %v", full.FetchedAt, err, want.FetchedAt)
	}

	s2, err := New(context.Background(), testOptions(db, f, nil))
	if err != nil {
		t.Fatal(err)
	}
	got := s2.Snapshot().Projects
	if prNumbers(got.Open.PullRequests) != prNumbers(want.Open.PullRequests) || got.Merged.Total != want.Merged.Total ||
		got.Open.Query != want.Open.Query || got.Open.WebQuery != want.Open.WebQuery || got.Merged.Query != want.Merged.Query || got.Merged.WebQuery != want.Merged.WebQuery ||
		!got.FetchedAt.Equal(want.FetchedAt) || got.Open.PullRequests[0].Additions != 412 {
		t.Errorf("cached projects = %+v\nwant %+v", got, want)
	}
}

// The dashboard poll owns the mergeability recheck of a pull request it holds: when
// GitHub settles between its detail fetch and the projects', the projects request must
// not consume the recheck, or the dashboard's copy stays UNKNOWN (and the projects' copy,
// resolved from it, with it).
func TestPollProjectsLeaveDashboardRechecks(t *testing.T) {
	g := newFakeGitHub()
	t0 := time.Date(2026, 10, 8, 12, 0, 0, 0, time.UTC)
	g.setRepo("o/r", &fakeRepo{branch: "main", sha: "m1"})
	p := fakePR("PR_z", "o/r", 9, t0)
	p.Author, p.ReviewRequests = "someone", []string{"octocat"}
	p.Mergeable, p.MergeStateStatus = MergeableUnknown, "UNKNOWN"
	g.addPR(p, sectionReview, sectionProjectOpen) // index lag: in both
	f := &fakeRunner{}
	details := 0
	f.setDoc(func(op, doc string, vars map[string]any) (json.RawMessage, error) {
		data, err := g.respond(op, doc, vars)
		if op == "PullRequestDetails" {
			if details++; details == 1 {
				// Settled right after the dashboard's fetch saw UNKNOWN.
				g.edit("PR_z", func(p *PullRequest) { p.Mergeable, p.MergeStateStatus = MergeableMergeable, "CLEAN" })
			}
		}
		return data, err
	})
	s := startStore(t, testOptions(openTestDB(t), f, nil))
	if err := s.Track("o/r"); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "projects", func() bool { return len(s.Snapshot().Projects.Open.PullRequests) == 1 })
	for range 3 {
		pollOnce(t, s, f)
	}
	if d := s.Snapshot().Dashboard.ReviewRequested; len(d) != 1 || d[0].MergeStateStatus != "CLEAN" {
		t.Errorf("dashboard copy = %+v, want CLEAN", d)
	}
	if o := s.Snapshot().Projects.Open.PullRequests; len(o) != 1 || o[0].MergeStateStatus != "CLEAN" || o[0].Mergeable != MergeableMergeable {
		t.Errorf("projects copy = %+v, want CLEAN", o)
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
