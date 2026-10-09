package gh

import (
	"cmp"
	"encoding/json"
	"fmt"
	"sort"
	"time"
)

// JSON shapes of the queries in queries/. Unexported; mapped to the domain types by
// the pure functions below.

type rateLimitJSON struct {
	Limit     int       `json:"limit"`
	Cost      int       `json:"cost"`
	Remaining int       `json:"remaining"`
	ResetAt   time.Time `json:"resetAt"`
}

type pageInfoJSON struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

type stateCountJSON struct {
	State string `json:"state"`
	Count int    `json:"count"`
}

type contextNodeJSON struct {
	Typename string `json:"__typename"`
	// CheckRun
	Name        string    `json:"name"`
	Status      string    `json:"status"`
	Conclusion  string    `json:"conclusion"`
	DetailsURL  string    `json:"detailsUrl"`
	StartedAt   time.Time `json:"startedAt"`
	CompletedAt time.Time `json:"completedAt"`
	CheckSuite  *struct {
		WorkflowRun *struct {
			Workflow struct {
				Name string `json:"name"`
			} `json:"workflow"`
		} `json:"workflowRun"`
	} `json:"checkSuite"`
	// StatusContext
	Context     string    `json:"context"`
	State       string    `json:"state"`
	TargetURL   string    `json:"targetUrl"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"createdAt"`
}

type contextsJSON struct {
	CheckRunCount              int               `json:"checkRunCount"`
	CheckRunCountsByState      []stateCountJSON  `json:"checkRunCountsByState"`
	StatusContextCount         int               `json:"statusContextCount"`
	StatusContextCountsByState []stateCountJSON  `json:"statusContextCountsByState"`
	PageInfo                   pageInfoJSON      `json:"pageInfo"`
	Nodes                      []contextNodeJSON `json:"nodes"`
}

type rollupJSON struct {
	State    string       `json:"state"`
	Contexts contextsJSON `json:"contexts"`
}

type commitJSON struct {
	Oid               string      `json:"oid"`
	StatusCheckRollup *rollupJSON `json:"statusCheckRollup"`
}

type loginJSON struct {
	Login string `json:"login"`
}

type nameWithOwnerJSON struct {
	NameWithOwner string `json:"nameWithOwner"`
}

type totalJSON struct {
	TotalCount int `json:"totalCount"`
}

// pullRequestJSON is a PullRequestSummary or PullRequestDetail node (fragments.graphql).
type pullRequestJSON struct {
	Typename          string             `json:"__typename"`
	ID                string             `json:"id"`
	Number            int                `json:"number"`
	Title             string             `json:"title"`
	URL               string             `json:"url"`
	State             string             `json:"state"`
	IsDraft           bool               `json:"isDraft"`
	CreatedAt         time.Time          `json:"createdAt"`
	UpdatedAt         time.Time          `json:"updatedAt"`
	MergedAt          time.Time          `json:"mergedAt"`
	Author            *loginJSON         `json:"author"`
	Repository        *nameWithOwnerJSON `json:"repository"`
	HeadRefName       string             `json:"headRefName"`
	HeadRefOid        string             `json:"headRefOid"`
	BaseRefName       string             `json:"baseRefName"`
	IsCrossRepository bool               `json:"isCrossRepository"`
	Additions         int                `json:"additions"`
	Deletions         int                `json:"deletions"`
	ChangedFiles      int                `json:"changedFiles"`
	StatusCheckRollup *rollupJSON        `json:"statusCheckRollup"`
	// PullRequestDetail only.
	HeadRepository     *nameWithOwnerJSON `json:"headRepository"`
	ReviewDecision     string             `json:"reviewDecision"`
	Mergeable          string             `json:"mergeable"`
	MergeStateStatus   string             `json:"mergeStateStatus"`
	TotalCommentsCount int                `json:"totalCommentsCount"`
	Reviews            *totalJSON         `json:"reviews"`
	LatestReviews      *struct {
		Nodes []struct {
			Author      *loginJSON `json:"author"`
			State       string     `json:"state"`
			SubmittedAt time.Time  `json:"submittedAt"`
		} `json:"nodes"`
	} `json:"latestReviews"`
	ReviewRequests *struct {
		Nodes []struct {
			RequestedReviewer *requestedReviewerJSON `json:"requestedReviewer"`
		} `json:"nodes"`
	} `json:"reviewRequests"`
	// pull_request.graphql's paged checks (alias of statusCheckRollup).
	Checks *rollupJSON `json:"checks"`
}

// requestedReviewerJSON is a User, Bot, Mannequin (login) or Team (slug, organization).
type requestedReviewerJSON struct {
	Typename     string     `json:"__typename"`
	Login        string     `json:"login"`
	Slug         string     `json:"slug"`
	Organization *loginJSON `json:"organization"`
}

type pullRequestData struct {
	RateLimit  *rateLimitJSON `json:"rateLimit"`
	Repository *struct {
		PullRequest *pullRequestJSON `json:"pullRequest"`
	} `json:"repository"`
}

type checksData struct {
	RateLimit  *rateLimitJSON `json:"rateLimit"`
	Repository *struct {
		Object *commitJSON `json:"object"`
	} `json:"repository"`
}

// checksPage is one decoded page of a commit's checks.
type checksPage struct {
	SHA    string
	Rollup CheckRollup
	Runs   []CheckRun
	Next   pageInfoJSON
}

// decodePullRequest maps a PullRequest query page: the PR (from every page) and one
// page of its head commit's checks.
func decodePullRequest(data []byte) (PullRequest, checksPage, *rateLimitJSON, error) {
	var d pullRequestData
	if err := json.Unmarshal(data, &d); err != nil {
		return PullRequest{}, checksPage{}, nil, fmt.Errorf("decode pull request: %w", err)
	}
	if d.Repository == nil || d.Repository.PullRequest == nil {
		return PullRequest{}, checksPage{}, d.RateLimit, fmt.Errorf("decode pull request: %w", ErrNotFound)
	}
	p := d.Repository.PullRequest
	pr := mapPullRequest(p)
	return pr, mapChecksPage(&commitJSON{Oid: p.HeadRefOid, StatusCheckRollup: p.Checks}), d.RateLimit, nil
}

// decodeChecks maps a Checks query page.
func decodeChecks(data []byte) (checksPage, *rateLimitJSON, error) {
	var d checksData
	if err := json.Unmarshal(data, &d); err != nil {
		return checksPage{}, nil, fmt.Errorf("decode checks: %w", err)
	}
	// object is null for an unknown ref, and {} (no oid) when it is not a commit.
	if d.Repository == nil || d.Repository.Object == nil || d.Repository.Object.Oid == "" {
		return checksPage{}, d.RateLimit, fmt.Errorf("decode checks: ref: %w", ErrNotFound)
	}
	return mapChecksPage(d.Repository.Object), d.RateLimit, nil
}

func mapChecksPage(c *commitJSON) checksPage {
	if c == nil {
		return checksPage{}
	}
	page := checksPage{SHA: c.Oid}
	if r := c.StatusCheckRollup; r != nil {
		page.Rollup = mapRollup(r)
		page.Next = r.Contexts.PageInfo
		page.Runs = make([]CheckRun, 0, len(r.Contexts.Nodes))
		for i := range r.Contexts.Nodes {
			if run, ok := mapContext(&r.Contexts.Nodes[i]); ok {
				page.Runs = append(page.Runs, run)
			}
		}
	}
	return page
}

func mapPullRequest(p *pullRequestJSON) PullRequest {
	pr := PullRequest{
		ID:                p.ID,
		Number:            p.Number,
		Title:             p.Title,
		HeadRef:           p.HeadRefName,
		HeadSHA:           p.HeadRefOid,
		BaseRef:           p.BaseRefName,
		Draft:             p.IsDraft,
		ReviewDecision:    ReviewDecision(p.ReviewDecision),
		Mergeable:         Mergeable(p.Mergeable),
		MergeStateStatus:  MergeStateStatus(p.MergeStateStatus),
		IsCrossRepository: p.IsCrossRepository,
		URL:               p.URL,
		UpdatedAt:         p.UpdatedAt,
		State:             PullRequestState(p.State),
		CreatedAt:         p.CreatedAt,
		MergedAt:          p.MergedAt,
		Additions:         p.Additions,
		Deletions:         p.Deletions,
		ChangedFiles:      p.ChangedFiles,
		Comments:          p.TotalCommentsCount,
	}
	if p.Author != nil {
		pr.Author = p.Author.Login
	}
	if p.Repository != nil {
		pr.Repo, _ = NormalizeSlug(p.Repository.NameWithOwner)
	}
	if p.HeadRepository != nil {
		pr.HeadRepoSlug = p.HeadRepository.NameWithOwner
	}
	if r := cmp.Or(p.StatusCheckRollup, p.Checks); r != nil {
		pr.Checks = mapRollup(r)
	}
	if p.Reviews != nil {
		pr.Reviews = p.Reviews.TotalCount
	}
	if p.LatestReviews != nil {
		for _, n := range p.LatestReviews.Nodes {
			r := Review{State: n.State, SubmittedAt: n.SubmittedAt}
			if n.Author != nil {
				r.Author = n.Author.Login
			}
			pr.LatestReviews = append(pr.LatestReviews, r)
		}
	}
	if p.ReviewRequests != nil {
		for _, n := range p.ReviewRequests.Nodes {
			if who := reviewerName(n.RequestedReviewer); who != "" {
				pr.ReviewRequests = append(pr.ReviewRequests, who)
			}
		}
	}
	return pr
}

// reviewerName is a requested reviewer's login, or "org/team" for a team.
func reviewerName(r *requestedReviewerJSON) string {
	switch {
	case r == nil:
		return ""
	case r.Typename == "Team" && r.Organization != nil:
		return r.Organization.Login + "/" + r.Slug
	case r.Typename == "Team":
		return r.Slug
	default:
		return r.Login
	}
}

// checkBucket is the display bucket of one check state.
type checkBucket int

const (
	bucketFailed checkBucket = iota
	bucketPending
	bucketPassed
	bucketSkipped
)

// bucketOf buckets a CheckRunState / CheckConclusionState / StatusState value. It
// follows `gh pr checks`: SUCCESS passes; SKIPPED, NEUTRAL, and STALE are skipped;
// failure-like conclusions fail; anything else (queued, in progress, waiting,
// pending, expected, unknown) is pending.
func bucketOf(state string) checkBucket {
	switch state {
	case "SUCCESS":
		return bucketPassed
	case "SKIPPED", "NEUTRAL", "STALE":
		return bucketSkipped
	case "FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE":
		return bucketFailed
	default:
		return bucketPending
	}
}

// mapRollup counts a rollup's contexts by bucket from the *CountsByState aggregates,
// which cover the whole connection regardless of pagination.
func mapRollup(r *rollupJSON) CheckRollup {
	out := CheckRollup{State: RollupState(r.State)}
	add := func(counts []stateCountJSON) {
		for _, c := range counts {
			out.Total += c.Count
			switch bucketOf(c.State) {
			case bucketPassed:
				out.Passed += c.Count
			case bucketFailed:
				out.Failed += c.Count
			case bucketSkipped:
				out.Skipped += c.Count
			default:
				out.Pending += c.Count
			}
		}
	}
	add(r.Contexts.CheckRunCountsByState)
	add(r.Contexts.StatusContextCountsByState)
	return out
}

// mapContext maps a CheckRun or StatusContext node. Commit statuses are folded onto
// the check-run shape: PENDING/EXPECTED become status PENDING with no conclusion;
// SUCCESS becomes COMPLETED/SUCCESS; FAILURE and ERROR become COMPLETED/FAILURE.
func mapContext(n *contextNodeJSON) (CheckRun, bool) {
	switch n.Typename {
	case "CheckRun":
		run := CheckRun{
			Name:        n.Name,
			Status:      CheckStatus(n.Status),
			Conclusion:  CheckConclusion(n.Conclusion),
			URL:         n.DetailsURL,
			StartedAt:   n.StartedAt,
			CompletedAt: n.CompletedAt,
		}
		if n.CheckSuite != nil && n.CheckSuite.WorkflowRun != nil {
			run.Workflow = n.CheckSuite.WorkflowRun.Workflow.Name
		}
		return run, true
	case "StatusContext":
		run := CheckRun{
			Name:        n.Context,
			URL:         n.TargetURL,
			Description: n.Description,
			StartedAt:   n.CreatedAt,
		}
		switch n.State {
		case "SUCCESS":
			run.Status, run.Conclusion = StatusCompleted, ConclusionSuccess
		case "FAILURE", "ERROR":
			run.Status, run.Conclusion = StatusCompleted, ConclusionFailure
		default:
			run.Status = StatusPending
		}
		return run, true
	default:
		return CheckRun{}, false
	}
}

// runBucket buckets a mapped CheckRun.
func runBucket(r CheckRun) checkBucket {
	if r.Status != StatusCompleted {
		return bucketPending
	}
	return bucketOf(string(r.Conclusion))
}

// sortRuns orders checks for display: failed, pending, passed, skipped; then by
// workflow and name. The sort is stable so equal keys keep GitHub's order.
func sortRuns(runs []CheckRun) {
	sort.SliceStable(runs, func(i, j int) bool {
		bi, bj := runBucket(runs[i]), runBucket(runs[j])
		if bi != bj {
			return bi < bj
		}
		if runs[i].Workflow != runs[j].Workflow {
			return runs[i].Workflow < runs[j].Workflow
		}
		return runs[i].Name < runs[j].Name
	})
}
