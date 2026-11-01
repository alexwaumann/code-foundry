package daemon

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/gh/ghtest"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

var branchT0 = time.Date(2026, 10, 20, 9, 0, 0, 0, time.UTC)

// branchPR is pull request n of repo with head branch head, created n minutes after
// branchT0 (zero n: no creation time known, as a placeholder or an old cache).
func branchPR(repo string, n int, head string) gh.PullRequest {
	p := gh.PullRequest{Number: n, Repo: repo, HeadRef: head, URL: fmt.Sprintf("https://github.com/%s/pull/%d", repo, n),
		State: gh.PullRequestOpen}
	p.CreatedAt = branchT0.Add(time.Duration(n) * time.Minute)
	return p
}

// branchProjects: p-api (o/api, default branch trunk, worktrees main, cf/x, a detached
// one), p-web (O/Web: mixed case, default branch trunk, worktrees main and cf/x),
// p-local (no GitHub slug, cf/x). The default branch is not main so that main's pull
// requests still link; TestBranchLinksFor's default-branch cases use p-def.
func branchProjects() *project.Snapshot {
	return &project.Snapshot{Projects: []project.Project{
		{ID: "p-api", GitHubSlug: "o/api", DefaultBranch: "trunk", Path: "/api", Git: true, Worktrees: []project.Worktree{
			{ProjectID: "p-api", Path: "/api", Branch: "main", IsMain: true},
			{ProjectID: "p-api", Path: "/wt/api-x", Branch: "cf/x"},
			{ProjectID: "p-api", Path: "/wt/api-det", Detached: true},
		}},
		{ID: "p-web", GitHubSlug: "O/Web", DefaultBranch: "trunk", Path: "/web", Git: true, Worktrees: []project.Worktree{
			{ProjectID: "p-web", Path: "/web", Branch: "main", IsMain: true},
			{ProjectID: "p-web", Path: "/wt/web-x", Branch: "cf/x"},
		}},
		{ID: "p-def", GitHubSlug: "o/def", DefaultBranch: "main", Path: "/def", Git: true, Worktrees: []project.Worktree{
			{ProjectID: "p-def", Path: "/def", Branch: "main", IsMain: true},
			{ProjectID: "p-def", Path: "/wt/def-x", Branch: "cf/x"},
		}},
		{ID: "p-local", Path: "/local", Git: true, Worktrees: []project.Worktree{
			{ProjectID: "p-local", Path: "/local", Branch: "cf/x", IsMain: true},
		}},
	}}
}

// branchFacts renders found links as "id: repo#n@minutes" ("now" for a link without a
// creation time), in the order found.
func branchFacts(t *testing.T, found []threadLinks, now time.Time) []string {
	t.Helper()
	var out []string
	for _, f := range found {
		var parts []string
		for _, l := range f.links {
			if l.Source != thread.LinkBranch || l.ViaThreadID != "" || !strings.EqualFold(l.URL, fmt.Sprintf("https://github.com/%s/pull/%d", l.Slug, l.Number)) {
				t.Errorf("%s: link %+v", f.id, l)
			}
			at := "now"
			if !l.LinkedAt.Equal(now) {
				at = fmt.Sprint(int(l.LinkedAt.Sub(branchT0) / time.Minute))
			}
			parts = append(parts, fmt.Sprintf("%s#%d@%s", l.Slug, l.Number, at))
		}
		out = append(out, f.id+": "+strings.Join(parts, " "))
	}
	return out
}

func TestBranchLinksFor(t *testing.T) {
	now := branchT0.Add(time.Hour)
	link := func(repo string, n int) thread.LinkedPullRequest {
		p := branchPR(repo, n, "")
		return thread.LinkedPullRequest{Slug: repo, Number: n, URL: p.URL, Source: thread.LinkClaude}
	}
	tests := []struct {
		name     string
		threads  []thread.Thread
		prs      []gh.PullRequest
		projects func(*project.Snapshot)
		want     []string
	}{
		{name: "project thread: the worktree's current branch, not the one it was made for",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/api-x", Branch: "cf/old"}},
			prs:     []gh.PullRequest{branchPR("o/api", 2, "cf/x"), branchPR("o/api", 1, "cf/old"), branchPR("o/api", 3, "main")},
			want:    []string{"t: o/api#2@2"}},
		{name: "main checkout: its branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/api"}},
			prs:     []gh.PullRequest{branchPR("o/api", 2, "cf/x"), branchPR("o/api", 3, "main")},
			want:    []string{"t: o/api#3@3"}},
		{name: "worktree gone: the thread's branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/removed", Branch: "cf/old"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/old"), branchPR("o/api", 2, "cf/x")},
			want:    []string{"t: o/api#1@1"}},
		{name: "worktree gone and no branch recorded: nothing",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/removed"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/old")}},
		{name: "detached worktree: nothing, not the thread's branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/api-det", Branch: "cf/old"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/old")}},
		{name: "every pull request of the branch, oldest first, any state",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/api-x"}},
			prs: func() []gh.PullRequest {
				merged, closed := branchPR("o/api", 4, "cf/x"), branchPR("o/api", 1, "cf/x")
				merged.State, closed.State = gh.PullRequestMerged, gh.PullRequestClosed
				return []gh.PullRequest{merged, branchPR("o/api", 2, "cf/x"), closed}
			}(),
			want: []string{"t: o/api#1@1 o/api#2@2 o/api#4@4"}},
		{name: "worktree-mode thread with two projects: every member's branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", ProjectIDs: []string{"p-api", "p-web"}, WorktreePath: "/wt/api-x", CreatedWorktree: true, Branch: "cf/x"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/web", 2, "cf/x"), branchPR("o/web", 3, "cf/y")},
			want:    []string{"t: o/api#1@1 o/web#2@2"}},
		{name: "worktree-mode thread: a member whose worktree is gone has the thread's branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", ProjectIDs: []string{"p-api", "p-web"}, WorktreePath: "/wt/api-x", CreatedWorktree: true, Branch: "cf/ws"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/web", 2, "cf/ws")},
			want:    []string{"t: o/api#1@1 o/web#2@2"}},
		{name: "worktree-mode thread: a moved checkout has its HEAD's branch, not the one it was made for",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", ProjectIDs: []string{"p-api", "p-web"}, WorktreePath: "/wt/api-x", CreatedWorktree: true, Branch: "cf/old",
				CheckoutPaths: map[string]string{"p-api": "/wt/api-x", "p-web": "/wt/web-x"}}},
			prs:  []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/web", 2, "cf/x"), branchPR("o/web", 3, "cf/old")},
			want: []string{"t: o/api#1@1 o/web#2@2"}},
		{name: "checkout mode: a recorded worktree, not the main checkout",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", ProjectIDs: []string{"p-api", "p-web"}, WorktreePath: "/api",
				CheckoutPaths: map[string]string{"p-api": "/api", "p-web": "/wt/web-x"}}},
			prs:  []gh.PullRequest{branchPR("o/api", 1, "main"), branchPR("o/web", 2, "cf/x"), branchPR("o/web", 3, "main")},
			want: []string{"t: o/api#1@1 o/web#2@2"}},
		{name: "checkout mode: each member's own checkout",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", ProjectIDs: []string{"p-api", "p-web"}, WorktreePath: "/wt/api-x"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/web", 2, "cf/x"), branchPR("o/web", 3, "main")},
			want:    []string{"t: o/api#1@1 o/web#3@3"}},
		{name: "slug case: the project's O/Web matches the cache's o/web",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-web", WorktreePath: "/wt/web-x"}},
			prs:     []gh.PullRequest{branchPR("O/WEB", 2, "cf/x")},
			want:    []string{"t: o/web#2@2"}},
		{name: "same branch in another repository: not matched",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/wt/api-x"}},
			prs:     []gh.PullRequest{branchPR("o/web", 2, "cf/x"), branchPR("o/other", 3, "cf/x")}},
		{name: "no GitHub slug: nothing",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-local", WorktreePath: "/local"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("", 2, "cf/x")}},
		{name: "no project: nothing",
			threads: []thread.Thread{{ID: "t", WorktreePath: "/Users/me", Branch: "cf/x"}},
			prs:     []gh.PullRequest{branchPR("o/api", 1, "cf/x")}},
		{name: "oldest thread first, whatever its id",
			threads: []thread.Thread{
				{ID: "a-new", ProjectID: "p-api", WorktreePath: "/wt/api-x", CreatedAt: branchT0.Add(time.Minute)},
				{ID: "b-old", ProjectID: "p-api", WorktreePath: "/wt/api-x", CreatedAt: branchT0},
				{ID: "a-old", ProjectID: "p-api", WorktreePath: "/wt/api-x", CreatedAt: branchT0}},
			prs:  []gh.PullRequest{branchPR("o/api", 1, "cf/x")},
			want: []string{"a-old: o/api#1@1", "b-old: o/api#1@1", "a-new: o/api#1@1"}},
		{name: "archived thread skipped",
			threads: []thread.Thread{
				{ID: "t1", ProjectID: "p-api", WorktreePath: "/wt/api-x", ArchivedAt: branchT0},
				{ID: "t2", ProjectID: "p-api", WorktreePath: "/wt/api-x"}},
			prs:  []gh.PullRequest{branchPR("o/api", 1, "cf/x")},
			want: []string{"t2: o/api#1@1"}},
		{name: "already linked urls are not offered again; a thread with nothing new is left out",
			threads: []thread.Thread{
				{ID: "t1", ProjectID: "p-api", WorktreePath: "/wt/api-x", LinkedPullRequests: []thread.LinkedPullRequest{link("o/api", 1)}},
				{ID: "t2", ProjectID: "p-api", WorktreePath: "/wt/api-x", LinkedPullRequests: []thread.LinkedPullRequest{link("o/api", 1), link("o/api", 2)}}},
			prs:  []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/api", 2, "cf/x")},
			want: []string{"t1: o/api#2@2"}},
		{name: "the default branch's pull requests are not linked",
			threads: []thread.Thread{
				{ID: "t1", ProjectID: "p-def", WorktreePath: "/def", CreatedAt: branchT0},
				{ID: "t2", ProjectID: "p-def", WorktreePath: "/wt/def-x", CreatedAt: branchT0.Add(time.Minute)}},
			prs:  []gh.PullRequest{branchPR("o/def", 1, "main"), branchPR("o/def", 2, "cf/x")},
			want: []string{"t2: o/def#2@2"}},
		{name: "the default branch: also not as a gone worktree's recorded branch",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-def", WorktreePath: "/wt/removed", Branch: "main"}},
			prs:     []gh.PullRequest{branchPR("o/def", 1, "main")}},
		{name: "default branch not known yet (not reconciled): nothing for the project",
			threads:  []thread.Thread{{ID: "t", ProjectID: "p-def", WorktreePath: "/wt/def-x"}},
			prs:      []gh.PullRequest{branchPR("o/def", 2, "cf/x")},
			projects: func(s *project.Snapshot) { s.Projects[2].DefaultBranch = "" }},
		{name: "fork pull requests, placeholders and links without a url are left out; no creation time: now",
			threads: []thread.Thread{{ID: "t", ProjectID: "p-api", WorktreePath: "/api"}},
			prs: func() []gh.PullRequest {
				fork, partial, nourl, old := branchPR("o/api", 1, "main"), branchPR("o/api", 2, ""), branchPR("o/api", 3, "main"), branchPR("o/api", 4, "main")
				fork.IsCrossRepository, partial.Partial, nourl.URL, old.CreatedAt = true, true, "", time.Time{}
				return []gh.PullRequest{fork, partial, nourl, old}
			}(),
			want: []string{"t: o/api#4@now"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			projects := branchProjects()
			if tt.projects != nil {
				tt.projects(projects)
			}
			found := branchLinksFor(&thread.Snapshot{Threads: tt.threads}, projects, prsByHead(tt.prs), now)
			if got := branchFacts(t, found, now); !slices.Equal(got, tt.want) {
				t.Errorf("found = %q; want %q", got, tt.want)
			}
		})
	}
}

// fakeBranchLinker is a thread store holding threads whose links
// LinkBranchPullRequests merges (deduplicated by URL) and records, publishing
// thread.Updated for a thread that changed like the real one.
type fakeBranchLinker struct {
	mu      sync.Mutex
	bus     *bus.Bus
	threads []thread.Thread
	calls   []string // "id #n #m"
}

func (f *fakeBranchLinker) Snapshot() *thread.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &thread.Snapshot{Threads: slices.Clone(f.threads)}
}

func (f *fakeBranchLinker) LinkBranchPullRequests(id string, links []thread.LinkedPullRequest) int {
	f.mu.Lock()
	call := id
	added := 0
	var updated thread.Thread
	for i := range f.threads {
		if f.threads[i].ID != id {
			continue
		}
		cur := slices.Clip(f.threads[i].LinkedPullRequests)
		for _, l := range links {
			call += fmt.Sprintf(" #%d", l.Number)
			if !slices.ContainsFunc(cur, func(x thread.LinkedPullRequest) bool { return x.URL == l.URL }) {
				cur = append(cur, l)
				added++
			}
		}
		f.threads[i].LinkedPullRequests = cur
		updated = f.threads[i]
	}
	f.calls = append(f.calls, call)
	f.mu.Unlock()
	if added > 0 {
		bus.Publish[thread.Event](f.bus, thread.Updated{Thread: updated})
	}
	return added
}

// SettleBranchLinks records "settle id -#n +#m@head" and applies it to the thread only
// (no copies up the chain in the fake).
func (f *fakeBranchLinker) SettleBranchLinks(id string, heads map[string]string, drop []string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	call := "settle " + id
	removed := 0
	for i := range f.threads {
		if f.threads[i].ID != id {
			continue
		}
		var kept []thread.LinkedPullRequest
		for _, l := range f.threads[i].LinkedPullRequests {
			switch {
			case slices.Contains(drop, l.URL):
				call += fmt.Sprintf(" -#%d", l.Number)
				removed++
				continue
			case heads[l.URL] != "":
				l.Head = heads[l.URL]
				call += fmt.Sprintf(" +#%d@%s", l.Number, l.Head)
			}
			kept = append(kept, l)
		}
		f.threads[i].LinkedPullRequests = kept
	}
	f.calls = append(f.calls, call)
	return removed
}

func (f *fakeBranchLinker) add(th thread.Thread) {
	f.mu.Lock()
	f.threads = append(f.threads, th)
	f.mu.Unlock()
	bus.Publish[thread.Event](f.bus, thread.Updated{Thread: th})
}

func (f *fakeBranchLinker) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.calls)
}

func TestStartBranchLinks(t *testing.T) {
	b := bus.New()
	g := ghtest.New(b)
	g.SetDashboard(gh.Dashboard{Authored: []gh.PullRequest{branchPR("o/api", 1, "cf/x")}})
	threads := &fakeBranchLinker{bus: b, threads: []thread.Thread{{ID: "t1", ProjectID: "p-api", WorktreePath: "/wt/api-x"}}}
	var mu sync.Mutex
	projects := branchProjects()
	projectsNow := func() *project.Snapshot { mu.Lock(); defer mu.Unlock(); return projects }
	stop := startBranchLinks(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil)), threads,
		projectsNow, g, b)
	defer stop()

	waitCalls := func(want ...string) {
		t.Helper()
		deadline := time.Now().Add(3 * time.Second)
		for !slices.Equal(threads.got(), want) {
			if time.Now().After(deadline) {
				t.Fatalf("calls = %q; want %q", threads.got(), want)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	// At start: the cached dashboard.
	waitCalls("t1 #1")

	// A branch list in the cache (the Pull request surface asked for it).
	g.SetBranchPullRequests(gh.BranchPullRequests{Slug: "o/api", HeadRef: "cf/x", PullRequests: []gh.PullRequest{branchPR("o/api", 5, "cf/x")}})
	waitCalls("t1 #1", "t1 #5")

	// A repeat of the same lists calls nothing (and so publishes nothing).
	g.SetBranchPullRequests(gh.BranchPullRequests{Slug: "o/api", HeadRef: "cf/x", PullRequests: []gh.PullRequest{branchPR("o/api", 5, "cf/x")}})
	g.SetDashboard(gh.Dashboard{Authored: []gh.PullRequest{branchPR("o/api", 1, "cf/x")}})
	time.Sleep(3 * branchLinkDelay)
	waitCalls("t1 #1", "t1 #5")

	// A new thread on the main checkout gets main's pull request without a gh event.
	g.SetDashboard(gh.Dashboard{Authored: []gh.PullRequest{branchPR("o/api", 1, "cf/x"), branchPR("o/api", 7, "main")}})
	time.Sleep(3 * branchLinkDelay)
	waitCalls("t1 #1", "t1 #5")
	threads.add(thread.Thread{ID: "t2", ProjectID: "p-api", WorktreePath: "/api"})
	waitCalls("t1 #1", "t1 #5", "t2 #7")

	// The worktree switches to main: the project event brings main's pull request.
	mu.Lock()
	projects = branchProjects()
	projects.Projects[0].Worktrees[1].Branch = "main"
	mu.Unlock()
	bus.Publish[project.Event](b, project.WorktreeUpdated{})
	waitCalls("t1 #1", "t1 #5", "t2 #7", "t1 #7")
}

func TestWakesBranchLinks(t *testing.T) {
	tests := []struct {
		ev   any
		want bool
	}{
		{gh.DashboardUpdated{}, true},
		{gh.BranchPullRequestsUpdated{}, true},
		{gh.Polled{}, false},
		{thread.Updated{}, true},
		{thread.Removed{}, false},
		{project.WorktreeUpdated{}, true},
		{project.ProjectUpdated{}, true},
		{project.WorktreeFilesChanged{}, false},
	}
	for _, tt := range tests {
		if got := wakesBranchLinks(tt.ev); got != tt.want {
			t.Errorf("wakesBranchLinks(%T) = %v; want %v", tt.ev, got, tt.want)
		}
	}
}
