package api

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GetDashboard returns the viewer's dashboards and global stats from the snapshot. The
// lists are viewer-wide (every repository); include_untracked is ignored.
func (h *Gh) GetDashboard(_ context.Context, _ *connect.Request[v1.GetDashboardRequest]) (*connect.Response[v1.GetDashboardResponse], error) {
	snap := h.store.Snapshot()
	d := snap.Dashboard
	res := &v1.GetDashboardResponse{
		Authenticated:      snap.Viewer.Authenticated,
		Authored:           searchPullRequestsToProto(localRepos(snap, d.Authored), nil),
		ReviewRequested:    searchPullRequestsToProto(localRepos(snap, d.ReviewRequested), nil),
		Reviewed:           searchPullRequestsToProto(localRepos(snap, d.Reviewed), nil),
		RecentlyMerged:     searchPullRequestsToProto(localRepos(snap, d.RecentlyMerged), nil),
		Stats:              statsToProto(d.Stats),
		FetchedAt:          timestamp(d.FetchedAt),
		LastError:          d.LastError,
		TrackedSlugs:       trackedSlugs(snap),
		DashboardsDisabled: d.Disabled,
	}
	if v := snap.Viewer.Viewer; v != nil {
		res.Viewer = &v1.GhViewer{Login: v.Login, Name: v.Name, AvatarUrl: v.AvatarURL, Url: v.URL}
	}
	return connect.NewResponse(res), nil
}

// GetRepoActivity returns one repository's activity from the snapshot.
func (h *Gh) GetRepoActivity(_ context.Context, req *connect.Request[v1.GetRepoActivityRequest]) (*connect.Response[v1.GetRepoActivityResponse], error) {
	slug, err := gh.NormalizeSlug(req.Msg.GetRepoSlug())
	if err != nil {
		return nil, ghError(err)
	}
	snap := h.store.Snapshot()
	r := snap.Repos[slug]
	res := &v1.GetRepoActivityResponse{
		RepoSlug:       slug,
		Tracked:        r.Tracked,
		Stats:          statsToProto(r.Activity.Stats),
		RecentlyMerged: searchPullRequestsToProto(localRepos(snap, snap.Dashboard.RecentlyMerged), func(p gh.PullRequest) bool { return p.Repo == slug }),
	}
	if ci := r.Activity.DefaultBranch; !ci.FetchedAt.IsZero() || ci.LastError != "" {
		res.DefaultBranch = &v1.DefaultBranchStatus{
			Branch:      ci.Branch,
			Sha:         ci.SHA,
			Headline:    ci.Headline,
			CommittedAt: timestamp(ci.CommittedAt),
			Rollup:      rollupToProto(ci.Rollup),
			Failing:     checkRunsToProto(ci.Failing),
			FetchedAt:   timestamp(ci.FetchedAt),
			LastError:   ci.LastError,
		}
	}
	return connect.NewResponse(res), nil
}

// GetBranchPullRequests returns the viewer's cached pull requests for a branch and
// keeps the branch polled.
func (h *Gh) GetBranchPullRequests(ctx context.Context, req *connect.Request[v1.GetBranchPullRequestsRequest]) (*connect.Response[v1.GetBranchPullRequestsResponse], error) {
	b, err := h.store.BranchPullRequests(ctx, req.Msg.GetRepoSlug(), req.Msg.GetHeadRef())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.GetBranchPullRequestsResponse{
		PullRequests: searchPullRequestsToProto(b.PullRequests, nil),
		FetchedAt:    timestamp(b.FetchedAt),
		LastError:    b.LastError,
	}), nil
}

// trackedSlugs lists the tracked repositories, sorted.
func trackedSlugs(snap *gh.Snapshot) []string {
	out := []string{}
	for slug, r := range snap.Repos {
		if r.Tracked {
			out = append(out, slug)
		}
	}
	slices.Sort(out)
	return out
}

// localRepos is prs with each repository as the projects know it: a renamed one's
// search results carry its new name (gh.Snapshot.LocalRepo). prs is not modified.
func localRepos(snap *gh.Snapshot, prs []gh.PullRequest) []gh.PullRequest {
	var out []gh.PullRequest
	for i, p := range prs {
		local := snap.LocalRepo(p.Repo)
		if local == p.Repo {
			continue
		}
		if out == nil {
			out = slices.Clone(prs)
		}
		out[i].Repo = local
	}
	if out == nil {
		return prs
	}
	return out
}

// searchPullRequestsToProto maps pull requests that carry their own repository (search
// and branch results), keeping those keep accepts (nil keeps all).
func searchPullRequestsToProto(prs []gh.PullRequest, keep func(gh.PullRequest) bool) []*v1.PullRequest {
	out := make([]*v1.PullRequest, 0, len(prs))
	for i := range prs {
		if keep != nil && !keep(prs[i]) {
			continue
		}
		out = append(out, pullRequestToProto(prs[i].Repo, &prs[i]))
	}
	return out
}

func statsToProto(s gh.MonthlyStats) *v1.ActivityStats {
	months := make([]*v1.MonthActivity, 0, len(s.Months))
	for _, m := range s.Months {
		months = append(months, &v1.MonthActivity{Month: m.Month, Commits: int32(m.Commits), Merged: int32(m.Merged)})
	}
	return &v1.ActivityStats{
		Months:        months,
		CommitsSource: s.CommitsSource,
		FetchedAt:     timestamp(s.FetchedAt),
		LastError:     s.LastError,
	}
}

// ghDashboardEvent, ghRepoActivityEvent, and ghBranchEvent map the Phase 3a gh bus
// events; shared by GhService.Watch and EventService.
func ghDashboardEvent(e gh.DashboardUpdated) *v1.GhEvent {
	return &v1.GhEvent{Event: &v1.GhEvent_DashboardUpdated_{DashboardUpdated: &v1.GhEvent_DashboardUpdated{
		FetchedAt: timestamp(e.FetchedAt),
	}}}
}

func ghRepoActivityEvent(e gh.RepoActivityUpdated) *v1.GhEvent {
	return &v1.GhEvent{Event: &v1.GhEvent_RepoActivityUpdated_{RepoActivityUpdated: &v1.GhEvent_RepoActivityUpdated{
		RepoSlug: e.Slug, FetchedAt: timestamp(e.FetchedAt),
	}}}
}

func ghBranchEvent(e gh.BranchPullRequestsUpdated) *v1.GhEvent {
	return &v1.GhEvent{Event: &v1.GhEvent_BranchPullRequestsUpdated_{BranchPullRequestsUpdated: &v1.GhEvent_BranchPullRequestsUpdated{
		RepoSlug: e.Slug, HeadRef: e.HeadRef, FetchedAt: timestamp(e.FetchedAt),
	}}}
}
