package daemon

import (
	"context"
	"slices"
	"strings"

	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/project"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// pluginFacts answers the plugin store's predicate facts from the thread, project and gh
// stores (plugin.FactSource), so the plugin store imports none of them.
type pluginFacts struct {
	thread  *thread.Manager
	project *project.Git
	gh      gh.Service
}

var _ plugin.FactSource = pluginFacts{}

// Thread implements plugin.FactSource.
func (f pluginFacts) Thread(id string) (plugin.ThreadFacts, bool) {
	t, ok := f.thread.Snapshot().Thread(id)
	if !ok {
		return plugin.ThreadFacts{}, false
	}
	out := plugin.ThreadFacts{
		ID: t.ID, State: t.State.String(), Status: t.Status.String(), ProjectID: t.ProjectID, WorkspaceID: t.WorkspaceID,
		WorktreePath: t.WorktreePath, Branch: t.Branch,
	}
	ps := f.project.Snapshot()
	if w, ok := ps.Worktree(t.ProjectID, t.WorktreePath); ok && w.Branch != "" {
		out.Branch = w.Branch
	}
	out.PullRequests = f.threadPullRequests(context.Background(), t, ps, out.Branch)
	return out, true
}

// threadPullRequests are a thread's pull requests, the one to show first: its branch's
// (an open one first, as the GUI's pull request surface picks), then the ones Claude
// linked, newest first.
func (f pluginFacts) threadPullRequests(ctx context.Context, t thread.Thread, ps *project.Snapshot, branch string) []plugin.PullRequestRef {
	var out []plugin.PullRequestRef
	add := func(r plugin.PullRequestRef) {
		if r.Slug == "" || r.Number <= 0 || slices.ContainsFunc(out, func(x plugin.PullRequestRef) bool {
			return strings.EqualFold(x.Slug, r.Slug) && x.Number == r.Number
		}) {
			return
		}
		out = append(out, r)
	}
	if p, ok := ps.Project(t.ProjectID); ok && p.GitHubSlug != "" && branch != "" && f.gh != nil {
		// Cached: BranchPullRequests never waits on GitHub (and keeps the branch polled).
		if b, err := f.gh.BranchPullRequests(ctx, p.GitHubSlug, branch); err == nil {
			prs := slices.Clone(b.PullRequests)
			slices.SortStableFunc(prs, func(a, b gh.PullRequest) int {
				ao, bo := a.State == gh.PullRequestOpen, b.State == gh.PullRequestOpen
				switch {
				case ao && !bo:
					return -1
				case bo && !ao:
					return 1
				}
				return 0
			})
			for _, pr := range prs {
				slug := pr.Repo
				if slug == "" {
					slug = p.GitHubSlug
				}
				add(plugin.PullRequestRef{Slug: slug, Number: pr.Number, URL: pr.URL})
			}
		}
	}
	for i := len(t.LinkedPullRequests) - 1; i >= 0; i-- {
		l := t.LinkedPullRequests[i]
		add(plugin.PullRequestRef{Slug: l.Slug, Number: l.Number, URL: l.URL})
	}
	return out
}

// Project implements plugin.FactSource.
func (f pluginFacts) Project(id string) (plugin.ProjectFacts, bool) {
	p, ok := f.project.Snapshot().Project(id)
	if !ok {
		return plugin.ProjectFacts{}, false
	}
	return plugin.ProjectFacts{ID: p.ID, Name: p.Name, Slug: p.GitHubSlug, Git: p.Git}, true
}

// PullRequestChecks implements plugin.FactSource.
func (f pluginFacts) PullRequestChecks(ctx context.Context, slug string, number int) ([]plugin.CheckRun, error) {
	d, err := f.gh.PullRequest(ctx, slug, number)
	if err != nil {
		return nil, err
	}
	out := make([]plugin.CheckRun, len(d.Checks))
	for i, c := range d.Checks {
		out[i] = plugin.CheckRun{Name: c.Name, Workflow: c.Workflow, Status: string(c.Status), Conclusion: string(c.Conclusion),
			App: c.App, URL: c.URL, StartedAt: c.StartedAt, CompletedAt: c.CompletedAt}
	}
	return out, nil
}

// threadPullRequest is pr.checks' thread → pull request: the first of the thread's.
func (f pluginFacts) threadPullRequest(_ context.Context, id string) (string, int, bool) {
	t, ok := f.Thread(id)
	if !ok || len(t.PullRequests) == 0 {
		return "", 0, false
	}
	return t.PullRequests[0].Slug, t.PullRequests[0].Number, true
}
