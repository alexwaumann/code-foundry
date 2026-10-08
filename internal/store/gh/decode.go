package gh

import (
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

type pullRequestJSON struct {
	Number            int       `json:"number"`
	Title             string    `json:"title"`
	URL               string    `json:"url"`
	UpdatedAt         time.Time `json:"updatedAt"`
	IsDraft           bool      `json:"isDraft"`
	IsCrossRepository bool      `json:"isCrossRepository"`
	Author            *struct {
		Login string `json:"login"`
	} `json:"author"`
	HeadRefName    string `json:"headRefName"`
	HeadRefOid     string `json:"headRefOid"`
	BaseRefName    string `json:"baseRefName"`
	HeadRepository *struct {
		NameWithOwner string `json:"nameWithOwner"`
	} `json:"headRepository"`
	ReviewDecision   string `json:"reviewDecision"`
	Mergeable        string `json:"mergeable"`
	MergeStateStatus string `json:"mergeStateStatus"`
	Commits          struct {
		Nodes []struct {
			Commit commitJSON `json:"commit"`
		} `json:"nodes"`
	} `json:"commits"`
}

func (p *pullRequestJSON) headCommit() *commitJSON {
	if n := len(p.Commits.Nodes); n > 0 {
		return &p.Commits.Nodes[n-1].Commit
	}
	return nil
}

type viewerData struct {
	RateLimit *rateLimitJSON `json:"rateLimit"`
	Viewer    *Viewer        `json:"viewer"`
}

type pullRequestsData struct {
	RateLimit  *rateLimitJSON `json:"rateLimit"`
	Repository *struct {
		PullRequests struct {
			TotalCount int               `json:"totalCount"`
			PageInfo   pageInfoJSON      `json:"pageInfo"`
			Nodes      []pullRequestJSON `json:"nodes"`
		} `json:"pullRequests"`
	} `json:"repository"`
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

// decodeViewer maps a Viewer query response.
func decodeViewer(data []byte) (Viewer, *rateLimitJSON, error) {
	var d viewerData
	if err := json.Unmarshal(data, &d); err != nil {
		return Viewer{}, nil, fmt.Errorf("decode viewer: %w", err)
	}
	if d.Viewer == nil || d.Viewer.Login == "" {
		return Viewer{}, d.RateLimit, fmt.Errorf("decode viewer: %w", ErrNotAuthenticated)
	}
	return *d.Viewer, d.RateLimit, nil
}

// prPage is one decoded page of open pull requests.
type prPage struct {
	PullRequests []PullRequest
	TotalCount   int
	Next         pageInfoJSON
}

// decodePullRequestsPage maps one PullRequests query page.
func decodePullRequestsPage(data []byte) (prPage, *rateLimitJSON, error) {
	var d pullRequestsData
	if err := json.Unmarshal(data, &d); err != nil {
		return prPage{}, nil, fmt.Errorf("decode pull requests: %w", err)
	}
	if d.Repository == nil {
		return prPage{}, d.RateLimit, fmt.Errorf("decode pull requests: repository: %w", ErrNotFound)
	}
	conn := d.Repository.PullRequests
	page := prPage{TotalCount: conn.TotalCount, Next: conn.PageInfo}
	page.PullRequests = make([]PullRequest, 0, len(conn.Nodes))
	for i := range conn.Nodes {
		page.PullRequests = append(page.PullRequests, mapPullRequest(&conn.Nodes[i]))
	}
	return page, d.RateLimit, nil
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
	pr := mapPullRequest(d.Repository.PullRequest)
	return pr, mapChecksPage(d.Repository.PullRequest.headCommit()), d.RateLimit, nil
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
	}
	if p.Author != nil {
		pr.Author = p.Author.Login
	}
	if p.HeadRepository != nil {
		pr.HeadRepoSlug = p.HeadRepository.NameWithOwner
	}
	if c := p.headCommit(); c != nil && c.StatusCheckRollup != nil {
		pr.Checks = mapRollup(c.StatusCheckRollup)
	}
	return pr
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
