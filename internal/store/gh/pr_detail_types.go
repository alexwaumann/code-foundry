package gh

import (
	"errors"
	"time"
)

// The pull request detail panel (GetPullRequestDetail), the reviewer picker
// (ListReviewerCandidates, SetReviewRequest), and revert. See docs/notes/gh-pr-detail.md.

// ErrFailedPrecondition means GitHub (or the store) refuses the operation in the pull
// request's current state: reverting one that is not merged, requesting a review from
// someone who cannot review (HTTP 422).
var ErrFailedPrecondition = errors.New("failed precondition")

// FullPullRequest is everything the detail panel shows about one pull request. Fetched
// on demand with one GraphQL request (pull_request_full.graphql) and cached per pull
// request.
type FullPullRequest struct {
	// PullRequest is the summary, as GetPullRequest returns it (ID is the node id).
	PullRequest PullRequest `json:"pullRequest"`
	Body        string      `json:"body,omitempty"`
	Labels      []Label     `json:"labels,omitempty"`
	// Reviewers: one per login, requested first, then most recent review first.
	Reviewers []Reviewer `json:"reviewers,omitempty"`
	// Commits are the last 100, oldest first; CommitCount counts all of them.
	Commits     []Commit `json:"commits,omitempty"`
	CommitCount int      `json:"commitCount,omitempty"`
	// Comments are issue comments and submitted reviews (the last 100 of each), oldest
	// first. Inline review comments are in Threads.
	Comments          []Comment      `json:"comments,omitempty"`
	CommentsTruncated bool           `json:"commentsTruncated,omitempty"`
	Threads           []ReviewThread `json:"threads,omitempty"`
	ThreadsTruncated  bool           `json:"threadsTruncated,omitempty"`
	// Checks are every check on the head commit, failed first.
	Checks         []CheckRun `json:"checks,omitempty"`
	MergeCommitSHA string     `json:"mergeCommitSha,omitempty"`
	MergedBy       string     `json:"mergedBy,omitempty"`
	ClosedAt       time.Time  `json:"closedAt,omitzero"`
	// ViewerPermission is GitHub's RepositoryPermission (ADMIN, MAINTAIN, WRITE, TRIAGE,
	// READ); empty if unknown.
	ViewerPermission string    `json:"viewerPermission,omitempty"`
	FetchedAt        time.Time `json:"fetchedAt"`
	// LastError is set when a refresh failed and this is the cached copy.
	LastError string `json:"-"`
}

// ViewerCanUpdate reports write access: the viewer may request reviewers and revert.
func (f *FullPullRequest) ViewerCanUpdate() bool {
	switch f.ViewerPermission {
	case "ADMIN", "MAINTAIN", "WRITE":
		return true
	}
	return false
}

// Label is a pull request label.
type Label struct {
	Name string `json:"name"`
	// Color is hex without "#".
	Color string `json:"color,omitempty"`
}

// Reviewer is one reviewer's latest review and whether a review is requested from them.
type Reviewer struct {
	// Login is a user login, or "org/team" for a team.
	Login     string `json:"login"`
	Team      bool   `json:"team,omitempty"`
	Bot       bool   `json:"bot,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	// State is the latest submitted review's state (APPROVED, CHANGES_REQUESTED,
	// COMMENTED, DISMISSED); empty when only requested.
	State       string    `json:"state,omitempty"`
	SubmittedAt time.Time `json:"submittedAt,omitzero"`
	// Requested: a review request is pending (after a review too: re-requested).
	Requested bool `json:"requested,omitempty"`
	// Stale: the latest review was of an older head commit.
	Stale bool `json:"stale,omitempty"`
}

// Commit is one commit of a pull request.
type Commit struct {
	SHA         string    `json:"sha"`
	Headline    string    `json:"headline"`
	AuthorLogin string    `json:"authorLogin,omitempty"`
	AuthorName  string    `json:"authorName,omitempty"`
	CommittedAt time.Time `json:"committedAt,omitzero"`
}

// CommentKind says what a Comment is.
type CommentKind string

// Comment kinds.
const (
	CommentIssue  CommentKind = "ISSUE_COMMENT"
	CommentReview CommentKind = "REVIEW"
	// CommentReviewComment is an inline comment in a review thread.
	CommentReviewComment CommentKind = "REVIEW_COMMENT"
)

// Comment is an issue comment, a submitted review, or an inline review comment.
type Comment struct {
	ID           string      `json:"id"`
	Kind         CommentKind `json:"kind"`
	Author       string      `json:"author,omitempty"`
	AuthorBot    bool        `json:"authorBot,omitempty"`
	AuthorAvatar string      `json:"authorAvatar,omitempty"`
	Body         string      `json:"body,omitempty"`
	CreatedAt    time.Time   `json:"createdAt,omitzero"`
	URL          string      `json:"url,omitempty"`
	// Path is the file of an inline review comment.
	Path string `json:"path,omitempty"`
	// ReviewState is a review's state (APPROVED, CHANGES_REQUESTED, COMMENTED,
	// DISMISSED).
	ReviewState string `json:"reviewState,omitempty"`
}

// ReviewThread is an inline review conversation on one diff line.
type ReviewThread struct {
	ID   string `json:"id"`
	Path string `json:"path"`
	// Line is the line in the current diff or, when outdated, the original line.
	Line int `json:"line,omitempty"`
	// Side is GitHub's DiffSide: LEFT (base) or RIGHT (head).
	Side     string `json:"side,omitempty"`
	Resolved bool   `json:"resolved,omitempty"`
	Outdated bool   `json:"outdated,omitempty"`
	// Comments are the first 20, oldest first.
	Comments          []Comment `json:"comments"`
	CommentsTruncated bool      `json:"commentsTruncated,omitempty"`
}

// ReviewerKind is a review request's target type.
type ReviewerKind string

// Reviewer kinds.
const (
	ReviewerUser ReviewerKind = "USER"
	ReviewerTeam ReviewerKind = "TEAM"
)

// ReviewerCandidate is someone the reviewer picker offers.
type ReviewerCandidate struct {
	// ID is GitHub's node id.
	ID   string       `json:"id"`
	Kind ReviewerKind `json:"kind"`
	// Login is a user login, or "org/team" for a team.
	Login     string `json:"login"`
	Name      string `json:"name,omitempty"`
	AvatarURL string `json:"avatarUrl,omitempty"`
	Requested bool   `json:"requested,omitempty"`
}

// ReviewerCandidates is the picker's list: requested first, then by login, without the
// pull request's author.
type ReviewerCandidates struct {
	Candidates []ReviewerCandidate
	// Truncated: the repository has more assignable users than were listed (100).
	Truncated bool
}

// ReviewRequest asks for (or withdraws) a review.
type ReviewRequest struct {
	// Login is a user login, or a team as "org/team" or its slug.
	Login     string
	Kind      ReviewerKind
	Requested bool
}

// RevertResult is the pull request RevertPullRequest opened.
type RevertResult struct {
	Number int
	URL    string
}

// PullRequestDetailUpdated is published when a cached FullPullRequest changed or went
// stale (a poll saw the pull request change, a review request was set, it was
// reverted). Clients re-read with GetPullRequestDetail.
type PullRequestDetailUpdated struct {
	Slug   string
	Number int
}
