package daemon

import (
	"context"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// oldBranchLink is a branch link of repo#n made before heads were recorded.
func oldBranchLink(repo string, n int) thread.LinkedPullRequest {
	p := branchPR(repo, n, "")
	return thread.LinkedPullRequest{Slug: repo, Number: n, URL: p.URL, Source: thread.LinkBranch}
}

func TestDefaultBranchOf(t *testing.T) {
	def := project.Project{GitHubSlug: "o/def", DefaultBranch: "main", Git: true}
	other := project.Project{GitHubSlug: "o/other", DefaultBranch: "trunk", Git: true}
	with := func(p project.Project, edit func(*project.Project)) project.Project {
		edit(&p)
		return p
	}
	for _, tt := range []struct {
		name   string
		s      *project.Snapshot
		branch string
		known  bool
	}{
		{"no snapshot", nil, "", false},
		{"its project's, any case", &project.Snapshot{Projects: []project.Project{other, def}}, "main", true},
		{"no project with the slug: nothing to compare with", &project.Snapshot{Projects: []project.Project{other}}, "", true},
		{"its project not reconciled yet (registered this run)", &project.Snapshot{Projects: []project.Project{
			with(def, func(p *project.Project) { p.DefaultBranch = "" })}}, "", false},
		{"its project is the last run's: its default branch may have changed", &project.Snapshot{Projects: []project.Project{
			with(def, func(p *project.Project) { p.Cached = true })}}, "", false},
		{"another project is the last run's: its slug may now be this one", &project.Snapshot{Projects: []project.Project{
			def, with(other, func(p *project.Project) { p.Cached = true })}}, "", false},
		{"a cached project whose reconcile failed does not hold the others", &project.Snapshot{Projects: []project.Project{
			def, with(other, func(p *project.Project) { p.Cached, p.Error = true, "boom" })}}, "main", true},
		{"nor counts as the slug's project", &project.Snapshot{Projects: []project.Project{
			with(def, func(p *project.Project) { p.Cached, p.Error = true, "boom" })}}, "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			branch, known := defaultBranchOf(tt.s, "O/Def")
			if branch != tt.branch || known != tt.known {
				t.Errorf("defaultBranchOf = %q, %v; want %q, %v", branch, known, tt.branch, tt.known)
			}
		})
	}
}

func TestSettleBranchLinksDecisions(t *testing.T) {
	ref := func(repo string, n int) gh.PullRequestRef { return gh.PullRequestRef{Slug: repo, Number: n} }
	headed := oldBranchLink("o/def", 9)
	headed.Head = "cf/x"
	claude := oldBranchLink("o/def", 8)
	claude.Source = thread.LinkClaude
	threads := &thread.Snapshot{Threads: []thread.Thread{
		{ID: "t1", LinkedPullRequests: []thread.LinkedPullRequest{
			oldBranchLink("o/def", 1), oldBranchLink("O/Def", 2), oldBranchLink("o/def", 3), headed, claude}},
		{ID: "t2", LinkedPullRequests: []thread.LinkedPullRequest{
			oldBranchLink("o/def", 1), oldBranchLink("o/gone", 4), oldBranchLink("o/api", 5), oldBranchLink("o/def", 6)}},
	}}
	links := unsettledBranchLinks(threads)
	if len(links) != 7 {
		t.Fatalf("unsettled = %d; want 7 (headed and claude links left out)", len(links))
	}
	projects := branchProjects()
	projects.Projects[0].DefaultBranch = "" // o/api: not reconciled yet
	known := map[gh.PullRequestRef]prHead{
		ref("o/def", 1):  {head: "main"},
		ref("o/def", 2):  {head: "cf/x"},
		ref("o/gone", 4): {head: "main"},
		ref("o/api", 5):  {head: "main"},
		ref("o/def", 6):  {head: "main", cross: true},
	}
	ids, out, missing := settleBranchLinks(links, projects, known)
	if !slices.Equal(ids, []string{"t1", "t2"}) {
		t.Errorf("ids = %q", ids)
	}
	if !slices.Equal(missing, []gh.PullRequestRef{ref("o/def", 3)}) {
		t.Errorf("missing = %v", missing)
	}
	url := func(repo string, n int) string { return branchPR(repo, n, "").URL }
	if got := out["t1"]; !slices.Equal(got.drop, []string{url("o/def", 1)}) || len(got.heads) != 1 || got.heads[url("O/Def", 2)] != "cf/x" {
		t.Errorf("t1 = %+v", got)
	}
	// o/gone: no project, keeps its head; o/api: waits for its default branch; a fork's main is not ours.
	if got := out["t2"]; !slices.Equal(got.drop, []string{url("o/def", 1)}) || len(got.heads) != 2 ||
		got.heads[url("o/gone", 4)] != "main" || got.heads[url("o/def", 6)] != "main" {
		t.Errorf("t2 = %+v", got)
	}
}

func TestStartBranchLinksSettlesOldLinks(t *testing.T) {
	b := bus.New()
	g := ghtest.New(b)
	// #1 is on the dashboard (head main); #2 and #3 only in their details; #4 cannot be read.
	main1 := branchPR("o/def", 1, "main")
	main1.State = gh.PullRequestMerged
	g.SetDashboard(gh.Dashboard{RecentlyMerged: []gh.PullRequest{main1}})
	g.SetPullRequest("o/def", gh.PullRequestDetail{PullRequest: branchPR("o/def", 2, "main")})
	g.SetPullRequest("o/def", gh.PullRequestDetail{PullRequest: branchPR("o/def", 3, "cf/old")})
	threads := &fakeBranchLinker{bus: b, threads: []thread.Thread{{ID: "t1", ProjectID: "p-def", WorktreePath: "/def",
		LinkedPullRequests: []thread.LinkedPullRequest{oldBranchLink("o/def", 1), oldBranchLink("o/def", 2), oldBranchLink("o/def", 3), oldBranchLink("o/def", 4)}}}}
	var mu sync.Mutex
	projects := branchProjects()
	projects.Projects[2].DefaultBranch = "" // until the first reconcile
	projectsNow := func() *project.Snapshot { mu.Lock(); defer mu.Unlock(); return projects }
	stop := startBranchLinks(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), threads, projectsNow, g, b)
	defer stop()

	wait := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !slices.Equal(threads.got(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("calls = %q; want %q", threads.got(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	// No default branch yet: nothing is settled, and main's pull request is not linked either.
	time.Sleep(3 * branchLinkDelay)
	wait()

	mu.Lock()
	projects = branchProjects()
	mu.Unlock()
	bus.Publish[project.Event](b, project.ProjectUpdated{})
	// #2-#4 were read in the first pass; #1 (dashboard) and #2 (read) drop, #3 gets its head, #4 waits for a restart.
	wait("settle t1 -#1 -#2 +#3@cf/old")

	if h := threads.Snapshot().Threads[0].LinkedPullRequests; len(h) != 2 || h[0].Number != 3 || h[1].Number != 4 || h[1].Head != "" {
		t.Errorf("links = %+v", h)
	}
}
