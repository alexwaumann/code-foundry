// Package gh is the GitHub store: the authenticated viewer, the viewer's pull requests
// (authored, review requested, reviewed, recently merged), the default-branch CI of
// tracked repositories, the viewer's pull requests on watched branches, monthly stats,
// and on-demand pull request and ref check details.
//
// All GitHub access goes through a Runner: HTTPRunner calls api.github.com (GraphQL and
// REST) over one keep-alive HTTP client with the token `gh auth token` prints, so the
// user's gh login is the only credential. A single worker goroutine owns the network: one
// request in flight at a time, at least MinGap between requests, exponential backoff with
// jitter on errors, and a global pause when GitHub's rate limit runs low.
//
// Polling is viewer-scoped and change-driven (poll.go): every PollInterval one GraphQL
// request fetches a cheap fingerprint of everything (the viewer's PR lists, each PR's
// updatedAt, head and check counts, each tracked default branch's head and check counts,
// watched branches, and the monthly stats when due). Details are fetched only for pull
// requests whose fingerprint changed, and failing-check lists only for default branches
// whose failure count or head changed. See docs/notes/gh-viewer-polling.md.
//
// Results are cached in SQLite (Migrate creates the gh_* tables), so reads are served
// from the last-known state immediately on daemon start. Readers get an immutable
// Snapshot; changes are announced on the bus only when the data changed (ViewerUpdated,
// DashboardUpdated, RepoActivityUpdated, BranchPullRequestsUpdated), plus a small Polled
// event after every poll for freshness displays.
package gh

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Service is the GitHub store as seen by API handlers. *Store implements it; ghtest
// provides a fake.
type Service interface {
	// Snapshot returns the current immutable state. Never nil.
	Snapshot() *Snapshot
	// Track adds a repository ("owner/name") to the poll: its default branch CI is
	// watched and the dashboards count its pull requests as tracked.
	Track(slug string) error
	// Untrack removes a repository from the poll. Its cache is kept.
	Untrack(slug string) error
	// Refresh polls now. With a slug it waits for that poll to finish and returns its
	// error; an empty slug only marks the poll due and returns immediately.
	Refresh(ctx context.Context, slug string) error
	// PullRequest returns one pull request with its head commit's checks.
	PullRequest(ctx context.Context, slug string, number int) (PullRequestDetail, error)
	// Checks returns the checks on the commit a ref resolves to.
	Checks(ctx context.Context, slug, ref string) (RefChecks, error)
	// BranchPullRequests returns the viewer's cached pull requests whose head is
	// branch head of the repository, and keeps that branch in the poll for a while
	// (activity.go). It never waits on GitHub.
	BranchPullRequests(ctx context.Context, slug, head string) (BranchPullRequests, error)
	// FullPullRequest returns everything the detail panel shows about one pull request,
	// from cache unless refresh is set or the entry is stale (pr_detail.go). On fetch
	// failure the cached copy comes back with LastError set.
	FullPullRequest(ctx context.Context, slug string, number int, refresh bool) (FullPullRequest, error)
	// ReviewerCandidates returns who can be asked to review a pull request.
	ReviewerCandidates(ctx context.Context, slug string, number int) (ReviewerCandidates, error)
	// SetReviewRequest requests or withdraws a review and returns the pending requests
	// afterwards (logins and "org/team").
	SetReviewRequest(ctx context.Context, slug string, number int, r ReviewRequest) ([]string, error)
	// RevertPullRequest opens a pull request reverting a merged one
	// (ErrFailedPrecondition when it is not merged).
	RevertPullRequest(ctx context.Context, slug string, number int) (RevertResult, error)
	// MergePullRequest merges an open pull request, guarded by the cached head commit
	// (ErrFailedPrecondition when it is not open, a draft, its head moved, or GitHub
	// refuses), and optionally deletes its head branch.
	MergePullRequest(ctx context.Context, slug string, number int, r MergeRequest) (MergeResult, error)
}

// Errors returned by the store and the runner. Match with errors.Is.
var (
	// ErrNotAuthenticated means gh has no valid credentials (`gh auth login` needed).
	ErrNotAuthenticated = errors.New("gh is not authenticated (run `gh auth login`)")
	// ErrRateLimited means GitHub's primary or secondary rate limit was hit, or the
	// store is pausing because the remaining budget is low.
	ErrRateLimited = errors.New("github rate limit")
	// ErrNotFound means the repository, pull request, or ref does not exist (or is not
	// visible to the viewer).
	ErrNotFound = errors.New("not found on github")
	// ErrNetwork means gh could not reach GitHub.
	ErrNetwork = errors.New("cannot reach github")
	// ErrServerTimeout means GitHub gave up on the query (HTTP 502/504), which happens
	// when a GraphQL query needs more than ~10s of server time.
	ErrServerTimeout = errors.New("github timed out computing the query")
	// ErrInvalidSlug means a repository slug is not "owner/name".
	ErrInvalidSlug = errors.New(`invalid repository slug (want "owner/name")`)
	// ErrInvalidArgument covers other malformed arguments (PR number, ref).
	ErrInvalidArgument = errors.New("invalid argument")
	// ErrPermissionDenied means GitHub refused the request for lack of access: GraphQL
	// FORBIDDEN, or an HTTP 403 that is not a rate limit (missing scope, SSO, no write
	// access to the repository).
	ErrPermissionDenied = errors.New("permission denied on github")
)

// slugRE matches GitHub owner/name pairs. Owners are alphanumerics and hyphens;
// repository names also allow '.' and '_'.
var slugRE = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,38})/[a-z0-9._-]{1,100}$`)

// NormalizeSlug lower-cases and validates "owner/name". GitHub slugs are
// case-insensitive, so the lower-cased form is the cache and snapshot key.
func NormalizeSlug(slug string) (string, error) {
	s := strings.ToLower(strings.TrimSpace(slug))
	if !slugRE.MatchString(s) || strings.HasSuffix(s, "/.") || strings.HasSuffix(s, "/..") {
		return "", fmt.Errorf("%w: %q", ErrInvalidSlug, slug)
	}
	return s, nil
}

func splitSlug(slug string) (owner, name string) {
	owner, name, _ = strings.Cut(slug, "/")
	return owner, name
}

// ReviewDecision is GitHub's PullRequestReviewDecision; empty when none applies.
type ReviewDecision string

// Review decisions.
const (
	ReviewApproved         ReviewDecision = "APPROVED"
	ReviewChangesRequested ReviewDecision = "CHANGES_REQUESTED"
	ReviewRequired         ReviewDecision = "REVIEW_REQUIRED"
)

// Mergeable is GitHub's MergeableState.
type Mergeable string

// Mergeable states.
const (
	MergeableMergeable   Mergeable = "MERGEABLE"
	MergeableConflicting Mergeable = "CONFLICTING"
	MergeableUnknown     Mergeable = "UNKNOWN"
)

// MergeStateStatus is GitHub's MergeStateStatus (BEHIND, BLOCKED, CLEAN, DIRTY,
// HAS_HOOKS, UNKNOWN, UNSTABLE, DRAFT). Kept as GitHub's string.
type MergeStateStatus string

// RollupState is GitHub's StatusState for a commit's check rollup; empty when the
// commit has no checks.
type RollupState string

// Rollup states.
const (
	RollupPending  RollupState = "PENDING"
	RollupSuccess  RollupState = "SUCCESS"
	RollupFailure  RollupState = "FAILURE"
	RollupError    RollupState = "ERROR"
	RollupExpected RollupState = "EXPECTED"
)

// CheckStatus is GitHub's CheckStatusState (QUEUED, IN_PROGRESS, COMPLETED, WAITING,
// PENDING, REQUESTED).
type CheckStatus string

// Check statuses used by the mapping code.
const (
	StatusQueued     CheckStatus = "QUEUED"
	StatusInProgress CheckStatus = "IN_PROGRESS"
	StatusCompleted  CheckStatus = "COMPLETED"
	StatusPending    CheckStatus = "PENDING"
)

// CheckConclusion is GitHub's CheckConclusionState; empty until completed.
type CheckConclusion string

// Check conclusions used by the mapping code.
const (
	ConclusionSuccess CheckConclusion = "SUCCESS"
	ConclusionFailure CheckConclusion = "FAILURE"
)

// Viewer is the authenticated GitHub user.
type Viewer struct {
	// ID is the GraphQL node id (filters commit history by author). Empty in caches
	// written before Phase 3a; the next viewer poll fills it.
	ID        string `json:"id,omitempty"`
	Login     string `json:"login"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	URL       string `json:"url,omitempty"`
}

// CheckRollup buckets a commit's checks for display.
type CheckRollup struct {
	State   RollupState `json:"state,omitempty"`
	Total   int         `json:"total"`
	Passed  int         `json:"passed"`
	Failed  int         `json:"failed"`
	Pending int         `json:"pending"`
	Skipped int         `json:"skipped"`
}

// PullRequest is one pull request in the viewer's scope with its head commit's check
// rollup. Polled pull requests carry every field; GetPullRequest fills the same set.
type PullRequest struct {
	// ID is GitHub's node id (the poll's key).
	ID                string           `json:"id,omitempty"`
	Number            int              `json:"number"`
	Title             string           `json:"title"`
	Author            string           `json:"author,omitempty"`
	HeadRef           string           `json:"headRef"`
	HeadSHA           string           `json:"headSha"`
	BaseRef           string           `json:"baseRef"`
	Draft             bool             `json:"draft,omitempty"`
	ReviewDecision    ReviewDecision   `json:"reviewDecision,omitempty"`
	Mergeable         Mergeable        `json:"mergeable,omitempty"`
	MergeStateStatus  MergeStateStatus `json:"mergeStateStatus,omitempty"`
	IsCrossRepository bool             `json:"isCrossRepository,omitempty"`
	HeadRepoSlug      string           `json:"headRepoSlug,omitempty"`
	URL               string           `json:"url"`
	UpdatedAt         time.Time        `json:"updatedAt"`
	Checks            CheckRollup      `json:"checks"`
	// Repo is the "owner/name" (lower case) of the pull request's repository.
	Repo      string           `json:"repo,omitempty"`
	State     PullRequestState `json:"state,omitempty"`
	CreatedAt time.Time        `json:"createdAt,omitzero"`
	MergedAt  time.Time        `json:"mergedAt,omitzero"`
	// Size of the change.
	Additions    int `json:"additions,omitempty"`
	Deletions    int `json:"deletions,omitempty"`
	ChangedFiles int `json:"changedFiles,omitempty"`
	// Comments counts issue and review comments; Reviews counts submitted reviews.
	// Open pull requests only (closed and merged ones are fetched with the summary).
	Comments int `json:"comments,omitempty"`
	Reviews  int `json:"reviews,omitempty"`
	// LatestReviews is each reviewer's latest review (up to 10).
	LatestReviews []Review `json:"latestReviews,omitempty"`
	// ReviewRequests are the pending review requests: user logins and "org/team" slugs.
	ReviewRequests []string `json:"reviewRequests,omitempty"`
	// Partial is set while only the poll's fingerprint is known (the detail fetch is
	// pending or failed): Title and the detail fields are empty.
	Partial bool `json:"partial,omitempty"`
}

// Review is one reviewer's latest review.
type Review struct {
	Author      string    `json:"author,omitempty"`
	State       string    `json:"state"` // APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED, PENDING
	SubmittedAt time.Time `json:"submittedAt,omitzero"`
}

// CheckRun is one check on a commit: a check run (GitHub Actions job, app check) or a
// legacy commit status context mapped onto the same shape.
type CheckRun struct {
	Name        string          `json:"name"`
	Workflow    string          `json:"workflow,omitempty"`
	Status      CheckStatus     `json:"status"`
	Conclusion  CheckConclusion `json:"conclusion,omitempty"`
	URL         string          `json:"url,omitempty"`
	Description string          `json:"description,omitempty"`
	StartedAt   time.Time       `json:"startedAt,omitzero"`
	CompletedAt time.Time       `json:"completedAt,omitzero"`
}

// ViewerState is the viewer plus fetch status.
type ViewerState struct {
	// Viewer is nil until the first successful fetch or cache load.
	Viewer *Viewer
	// Authenticated is false once there was no token or GitHub rejected it, and true
	// again after a successful request or auth check (Runner.AuthStatus).
	Authenticated bool
	FetchedAt     time.Time
	LastError     string
}

// RepoState is one repository's activity: the viewer's monthly stats there and its
// default branch CI, each with its own fetch time and error.
type RepoState struct {
	Slug     string
	Tracked  bool
	Activity RepoActivity
}

// PollState is the outcome of the last poll.
type PollState struct {
	// FetchedAt is when the last successful poll finished.
	FetchedAt time.Time
	// LastError is the last poll's error; empty after a success.
	LastError string
}

// PullRequestDetail is one pull request with every check on its head commit.
type PullRequestDetail struct {
	PullRequest PullRequest `json:"pullRequest"`
	Checks      []CheckRun  `json:"checks"`
	FetchedAt   time.Time   `json:"fetchedAt"`
	// LastError is set when a refresh failed and this is the stale cached copy.
	LastError string `json:"-"`
}

// RefChecks is the checks on the commit a ref resolved to.
type RefChecks struct {
	SHA       string      `json:"sha"`
	Rollup    CheckRollup `json:"rollup"`
	Runs      []CheckRun  `json:"runs"`
	FetchedAt time.Time   `json:"fetchedAt"`
	LastError string      `json:"-"`
}

// Snapshot is the store's immutable published state. Never mutate it.
type Snapshot struct {
	Viewer ViewerState
	// Repos holds tracked repositories and any cached untracked ones, keyed by
	// normalized slug.
	Repos map[string]RepoState
	// Dashboard is the viewer's pull request dashboards and global monthly stats
	// (activity.go), unfiltered: readers keep the tracked repositories they want.
	Dashboard Dashboard
	Poll      PollState
}

// Repo returns the state for slug (any case). ok is false for an unknown or invalid slug.
func (s *Snapshot) Repo(slug string) (RepoState, bool) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return RepoState{}, false
	}
	r, ok := s.Repos[key]
	return r, ok
}

func (s *Snapshot) clone() *Snapshot {
	n := &Snapshot{Viewer: s.Viewer, Dashboard: s.Dashboard, Poll: s.Poll, Repos: make(map[string]RepoState, len(s.Repos)+1)}
	for k, v := range s.Repos {
		n.Repos[k] = v
	}
	return n
}

// Polled is published after every poll, successful or not. It is how clients keep an
// "updated Ns ago" display current without re-reading anything: the data events are
// published only when data changed.
type Polled struct {
	// FetchedAt is when the last successful poll finished (it may be older than this
	// poll when this one failed).
	FetchedAt time.Time
	LastError string
}

// ViewerUpdated is published on the bus when the viewer or authentication state changes.
type ViewerUpdated struct {
	FetchedAt time.Time
}
