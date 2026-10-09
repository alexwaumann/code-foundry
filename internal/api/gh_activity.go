package api

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// GetDashboard returns the viewer's dashboards and global stats from the snapshot,
// filtered to tracked repositories unless include_untracked.
func (h *Gh) GetDashboard(_ context.Context, req *connect.Request[v1.GetDashboardRequest]) (*connect.Response[v1.GetDashboardResponse], error) {
	snap := h.store.Snapshot()
	d := snap.Dashboard
	tracked := trackedSlugs(snap)
	keep := func(p gh.PullRequest) bool {
		return req.Msg.GetIncludeUntracked() || slices.Contains(tracked, p.Repo)
	}
	res := &v1.GetDashboardResponse{
		Authenticated:      snap.Viewer.Authenticated,
		Authored:           searchPullRequestsToProto(d.Authored, keep),
		ReviewRequested:    searchPullRequestsToProto(d.ReviewRequested, keep),
		Reviewed:           searchPullRequestsToProto(d.Reviewed, keep),
		RecentlyMerged:     searchPullRequestsToProto(d.RecentlyMerged, keep),
		Stats:              statsToProto(d.Stats),
		FetchedAt:          timestamp(d.FetchedAt),
		LastError:          d.LastError,
		TrackedSlugs:       tracked,
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
		RecentlyMerged: searchPullRequestsToProto(snap.Dashboard.RecentlyMerged, func(p gh.PullRequest) bool { return p.Repo == slug }),
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
	month := func(m gh.MonthCount) *v1.MonthActivity {
		return &v1.MonthActivity{Month: m.Month, Commits: int32(m.Commits), Merged: int32(m.Merged)}
	}
	return &v1.ActivityStats{
		ThisMonth:     month(s.ThisMonth),
		LastMonth:     month(s.LastMonth),
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
