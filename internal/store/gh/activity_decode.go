package gh

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Query names for the Phase 3a queries (file basenames under queries/).
const (
	querySearchPullRequests = "search_pull_requests"
	queryViewerStats        = "viewer_stats"
	queryRepoStats          = "repo_stats"
	queryBranchPullRequests = "branch_pull_requests"
	queryUserID             = "user_id"
)

// summaryJSON is a PullRequestSummary (+ PullRequestReview) node.
type summaryJSON struct {
	pullRequestJSON
	Typename   string    `json:"__typename"`
	State      string    `json:"state"`
	CreatedAt  time.Time `json:"createdAt"`
	MergedAt   time.Time `json:"mergedAt"`
	Repository *struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"repository"`
}

func mapSummary(n *summaryJSON) PullRequest {
	pr := mapPullRequest(&n.pullRequestJSON)
	pr.State, pr.CreatedAt, pr.MergedAt = PullRequestState(n.State), n.CreatedAt, n.MergedAt
	if n.Repository != nil {
		pr.Repo, _ = NormalizeSlug(n.Repository.NameWithOwner)
	}
	return pr
}

// searchResult is one decoded SearchPullRequests response.
type searchResult struct {
	PullRequests []PullRequest
	Total        int
}

func decodeSearchPullRequests(data []byte) (searchResult, error) {
	var d struct {
		Search *struct {
			IssueCount int           `json:"issueCount"`
			Nodes      []summaryJSON `json:"nodes"`
		} `json:"search"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return searchResult{}, fmt.Errorf("decode search: %w", err)
	}
	if d.Search == nil {
		return searchResult{}, errors.New("decode search: no search result")
	}
	out := searchResult{Total: d.Search.IssueCount, PullRequests: make([]PullRequest, 0, len(d.Search.Nodes))}
	for i := range d.Search.Nodes {
		n := &d.Search.Nodes[i]
		if n.Typename != "" && n.Typename != "PullRequest" {
			continue
		}
		out.PullRequests = append(out.PullRequests, mapSummary(n))
	}
	return out, nil
}

type countJSON struct {
	IssueCount int `json:"issueCount"`
}

type totalJSON struct {
	TotalCount int `json:"totalCount"`
}

// viewerStats is a decoded ViewerStats response.
type viewerStats struct {
	MergedThis, MergedLast   int
	ContribThis, ContribLast int
}

func decodeViewerStats(data []byte) (viewerStats, error) {
	var d struct {
		MergedThis *countJSON `json:"mergedThis"`
		MergedLast *countJSON `json:"mergedLast"`
		User       *struct {
			ThisMonth struct {
				Total int `json:"totalCommitContributions"`
			} `json:"thisMonth"`
			LastMonth struct {
				Total int `json:"totalCommitContributions"`
			} `json:"lastMonth"`
		} `json:"user"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return viewerStats{}, fmt.Errorf("decode viewer stats: %w", err)
	}
	if d.MergedThis == nil || d.MergedLast == nil {
		return viewerStats{}, errors.New("decode viewer stats: missing search counts")
	}
	if d.User == nil {
		return viewerStats{}, fmt.Errorf("decode viewer stats: user: %w", ErrNotFound)
	}
	return viewerStats{
		MergedThis: d.MergedThis.IssueCount, MergedLast: d.MergedLast.IssueCount,
		ContribThis: d.User.ThisMonth.Total, ContribLast: d.User.LastMonth.Total,
	}, nil
}

// decodeSearchTotal reads total_count from a REST search response.
func decodeSearchTotal(body []byte) (int, error) {
	var d struct {
		TotalCount *int `json:"total_count"`
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return 0, fmt.Errorf("decode search/commits: %w", err)
	}
	if d.TotalCount == nil {
		return 0, errors.New("decode search/commits: no total_count")
	}
	return *d.TotalCount, nil
}

// repoStats is a decoded RepoStats response.
type repoStats struct {
	CommitsThis, CommitsLast int
	MergedThis, MergedLast   int
}

func decodeRepoStats(data []byte) (repoStats, error) {
	var d struct {
		Repository *struct {
			DefaultBranchRef *struct {
				Target *struct {
					ThisMonth *totalJSON `json:"thisMonth"`
					LastMonth *totalJSON `json:"lastMonth"`
				} `json:"target"`
			} `json:"defaultBranchRef"`
		} `json:"repository"`
		MergedThis *countJSON `json:"mergedThis"`
		MergedLast *countJSON `json:"mergedLast"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return repoStats{}, fmt.Errorf("decode repo stats: %w", err)
	}
	if d.Repository == nil {
		return repoStats{}, fmt.Errorf("decode repo stats: repository: %w", ErrNotFound)
	}
	var out repoStats
	if d.MergedThis != nil {
		out.MergedThis = d.MergedThis.IssueCount
	}
	if d.MergedLast != nil {
		out.MergedLast = d.MergedLast.IssueCount
	}
	// An empty repository has no default branch: no commits.
	if ref := d.Repository.DefaultBranchRef; ref != nil && ref.Target != nil {
		if t := ref.Target.ThisMonth; t != nil {
			out.CommitsThis = t.TotalCount
		}
		if t := ref.Target.LastMonth; t != nil {
			out.CommitsLast = t.TotalCount
		}
	}
	return out, nil
}

func decodeBranchPullRequests(data []byte) ([]PullRequest, error) {
	var d struct {
		Repository *struct {
			PullRequests struct {
				Nodes []summaryJSON `json:"nodes"`
			} `json:"pullRequests"`
		} `json:"repository"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return nil, fmt.Errorf("decode branch pull requests: %w", err)
	}
	if d.Repository == nil {
		return nil, fmt.Errorf("decode branch pull requests: repository: %w", ErrNotFound)
	}
	out := make([]PullRequest, 0, len(d.Repository.PullRequests.Nodes))
	for i := range d.Repository.PullRequests.Nodes {
		out = append(out, mapSummary(&d.Repository.PullRequests.Nodes[i]))
	}
	return out, nil
}

func decodeUserID(data []byte) (string, error) {
	var d struct {
		User *struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := json.Unmarshal(data, &d); err != nil {
		return "", fmt.Errorf("decode user: %w", err)
	}
	if d.User == nil || d.User.ID == "" {
		return "", fmt.Errorf("decode user: %w", ErrNotFound)
	}
	return d.User.ID, nil
}

// defaultBranchJSON is DefaultBranchFields' defaultBranchRef.
type defaultBranchJSON struct {
	Name   string `json:"name"`
	Target *struct {
		commitJSON
		CommittedDate   time.Time `json:"committedDate"`
		MessageHeadline string    `json:"messageHeadline"`
	} `json:"target"`
}

// decodeDefaultBranchField returns the defaultBranchRef a PullRequests page selected
// with withDefaultBranch, or nil when it was not selected or the repository is empty.
func decodeDefaultBranchField(data []byte) *defaultBranchJSON {
	var d struct {
		Repository *struct {
			DefaultBranchRef *defaultBranchJSON `json:"defaultBranchRef"`
		} `json:"repository"`
	}
	if json.Unmarshal(data, &d) != nil || d.Repository == nil || d.Repository.DefaultBranchRef == nil ||
		d.Repository.DefaultBranchRef.Target == nil {
		return nil
	}
	return d.Repository.DefaultBranchRef
}

// mapDefaultBranch maps the first page of the default branch's checks and returns the
// page info for the rest.
func mapDefaultBranch(raw *defaultBranchJSON) (BranchCI, pageInfoJSON) {
	t := raw.Target
	ci := BranchCI{Branch: raw.Name, SHA: t.Oid, Headline: t.MessageHeadline, CommittedAt: t.CommittedDate}
	page := mapChecksPage(&t.commitJSON)
	ci.Rollup = page.Rollup
	ci.Failing = failingRuns(page.Runs)
	return ci, page.Next
}

// failingRuns keeps the checks in the failed bucket.
func failingRuns(runs []CheckRun) []CheckRun {
	var out []CheckRun
	for _, r := range runs {
		if runBucket(r) == bucketFailed {
			out = append(out, r)
		}
	}
	return out
}

func isServerTimeout(err error) bool { return errors.Is(err, ErrServerTimeout) }

func isAuthOrNetwork(err error) bool {
	return errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrNetwork)
}
