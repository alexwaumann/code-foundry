package gh

import "slices"

// Typed equality helpers for hot-path poll and detail comparisons. They replace
// json.Marshal-based comparisons (sameJSON) so polls do not serialize whole dashboards,
// branch lists, or pull request details on every cycle, while matching the same
// client-visible semantics (ignoring fetch times and using time.Time.Equal).

func sameDashboard(a, b Dashboard) bool {
	return a.LastError == b.LastError &&
		a.Disabled == b.Disabled &&
		a.AuthoredTotal == b.AuthoredTotal &&
		a.ReviewRequestedTotal == b.ReviewRequestedTotal &&
		a.ReviewedTotal == b.ReviewedTotal &&
		a.RecentlyMergedTotal == b.RecentlyMergedTotal &&
		a.ReviewedListed == b.ReviewedListed &&
		sameStats(a.Stats, b.Stats) &&
		samePullRequestsStrictNil(a.Authored, b.Authored) &&
		samePullRequestsStrictNil(a.ReviewRequested, b.ReviewRequested) &&
		samePullRequestsStrictNil(a.Reviewed, b.Reviewed) &&
		samePullRequestsStrictNil(a.RecentlyMerged, b.RecentlyMerged)
}

func sameStats(a, b MonthlyStats) bool {
	return a.LastError == b.LastError &&
		a.CommitsSource == b.CommitsSource &&
		(a.Months == nil) == (b.Months == nil) &&
		slices.Equal(a.Months, b.Months)
}

func sameBranchCI(a, b BranchCI) bool {
	return a.LastError == b.LastError &&
		a.Branch == b.Branch &&
		a.SHA == b.SHA &&
		a.Headline == b.Headline &&
		a.CommittedAt.Equal(b.CommittedAt) &&
		a.Rollup == b.Rollup &&
		sameCheckRuns(a.Failing, b.Failing)
}

func sameProjects(a, b ProjectPullRequests) bool {
	return a.LastError == b.LastError &&
		a.Open.Total == b.Open.Total &&
		a.Merged.Total == b.Merged.Total &&
		samePullRequestsStrictNil(a.Open.PullRequests, b.Open.PullRequests) &&
		samePullRequestsStrictNil(a.Merged.PullRequests, b.Merged.PullRequests)
}

func sameFull(a, b FullPullRequest) bool {
	return samePullRequestValue(a.PullRequest, b.PullRequest) &&
		a.Body == b.Body &&
		a.LabelsTruncated == b.LabelsTruncated &&
		a.ReviewersTruncated == b.ReviewersTruncated &&
		a.CommitCount == b.CommitCount &&
		a.CommentsTruncated == b.CommentsTruncated &&
		a.ThreadsTruncated == b.ThreadsTruncated &&
		a.ChecksTruncated == b.ChecksTruncated &&
		a.MergeCommitSHA == b.MergeCommitSHA &&
		a.MergedBy == b.MergedBy &&
		a.ClosedAt.Equal(b.ClosedAt) &&
		a.AutoMerge == b.AutoMerge &&
		a.AutoMergeMethod == b.AutoMergeMethod &&
		a.AutoMergeAllowed == b.AutoMergeAllowed &&
		a.DefaultBranch == b.DefaultBranch &&
		a.ViewerPermission == b.ViewerPermission &&
		a.ViewerCanClose == b.ViewerCanClose &&
		a.ViewerCanReopen == b.ViewerCanReopen &&
		slices.Equal(a.Labels, b.Labels) &&
		sameReviewers(a.Reviewers, b.Reviewers) &&
		sameCommits(a.Commits, b.Commits) &&
		sameComments(a.Comments, b.Comments) &&
		sameReviewThreads(a.Threads, b.Threads) &&
		sameCheckRuns(a.Checks, b.Checks) &&
		slices.Equal(a.MergeMethods, b.MergeMethods)
}

func samePullRequestsStrictNil(a, b []PullRequest) bool {
	if (a == nil) != (b == nil) || len(a) != len(b) {
		return false
	}
	for i := range a {
		if !samePullRequestValue(a[i], b[i]) {
			return false
		}
	}
	return true
}

func samePullRequestValue(a, b PullRequest) bool {
	return a.ID == b.ID &&
		a.Number == b.Number &&
		a.Title == b.Title &&
		a.Author == b.Author &&
		a.HeadRef == b.HeadRef &&
		a.HeadSHA == b.HeadSHA &&
		a.BaseRef == b.BaseRef &&
		a.BaseSHA == b.BaseSHA &&
		a.Draft == b.Draft &&
		a.ReviewDecision == b.ReviewDecision &&
		a.Mergeable == b.Mergeable &&
		a.MergeStateStatus == b.MergeStateStatus &&
		a.IsCrossRepository == b.IsCrossRepository &&
		a.HeadRepoSlug == b.HeadRepoSlug &&
		a.URL == b.URL &&
		a.UpdatedAt.Equal(b.UpdatedAt) &&
		a.Checks == b.Checks &&
		a.Repo == b.Repo &&
		a.State == b.State &&
		a.CreatedAt.Equal(b.CreatedAt) &&
		a.MergedAt.Equal(b.MergedAt) &&
		a.Additions == b.Additions &&
		a.Deletions == b.Deletions &&
		a.ChangedFiles == b.ChangedFiles &&
		a.Comments == b.Comments &&
		a.Reviews == b.Reviews &&
		a.ReviewCommits == b.ReviewCommits &&
		a.Partial == b.Partial &&
		sameReviews(a.LatestReviews, b.LatestReviews) &&
		slices.Equal(a.ReviewRequests, b.ReviewRequests)
}

func sameReviews(a, b []Review) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Author != b[i].Author ||
			a[i].State != b[i].State ||
			!a[i].SubmittedAt.Equal(b[i].SubmittedAt) ||
			a[i].CommitSHA != b[i].CommitSHA {
			return false
		}
	}
	return true
}

func sameCheckRuns(a, b []CheckRun) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name ||
			a[i].Workflow != b[i].Workflow ||
			a[i].Status != b[i].Status ||
			a[i].Conclusion != b[i].Conclusion ||
			a[i].URL != b[i].URL ||
			a[i].Description != b[i].Description ||
			!a[i].StartedAt.Equal(b[i].StartedAt) ||
			!a[i].CompletedAt.Equal(b[i].CompletedAt) ||
			a[i].App != b[i].App {
			return false
		}
	}
	return true
}

func sameReviewers(a, b []Reviewer) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Login != b[i].Login ||
			a[i].Team != b[i].Team ||
			a[i].Bot != b[i].Bot ||
			a[i].AvatarURL != b[i].AvatarURL ||
			a[i].State != b[i].State ||
			!a[i].SubmittedAt.Equal(b[i].SubmittedAt) ||
			a[i].Requested != b[i].Requested ||
			a[i].Stale != b[i].Stale {
			return false
		}
	}
	return true
}

func sameCommits(a, b []Commit) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].SHA != b[i].SHA ||
			a[i].Headline != b[i].Headline ||
			a[i].AuthorLogin != b[i].AuthorLogin ||
			a[i].AuthorName != b[i].AuthorName ||
			!a[i].CommittedAt.Equal(b[i].CommittedAt) {
			return false
		}
	}
	return true
}

func sameComments(a, b []Comment) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID ||
			a[i].Kind != b[i].Kind ||
			a[i].Author != b[i].Author ||
			a[i].AuthorBot != b[i].AuthorBot ||
			a[i].AuthorAvatar != b[i].AuthorAvatar ||
			a[i].Body != b[i].Body ||
			!a[i].CreatedAt.Equal(b[i].CreatedAt) ||
			a[i].URL != b[i].URL ||
			a[i].Path != b[i].Path ||
			a[i].ReviewState != b[i].ReviewState ||
			a[i].ReviewID != b[i].ReviewID {
			return false
		}
	}
	return true
}

func sameReviewThreads(a, b []ReviewThread) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID ||
			a[i].Path != b[i].Path ||
			a[i].Line != b[i].Line ||
			a[i].Side != b[i].Side ||
			a[i].Resolved != b[i].Resolved ||
			a[i].Outdated != b[i].Outdated ||
			a[i].CommentsTruncated != b[i].CommentsTruncated ||
			(a[i].Comments == nil) != (b[i].Comments == nil) ||
			!sameComments(a[i].Comments, b[i].Comments) {
			return false
		}
	}
	return true
}
