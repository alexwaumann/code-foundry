package gh

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// The viewer's GitHub activity, for the Pull Requests page and the worktree overview:
// the dashboards (open pull requests the viewer authored, is asked to review, or has
// reviewed; pull requests merged recently involving them), monthly stats, default-branch
// CI of tracked repositories, and the viewer's pull requests on watched branches. All of
// it is fetched by the poll (poll.go); this file holds the types, the branch watch API,
// and month arithmetic.

// Activity defaults.
const (
	DefaultStatsInterval = 15 * time.Minute
	DefaultBranchWatch   = 10 * time.Minute

	recentlyMergedWindow = 7 * 24 * time.Hour
)

// PullRequestState is GitHub's PullRequestState.
type PullRequestState string

// Pull request states.
const (
	PullRequestOpen   PullRequestState = "OPEN"
	PullRequestClosed PullRequestState = "CLOSED"
	PullRequestMerged PullRequestState = "MERGED"
)

// Commit count sources (MonthlyStats.CommitsSource).
const (
	CommitsFromSearch        = "search"
	CommitsFromContributions = "contributions"
)

// MonthCount is one calendar month (in the daemon's local time zone) of the viewer's
// activity.
type MonthCount struct {
	// Month is "YYYY-MM".
	Month   string `json:"month"`
	Commits int    `json:"commits"`
	Merged  int    `json:"merged"`
}

// MonthlyStats is the viewer's activity this month and last.
type MonthlyStats struct {
	ThisMonth MonthCount `json:"thisMonth"`
	LastMonth MonthCount `json:"lastMonth"`
	// CommitsSource says where the commit counts came from: CommitsFromSearch or the
	// contributionsCollection fallback.
	CommitsSource string    `json:"commitsSource,omitempty"`
	FetchedAt     time.Time `json:"fetchedAt"`
	LastError     string    `json:"-"`
}

// Dashboard is the viewer's pull request dashboards across GitHub.
type Dashboard struct {
	// Open pull requests authored by the viewer, most recently updated first.
	Authored []PullRequest `json:"authored"`
	// Open pull requests requesting the viewer's review (directly or through a team).
	ReviewRequested []PullRequest `json:"reviewRequested"`
	// Open pull requests the viewer has reviewed and did not author, minus those in
	// ReviewRequested.
	Reviewed []PullRequest `json:"reviewed"`
	// Pull requests merged in the last 7 days that the viewer authored, reviewed, or is
	// assigned to.
	RecentlyMerged []PullRequest `json:"recentlyMerged"`
	// GitHub's match counts; the lists above are capped.
	AuthoredTotal        int `json:"authoredTotal"`
	ReviewRequestedTotal int `json:"reviewRequestedTotal"`
	ReviewedTotal        int `json:"reviewedTotal"`
	RecentlyMergedTotal  int `json:"recentlyMergedTotal"`
	// FetchedAt is when the lists were last confirmed by a poll (every successful poll
	// moves it, without an event; see Polled).
	FetchedAt time.Time `json:"fetchedAt"`
	LastError string    `json:"-"`
	// Disabled is set while github.dashboards_enabled is off: the lists are empty and
	// not polled.
	Disabled bool `json:"-"`
	// Stats are the global monthly stats (fetched on their own cadence).
	Stats MonthlyStats `json:"-"`
}

// BranchCI is the check state of a branch's head commit.
type BranchCI struct {
	Branch      string      `json:"branch"`
	SHA         string      `json:"sha"`
	Headline    string      `json:"headline,omitempty"`
	CommittedAt time.Time   `json:"committedAt,omitzero"`
	Rollup      CheckRollup `json:"rollup"`
	// Failing lists the failed checks (failure, error, cancelled, timed out, ...).
	Failing []CheckRun `json:"failing,omitempty"`
	// FetchedAt is when a poll last confirmed this state.
	FetchedAt time.Time `json:"fetchedAt"`
	LastError string    `json:"-"`
}

// RepoActivity is the viewer's activity in one repository plus its default branch CI.
type RepoActivity struct {
	Stats         MonthlyStats
	DefaultBranch BranchCI
}

// BranchPullRequests are the viewer's pull requests (any state) whose head is a branch
// of the repository itself (not a fork), most recently updated first.
type BranchPullRequests struct {
	Slug         string        `json:"slug"`
	HeadRef      string        `json:"headRef"`
	PullRequests []PullRequest `json:"pullRequests"`
	FetchedAt    time.Time     `json:"fetchedAt"`
	LastError    string        `json:"-"`
}

// DashboardUpdated is published when the dashboards, the global stats, their errors, or
// the tracked set (which filters them) changed.
type DashboardUpdated struct {
	FetchedAt time.Time
}

// RepoActivityUpdated is published when a repository's stats or default branch CI (or
// either's error, or whether it is tracked) changed.
type RepoActivityUpdated struct {
	Slug      string
	FetchedAt time.Time
}

// BranchPullRequestsUpdated is published when a watched branch's pull requests (or its
// error) changed, including its first poll.
type BranchPullRequestsUpdated struct {
	Slug      string
	HeadRef   string
	FetchedAt time.Time
}

type branchKey struct{ slug, head string }

// branchWatches are the branches clients asked about recently, guarded by Store.mu.
type branchWatches map[branchKey]time.Time // last BranchPullRequests call

// branchStates holds the per-branch results, read by BranchPullRequests (API
// goroutines) and written by the worker.
type branchStates struct {
	mu sync.Mutex
	m  map[branchKey]BranchPullRequests
}

func (b *branchStates) get(k branchKey) (BranchPullRequests, bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	st, ok := b.m[k]
	return st, ok
}

func (b *branchStates) set(k branchKey, st BranchPullRequests) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.m[k] = st
}

// setIfAbsent stores st unless the worker already did (a cache load racing a poll).
func (b *branchStates) setIfAbsent(k branchKey, st BranchPullRequests) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.m[k]; !ok {
		b.m[k] = st
	}
}

// searchLogin is what the viewer searches use for the viewer: @me, or Options.SearchAs.
func (s *Store) searchLogin() string {
	if s.opts.SearchAs != "" {
		return s.opts.SearchAs
	}
	return "@me"
}

// viewerLogin is the login whose pull requests and contributions count: SearchAs, or
// the viewer's; empty until known.
func (s *Store) viewerLogin() string {
	if s.opts.SearchAs != "" {
		return s.opts.SearchAs
	}
	if v := s.Snapshot().Viewer.Viewer; v != nil {
		return v.Login
	}
	return ""
}

// BranchPullRequests implements Service.
func (s *Store) BranchPullRequests(ctx context.Context, slug, head string) (BranchPullRequests, error) {
	key, err := NormalizeSlug(slug)
	if err != nil {
		return BranchPullRequests{}, err
	}
	head = strings.TrimSpace(head)
	if head == "" || len(head) > 255 {
		return BranchPullRequests{}, fmt.Errorf("%w: head branch %q", ErrInvalidArgument, head)
	}
	k := branchKey{key, head}
	st, ok := s.branches.get(k)
	if !ok {
		var err error
		st, ok, err = loadActivityRow[BranchPullRequests](ctx, s.cache, activityBranchKey(k))
		if err != nil {
			s.log.Warn("gh cache read failed", "err", err)
		}
		if ok {
			s.branches.setIfAbsent(k, st)
		}
	}
	now := s.opts.Now()
	s.mu.Lock()
	_, watched := s.watches[k]
	s.watches[k] = now
	// A branch nobody polled recently goes into the next poll, soon.
	if !watched && (!ok || now.Sub(st.FetchedAt) >= s.config().PollInterval) {
		s.pollSoonLocked(now)
	}
	s.mu.Unlock()
	s.nudge()
	st.Slug, st.HeadRef = key, head
	return st, nil
}

// keepViewerPullRequests keeps pull requests from the repository itself (a fork's
// branch of the same name is someone else's) authored by login (any case; empty keeps
// every author).
func keepViewerPullRequests(prs []PullRequest, login string) []PullRequest {
	out := make([]PullRequest, 0, len(prs))
	for _, p := range prs {
		if p.IsCrossRepository || (login != "" && !strings.EqualFold(p.Author, login)) {
			continue
		}
		out = append(out, p)
	}
	return out
}

// ---- months --------------------------------------------------------------------

// searchTimeLayout is an ISO 8601 timestamp with offset, which GitHub search date
// qualifiers accept (verified for merged: and author-date:).
const searchTimeLayout = "2006-01-02T15:04:05-07:00"

// monthWindow is one calendar month in now's location: [Start, End] with End one
// second before the next month starts (search ranges are inclusive).
type monthWindow struct {
	Start, End time.Time
	Label      string // YYYY-MM
}

func (w monthWindow) searchRange() string {
	return w.Start.Format(searchTimeLayout) + ".." + w.End.Format(searchTimeLayout)
}

// contains reports whether t falls in the month.
func (w monthWindow) contains(t time.Time) bool {
	return !t.Before(w.Start) && !t.After(w.End)
}

// monthWindows returns the month containing now and the one before, in now's location.
func monthWindows(now time.Time) (this, last monthWindow) {
	mk := func(start time.Time) monthWindow {
		return monthWindow{Start: start, End: start.AddDate(0, 1, 0).Add(-time.Second), Label: start.Format("2006-01")}
	}
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	return mk(start), mk(start.AddDate(0, -1, 0))
}
