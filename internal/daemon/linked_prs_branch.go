package daemon

import (
	"cmp"
	"context"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Branch links (docs/notes/linked-prs-branch.md): a thread's linked pull requests
// include every pull request whose head is a branch the thread works on, in its
// project's GitHub repository. The thread store knows none of the stores involved, so
// the daemon resolves each thread's branches (the project store), matches
// them against the GitHub store's cached lists (dashboards and branch lists; nothing is
// polled or watched for this) and pushes the matches (LinkBranchPullRequests).

// branchPRCache is the part of the GitHub store branch links read. *gh.Store
// implements it.
type branchPRCache interface {
	CachedPullRequests() []gh.PullRequest
}

var _ branchPRCache = (*gh.Store)(nil)

// branchLinker is the part of the thread store branch links go to. *thread.Manager
// implements it.
type branchLinker interface {
	Snapshot() *thread.Snapshot
	LinkBranchPullRequests(id string, links []thread.LinkedPullRequest) int
}

var _ branchLinker = (*thread.Manager)(nil)

// headKey is a branch of a repository: slug lower case.
type headKey struct{ slug, head string }

// prsByHead indexes pull requests by repository and head branch, each branch's oldest
// first (CreatedAt, then number). Placeholders without a head or URL and pull requests
// from a fork (their head is a branch of another repository) are left out.
func prsByHead(prs []gh.PullRequest) map[headKey][]gh.PullRequest {
	out := map[headKey][]gh.PullRequest{}
	for _, p := range prs {
		if p.HeadRef == "" || p.URL == "" || p.Number <= 0 || p.Repo == "" || p.IsCrossRepository {
			continue
		}
		k := headKey{strings.ToLower(p.Repo), p.HeadRef}
		out[k] = append(out[k], p)
	}
	for _, list := range out {
		slices.SortFunc(list, func(a, b gh.PullRequest) int {
			return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), cmp.Compare(a.Number, b.Number))
		})
	}
	return out
}

// threadBranches is the branches thread th works on, each in its project's GitHub
// repository: every member's of its project set (each checkout's branch; th.Branch for a
// derived worktree that is gone). A project without a GitHub slug and a
// detached worktree contribute nothing; so does a thread without a project.
func threadBranches(th thread.Thread, projects *project.Snapshot) []headKey {
	var out []headKey
	add := func(projectID, path, fallback string) {
		r, ok := projects.Project(projectID)
		if !ok || r.GitHubSlug == "" {
			return
		}
		head := fallback
		if wt, ok := projects.Worktree(projectID, path); ok {
			head = wt.Branch // "" when detached
		}
		if head == "" {
			return
		}
		k := headKey{strings.ToLower(r.GitHubSlug), head}
		if !slices.Contains(out, k) {
			out = append(out, k)
		}
	}
	// Every member of the thread's set (docs/notes/workspaces-v2-1-threads.md): the
	// primary's worktree, in worktree mode each other one's on the thread's branch, else
	// each other one's own checkout.
	for _, pid := range th.Projects() {
		switch {
		case pid == th.ProjectID:
			add(pid, th.WorktreePath, th.Branch)
		case th.CreatedWorktree && th.Branch != "":
			path := ""
			if r, ok := projects.Project(pid); ok {
				i := slices.IndexFunc(r.Worktrees, func(w project.Worktree) bool { return w.Branch == th.Branch && !w.Detached })
				if i >= 0 {
					path = r.Worktrees[i].Path
				}
			}
			add(pid, path, th.Branch)
		default:
			if r, ok := projects.Project(pid); ok {
				i := slices.IndexFunc(r.Worktrees, func(w project.Worktree) bool { return w.IsMain })
				if i >= 0 {
					add(pid, r.Worktrees[i].Path, "")
				}
			}
		}
	}
	return out
}

// threadLinks is one thread's new branch links.
type threadLinks struct {
	id    string
	links []thread.LinkedPullRequest
}

// branchLinksFor matches every thread in threads that is not archived against idx and
// returns the pull requests on each thread's branches it has not linked yet, linked at
// their creation (now when unknown). Threads with nothing new are left out, so a pass
// where nothing changed calls into the thread store not at all. Threads come oldest
// first: a creator predates what it created, so when a thread and the thread it
// created are on the same branch, the creator's own link is in before the copy from
// the created one, and each keeps source branch.
func branchLinksFor(threads *thread.Snapshot, projects *project.Snapshot,
	idx map[headKey][]gh.PullRequest, now time.Time) []threadLinks {
	var out []threadLinks
	if threads == nil || len(idx) == 0 {
		return out
	}
	ths := slices.Clone(threads.Threads)
	slices.SortStableFunc(ths, func(a, b thread.Thread) int {
		return cmp.Or(a.CreatedAt.Compare(b.CreatedAt), strings.Compare(a.ID, b.ID))
	})
	for _, th := range ths {
		if !th.ArchivedAt.IsZero() {
			continue
		}
		var links []thread.LinkedPullRequest
		for _, k := range threadBranches(th, projects) {
			for _, p := range idx[k] {
				has := func(l thread.LinkedPullRequest) bool { return l.URL == p.URL }
				if slices.ContainsFunc(th.LinkedPullRequests, has) || slices.ContainsFunc(links, has) {
					continue
				}
				links = append(links, thread.LinkedPullRequest{
					Slug: k.slug, Number: p.Number, URL: p.URL, LinkedAt: cmp.Or(p.CreatedAt, now), Source: thread.LinkBranch,
				})
			}
		}
		if len(links) > 0 {
			out = append(out, threadLinks{th.ID, links})
		}
	}
	return out
}

// linkBranchPullRequests runs one pass: index the cached pull requests, match every
// thread, push what is new. Returns how many links were added.
func linkBranchPullRequests(threads branchLinker, projects *project.Snapshot,
	prs branchPRCache, now time.Time) int {
	n := 0
	for _, f := range branchLinksFor(threads.Snapshot(), projects, prsByHead(prs.CachedPullRequests()), now) {
		n += threads.LinkBranchPullRequests(f.id, f.links)
	}
	return n
}

// branchLinkDelay is how long a pass waits after the first event that calls for one,
// so a poll's burst of events (one per changed branch) and a thread's run of updates
// come to one pass.
const branchLinkDelay = 200 * time.Millisecond

// wakesBranchLinks reports whether ev may change a thread's branch links: the GitHub
// store's cached lists changed, a thread changed (a new thread, a moved cwd), a project
// or worktree changed (a worktree switched branches).
func wakesBranchLinks(ev any) bool {
	switch ev.(type) {
	case gh.DashboardUpdated, gh.BranchPullRequestsUpdated, thread.Updated,
		project.ProjectUpdated, project.WorktreeUpdated:
		return true
	}
	return false
}

// startBranchLinks runs a pass at once, and one branchLinkDelay after an event that may
// change what it finds (wakesBranchLinks). Each pass reads the current state, so a
// dropped event costs nothing as long as another one follows. The returned func stops
// it.
func startBranchLinks(ctx context.Context, log *slog.Logger, threads branchLinker, projects func() *project.Snapshot,
	prs branchPRCache, b *bus.Bus) func() {
	ctx, cancel := context.WithCancel(ctx)
	dash := bus.Subscribe[gh.DashboardUpdated](b, 16)
	branches := bus.Subscribe[gh.BranchPullRequestsUpdated](b, 64)
	threadEvents := bus.Subscribe[thread.Event](b, 256)
	projectEvents := bus.Subscribe[project.Event](b, 256)
	pass := func() {
		if n := linkBranchPullRequests(threads, projects(), prs, time.Now()); n > 0 {
			log.Info("linked pull requests from thread branches", "links", n)
		}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer dash.Close()
		defer branches.Close()
		defer threadEvents.Close()
		defer projectEvents.Close()
		pass()
		var due <-chan time.Time
		for {
			var (
				ev   any
				open bool
			)
			select {
			case <-ctx.Done():
				return
			case <-due:
				due = nil
				pass()
				continue
			case e, o := <-dash.C():
				ev, open = e, o
			case e, o := <-branches.C():
				ev, open = e, o
			case e, o := <-threadEvents.C():
				ev, open = e, o
			case e, o := <-projectEvents.C():
				ev, open = e, o
			}
			if !open {
				return
			}
			if due == nil && wakesBranchLinks(ev) {
				due = time.After(branchLinkDelay)
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}
