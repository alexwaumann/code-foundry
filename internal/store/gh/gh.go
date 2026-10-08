// Package gh is the GitHub store: the authenticated viewer, open pull requests of
// tracked repositories with a check rollup each, and on-demand pull request and ref
// check details. Phase 3a adds the viewer's dashboards, monthly stats, default-branch
// CI, and per-branch pull requests (activity*.go).
//
// All GitHub access goes through the user's authenticated `gh` CLI (`gh api graphql`,
// `gh auth status`) via a Runner. A single worker goroutine owns the network: one
// request in flight at a time, at least MinGap between requests, per-repo polling every
// RepoInterval, exponential backoff with jitter on errors, and a global pause when
// GitHub's rate limit runs low. See docs/notes/phase1c-gh.md for the pacing rationale.
//
// Results are cached in SQLite (Migrate creates the gh_* tables), so reads are served
// from the last-known state immediately on daemon start. Readers get an immutable
// Snapshot; changes are announced on the bus as PullRequestsUpdated and ViewerUpdated.
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
	// Track adds a repository ("owner/name") to the polling loop.
	Track(slug string) error
	// Untrack removes a repository from the polling loop. Its cache is kept.
	Untrack(slug string) error
	// Refresh fetches a repository's pull requests now and waits for the result. An
	// empty slug marks everything due and returns immediately.
	Refresh(ctx context.Context, slug string) error
	// PullRequest returns one pull request with its head commit's checks.
	PullRequest(ctx context.Context, slug string, number int) (PullRequestDetail, error)
	// Checks returns the checks on the commit a ref resolves to.
	Checks(ctx context.Context, slug, ref string) (RefChecks, error)
	// BranchPullRequests returns the viewer's cached pull requests whose head is
	// branch head of the repository, and keeps that branch polled for a while
	// (activity.go). It never waits on GitHub.
	BranchPullRequests(ctx context.Context, slug, head string) (BranchPullRequests, error)
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

// PullRequest is one open pull request with its head commit's check rollup.
type PullRequest struct {
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
	// Repo is the "owner/name" (lower case) of search and branch results.
	// Set for pull requests found by search or head branch (see activity.go); the
	// open-PR list leaves them empty.
	Repo      string           `json:"repo,omitempty"`
	State     PullRequestState `json:"state,omitempty"`
	CreatedAt time.Time        `json:"createdAt,omitzero"`
	MergedAt  time.Time        `json:"mergedAt,omitzero"`
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
	// Authenticated is false once gh reported missing or bad credentials, and true
	// again after a successful request or `gh auth status` check.
	Authenticated bool
	FetchedAt     time.Time
	LastError     string
}

// RepoState is one repository's cached open pull requests plus fetch status.
type RepoState struct {
	Slug         string
	Tracked      bool
	PullRequests []PullRequest
	// TotalCount is the number of open PRs on GitHub (PullRequests may be capped).
	TotalCount int
	FetchedAt  time.Time
	LastError  string
	// Activity is the viewer's monthly stats here and the default branch's CI
	// (activity.go). Its fetch times and errors are its own.
	Activity RepoActivity
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
	n := &Snapshot{Viewer: s.Viewer, Dashboard: s.Dashboard, Repos: make(map[string]RepoState, len(s.Repos)+1)}
	for k, v := range s.Repos {
		n.Repos[k] = v
	}
	return n
}

// PullRequestsUpdated is published on the bus when a repository's pull requests or
// fetch status change (including every completed poll, so fetched_at stays current).
type PullRequestsUpdated struct {
	Slug      string
	FetchedAt time.Time
}

// ViewerUpdated is published on the bus when the viewer or authentication state changes.
type ViewerUpdated struct {
	FetchedAt time.Time
}
