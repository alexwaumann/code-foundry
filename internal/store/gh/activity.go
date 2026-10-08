package gh

import (
	"cmp"
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Phase 3a: the viewer's GitHub activity, for the Pull Requests page and the worktree
// overview. Everything here runs on the store's one worker (Store.Run) through call, so
// it shares the pacing, rate-limit pauses, and auth handling of the PR polls.
//
//   - Dashboard (every DashboardInterval while any repo is tracked): three searches,
//     one request each: open PRs authored by the viewer, open PRs requesting the
//     viewer's review (directly or through a team), and PRs merged in the last 7 days
//     that the viewer authored, reviewed, or is assigned to. Unfiltered; the API keeps
//     the tracked repositories.
//   - Global monthly stats (every StatsInterval): merged PRs authored by the viewer
//     this month and last (search counts) and commits (REST search/commits, falling
//     back to contributionsCollection).
//   - Per-repository monthly stats (every StatsInterval per tracked repo): commits on
//     the default branch by the viewer (history by author id) and merged PRs.
//   - Default-branch CI: page one of every PR poll also selects the default branch's
//     head commit checks (poll.go); failing checks beyond the first 100 contexts are
//     paged with checks.graphql.
//   - Branch pull requests: polled every RepoInterval for each (repo, branch) a client
//     asked about within BranchWatch.
//
// See docs/notes/phase3a-prs-overview.md for the measured cost of each query.

// Activity defaults.
const (
	DefaultDashboardInterval = 2 * time.Minute
	DefaultStatsInterval     = 15 * time.Minute
	DefaultBranchWatch       = 10 * time.Minute

	// Search page sizes. The open lists select reviewDecision and check counts, which
	// cost ~100ms of server time per PR (measured: 50 review requests took 6.0s of
	// GitHub's 10s budget), so review requests get 30. A 502 halves a section's size.
	dashboardAuthoredFirst = 50
	dashboardReviewFirst   = 30
	dashboardMergedFirst   = 50
	minSearchFirst         = 10
	branchPullRequestsMax  = 10

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
	// Open pull requests requesting the viewer's review.
	ReviewRequested []PullRequest `json:"reviewRequested"`
	// Pull requests merged in the last 7 days that the viewer authored, reviewed, or is
	// assigned to.
	RecentlyMerged []PullRequest `json:"recentlyMerged"`
	// GitHub's match counts; the lists above are capped.
	AuthoredTotal        int       `json:"authoredTotal"`
	ReviewRequestedTotal int       `json:"reviewRequestedTotal"`
	RecentlyMergedTotal  int       `json:"recentlyMergedTotal"`
	FetchedAt            time.Time `json:"fetchedAt"`
	LastError            string    `json:"-"`
	// Stats are the global monthly stats (fetched and cached on their own schedule).
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
	Failing   []CheckRun `json:"failing,omitempty"`
	FetchedAt time.Time  `json:"fetchedAt"`
	LastError string     `json:"-"`
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

// DashboardUpdated is published when the dashboards or the global stats were fetched
// (every successful poll) or their error changed.
type DashboardUpdated struct {
	FetchedAt time.Time
}

// RepoActivityUpdated is published when a repository's stats were fetched, its default
// branch CI changed, or either's error changed.
type RepoActivityUpdated struct {
	Slug      string
	FetchedAt time.Time
}

// BranchPullRequestsUpdated is published after every poll of a watched branch.
type BranchPullRequestsUpdated struct {
	Slug      string
	HeadRef   string
	FetchedAt time.Time
}

type branchKey struct{ slug, head string }

type branchWatch struct {
	next      time.Time
	failures  int
	requested time.Time
}

// activity is the store's Phase 3a state. Scheduling fields are guarded by Store.mu;
// worker-only fields are touched only by the worker goroutine.
type activity struct {
	dashboardNext     time.Time
	dashboardFailures int
	statsNext         time.Time
	statsFailures     int
	repoStats         map[string]*schedule
	branches          map[branchKey]*branchWatch

	// Worker only.
	searchFirst map[string]int // per-section search size after 502 shrinking
	searchAsID  string         // node id of Options.SearchAs

	brMu         sync.Mutex
	branchStates map[branchKey]BranchPullRequests
}

// searchLogin is what the viewer searches use for the viewer: @me, or Options.SearchAs.
func (s *Store) searchLogin() string {
	if s.opts.SearchAs != "" {
		return s.opts.SearchAs
	}
	return "@me"
}

// statsLogin is the login whose contributions are counted; empty until known.
func (s *Store) statsLogin() string {
	if s.opts.SearchAs != "" {
		return s.opts.SearchAs
	}
	if v := s.Snapshot().Viewer.Viewer; v != nil {
		return v.Login
	}
	return ""
}

// nextActivityLocked returns the earliest due activity job, or nil. Called with s.mu
// held from next(), which compares it with the viewer and PR polls.
func (s *Store) nextActivityLocked(now time.Time) (*job, time.Time) {
	var (
		best   *job
		bestAt time.Time
	)
	consider := func(j *job, at time.Time) {
		if best == nil || at.Before(bestAt) {
			best, bestAt = j, at
		}
	}
	tracked := len(s.tracked) > 0
	if tracked && s.opts.DashboardInterval > 0 {
		consider(&job{kind: jobActivity, ref: "dashboard", run: s.pollDashboard}, s.act.dashboardNext)
	}
	if tracked && s.opts.StatsInterval > 0 && s.statsLogin() != "" {
		consider(&job{kind: jobActivity, ref: "stats", run: s.pollStats}, s.act.statsNext)
	}
	for slug := range s.act.repoStats {
		if _, ok := s.tracked[slug]; !ok {
			delete(s.act.repoStats, slug)
		}
	}
	if s.opts.StatsInterval > 0 && s.authorReady() {
		snap := s.Snapshot()
		for slug := range s.tracked {
			sc := s.act.repoStats[slug]
			if sc == nil {
				sc = &schedule{next: now}
				if f := snap.Repos[slug].Activity.Stats.FetchedAt; !f.IsZero() {
					sc.next = laterOf(now, f.Add(s.opts.StatsInterval))
				}
				s.act.repoStats[slug] = sc
			}
			consider(&job{kind: jobActivity, slug: slug, ref: "repo_stats",
				run: func(ctx context.Context) error { return s.pollRepoStats(ctx, slug) }}, sc.next)
		}
	}
	for k, w := range s.act.branches {
		if now.Sub(w.requested) > s.opts.BranchWatch {
			delete(s.act.branches, k)
			continue
		}
		consider(&job{kind: jobActivity, slug: k.slug, ref: "branch:" + k.head,
			run: func(ctx context.Context) error { return s.pollBranch(ctx, k) }}, w.next)
	}
	return best, bestAt
}

// authorReady reports whether per-repo stats can run: they filter history by the
// author's node id.
func (s *Store) authorReady() bool {
	if s.opts.SearchAs != "" {
		return true
	}
	v := s.Snapshot().Viewer.Viewer
	return v != nil && v.ID != ""
}

// reschedule records a job's outcome on its schedule: on success the next run is an
// interval away (jittered); on a global error (auth, rate limit, network) it stays due,
// held by the store-wide pause; otherwise it backs off.
func (s *Store) reschedule(next *time.Time, failures *int, interval time.Duration, err error) {
	now := s.opts.Now()
	switch {
	case err == nil:
		*failures = 0
		*next = now.Add(jitter(interval, s.opts.Rand()))
	case isGlobal(err):
	default:
		*failures++
		*next = now.Add(backoff(s.opts.RepoInterval, s.opts.MaxBackoff, *failures, s.opts.Rand()))
	}
}

// ---- dashboard -----------------------------------------------------------------

// dashboardSection is one dashboard search.
type dashboardSection struct {
	name   string
	query  string
	typ    string // SearchType
	first  int
	review bool
}

// dashboardSections builds the three searches for login (@me or a login) at now.
func dashboardSections(login string, now time.Time) []dashboardSection {
	since := now.Add(-recentlyMergedWindow).Format(searchTimeLayout)
	return []dashboardSection{
		{name: "authored", typ: "ISSUE", first: dashboardAuthoredFirst, review: true,
			query: fmt.Sprintf("is:pr is:open archived:false author:%s sort:updated-desc", login)},
		{name: "review", typ: "ISSUE", first: dashboardReviewFirst, review: true,
			query: fmt.Sprintf("is:pr is:open archived:false review-requested:%s sort:updated-desc", login)},
		// OR and parentheses need the advanced issue search.
		{name: "merged", typ: "ISSUE_ADVANCED", first: dashboardMergedFirst,
			query: fmt.Sprintf("is:pr is:merged merged:>=%s (author:%[2]s OR reviewed-by:%[2]s OR assignee:%[2]s) sort:updated-desc", since, login)},
	}
}

func (s *Store) pollDashboard(ctx context.Context) error {
	now := s.opts.Now()
	var results [3]searchResult
	for i, sec := range dashboardSections(s.searchLogin(), now) {
		first := cmp.Or(s.act.searchFirst[sec.name], sec.first)
		data, err := s.call(ctx, querySearchPullRequests, map[string]any{
			"q": sec.query, "type": sec.typ, "first": first, "withReview": sec.review,
		})
		var r searchResult
		if err == nil {
			r, err = decodeSearchPullRequests(data)
		}
		if err != nil {
			if isServerTimeout(err) && first > minSearchFirst {
				s.act.searchFirst[sec.name] = max(minSearchFirst, first/2)
				s.log.Info("gh search timed out; shrinking", "section", sec.name, "first", s.act.searchFirst[sec.name])
			}
			return s.dashboardFailed(ctx, fmt.Errorf("%s: %w", sec.name, err))
		}
		results[i] = r
	}
	d := Dashboard{
		Authored: results[0].PullRequests, AuthoredTotal: results[0].Total,
		ReviewRequested: results[1].PullRequests, ReviewRequestedTotal: results[1].Total,
		RecentlyMerged: results[2].PullRequests, RecentlyMergedTotal: results[2].Total,
		FetchedAt: s.opts.Now(),
	}
	s.mu.Lock()
	s.reschedule(&s.act.dashboardNext, &s.act.dashboardFailures, s.opts.DashboardInterval, nil)
	s.mu.Unlock()
	if err := s.cache.saveActivity(ctx, activityDashboard, d.FetchedAt, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	s.updateDashboard(func(cur *Dashboard) {
		stats := cur.Stats
		*cur = d
		cur.Stats = stats
	}, true)
	return nil
}

func (s *Store) dashboardFailed(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return err
	}
	s.mu.Lock()
	s.reschedule(&s.act.dashboardNext, &s.act.dashboardFailures, s.opts.DashboardInterval, err)
	s.mu.Unlock()
	s.log.Warn("gh dashboard poll failed", "err", err)
	s.updateDashboard(func(d *Dashboard) { d.LastError = err.Error() }, false)
	return err
}

// ---- global stats --------------------------------------------------------------

func (s *Store) pollStats(ctx context.Context) error {
	now := s.opts.Now()
	this, last := monthWindows(now)
	login, me := s.statsLogin(), s.searchLogin()
	merged := func(w monthWindow) string {
		return fmt.Sprintf("is:pr is:merged author:%s merged:%s", me, w.searchRange())
	}
	data, err := s.call(ctx, queryViewerStats, map[string]any{
		"login":      login,
		"mergedThis": merged(this), "mergedLast": merged(last),
		"thisStart": this.Start.Format(time.RFC3339), "thisEnd": this.End.Format(time.RFC3339),
		"lastStart": last.Start.Format(time.RFC3339), "lastEnd": last.End.Format(time.RFC3339),
	})
	var vs viewerStats
	if err == nil {
		vs, err = decodeViewerStats(data)
	}
	if err != nil {
		return s.statsFailed(ctx, err)
	}
	st := MonthlyStats{
		ThisMonth:     MonthCount{Month: this.Label, Merged: vs.MergedThis, Commits: vs.ContribThis},
		LastMonth:     MonthCount{Month: last.Label, Merged: vs.MergedLast, Commits: vs.ContribLast},
		CommitsSource: CommitsFromContributions,
	}
	// REST search/commits counts commits by author date in our time zone, which
	// contributionsCollection cannot (it buckets by UTC day). Prefer it when it works.
	if rr, ok := s.opts.Runner.(RESTRunner); ok {
		ct, err1 := s.searchCommits(ctx, rr, fmt.Sprintf("author:%s author-date:%s", me, this.searchRange()))
		var cl int
		var err2 error
		if err1 == nil {
			cl, err2 = s.searchCommits(ctx, rr, fmt.Sprintf("author:%s author-date:%s", me, last.searchRange()))
		}
		if err := cmp.Or(err1, err2); err != nil {
			if ctx.Err() != nil {
				return err
			}
			s.log.Warn("gh commit search failed; using contributions", "err", err)
		} else {
			st.ThisMonth.Commits, st.LastMonth.Commits, st.CommitsSource = ct, cl, CommitsFromSearch
		}
	}
	st.FetchedAt = s.opts.Now()
	s.mu.Lock()
	s.reschedule(&s.act.statsNext, &s.act.statsFailures, s.opts.StatsInterval, nil)
	s.mu.Unlock()
	if err := s.cache.saveActivity(ctx, activityStats, st.FetchedAt, st); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	s.updateDashboard(func(d *Dashboard) { d.Stats = st }, true)
	return nil
}

func (s *Store) statsFailed(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return err
	}
	s.mu.Lock()
	s.reschedule(&s.act.statsNext, &s.act.statsFailures, s.opts.StatsInterval, err)
	s.mu.Unlock()
	s.log.Warn("gh stats poll failed", "err", err)
	s.updateDashboard(func(d *Dashboard) { d.Stats.LastError = err.Error() }, false)
	return err
}

// searchCommits returns REST search/commits' total_count for q. REST search has its
// own rate limit (30/min), so a rate-limit error here does not pause GraphQL polling;
// only auth and network errors have global effects.
func (s *Store) searchCommits(ctx context.Context, rr RESTRunner, q string) (int, error) {
	if err := s.pace(ctx); err != nil {
		return 0, err
	}
	start := s.opts.Now()
	body, err := rr.REST(ctx, "search/commits", map[string]string{"q": q, "per_page": "1"})
	s.lastEnd = s.opts.Now()
	s.log.Debug("gh request", "rest", "search/commits", "q", q, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "err", err)
	if err != nil {
		if isAuthOrNetwork(err) {
			s.noteResult(ctx, err, nil)
		}
		return 0, err
	}
	return decodeSearchTotal(body)
}

// ---- per-repository stats ------------------------------------------------------

func (s *Store) pollRepoStats(ctx context.Context, slug string) error {
	author, err := s.authorID(ctx)
	if err != nil {
		return s.repoStatsFailed(ctx, slug, err)
	}
	now := s.opts.Now()
	this, last := monthWindows(now)
	owner, name := splitSlug(slug)
	me := s.searchLogin()
	merged := func(w monthWindow) string {
		return fmt.Sprintf("is:pr is:merged author:%s repo:%s merged:%s", me, slug, w.searchRange())
	}
	data, err := s.call(ctx, queryRepoStats, map[string]any{
		"owner": owner, "name": name, "author": author,
		"thisStart": this.Start.Format(time.RFC3339), "lastStart": last.Start.Format(time.RFC3339),
		"mergedThis": merged(this), "mergedLast": merged(last),
	})
	var rs repoStats
	if err == nil {
		rs, err = decodeRepoStats(data)
	}
	if err != nil {
		return s.repoStatsFailed(ctx, slug, err)
	}
	st := MonthlyStats{
		ThisMonth:     MonthCount{Month: this.Label, Commits: rs.CommitsThis, Merged: rs.MergedThis},
		LastMonth:     MonthCount{Month: last.Label, Commits: rs.CommitsLast, Merged: rs.MergedLast},
		CommitsSource: CommitsFromSearch,
		FetchedAt:     s.opts.Now(),
	}
	s.mu.Lock()
	if sc := s.act.repoStats[slug]; sc != nil {
		s.reschedule(&sc.next, &sc.failures, s.opts.StatsInterval, nil)
	}
	s.mu.Unlock()
	if err := s.cache.saveActivity(ctx, activityRepoStats+slug, st.FetchedAt, st); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	r := s.updateRepo(slug, func(r *RepoState) { r.Activity.Stats = st })
	s.publishActivity(r)
	return nil
}

func (s *Store) repoStatsFailed(ctx context.Context, slug string, err error) error {
	if ctx.Err() != nil {
		return err
	}
	s.mu.Lock()
	if sc := s.act.repoStats[slug]; sc != nil {
		s.reschedule(&sc.next, &sc.failures, s.opts.StatsInterval, err)
	}
	s.mu.Unlock()
	s.log.Warn("gh repo stats poll failed", "slug", slug, "err", err)
	changed := false
	r := s.updateRepo(slug, func(r *RepoState) {
		changed = r.Activity.Stats.LastError != err.Error()
		r.Activity.Stats.LastError = err.Error()
	})
	if changed {
		s.publishActivity(r)
	}
	return err
}

// authorID is the node id commit history is filtered by: the viewer's, or SearchAs's
// (looked up once).
func (s *Store) authorID(ctx context.Context) (string, error) {
	if s.opts.SearchAs == "" {
		if v := s.Snapshot().Viewer.Viewer; v != nil && v.ID != "" {
			return v.ID, nil
		}
		return "", fmt.Errorf("viewer id not known yet")
	}
	if s.act.searchAsID != "" {
		return s.act.searchAsID, nil
	}
	data, err := s.call(ctx, queryUserID, map[string]any{"login": s.opts.SearchAs})
	if err != nil {
		return "", err
	}
	id, err := decodeUserID(data)
	if err != nil {
		return "", err
	}
	s.act.searchAsID = id
	return id, nil
}

// ---- default-branch CI ---------------------------------------------------------

// defaultBranchFetched records the default branch CI selected by a PR poll's first
// page, paging further check contexts when failures are not all on that page.
func (s *Store) defaultBranchFetched(ctx context.Context, slug string, raw *defaultBranchJSON) {
	ci, next := mapDefaultBranch(raw)
	owner, name := splitSlug(slug)
	for page := 1; page < s.opts.MaxPages && ci.Rollup.Failed > len(ci.Failing) && next.HasNextPage && next.EndCursor != ""; page++ {
		data, err := s.call(ctx, queryChecks, map[string]any{"owner": owner, "name": name, "ref": ci.SHA, "after": next.EndCursor})
		var p checksPage
		if err == nil {
			p, _, err = decodeChecks(data)
		}
		if err != nil {
			s.log.Warn("gh default branch checks page failed", "slug", slug, "err", err)
			break
		}
		ci.Failing = append(ci.Failing, failingRuns(p.Runs)...)
		next = p.Next
	}
	sortRuns(ci.Failing)
	ci.FetchedAt = s.opts.Now()
	if err := s.cache.saveActivity(ctx, activityDefaultBranch+slug, ci.FetchedAt, ci); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	changed := false
	r := s.updateRepo(slug, func(r *RepoState) {
		changed = !sameBranchCI(r.Activity.DefaultBranch, ci)
		r.Activity.DefaultBranch = ci
	})
	if changed {
		s.publishActivity(r)
	}
}

// sameBranchCI compares everything but FetchedAt.
func sameBranchCI(a, b BranchCI) bool {
	if a.Branch != b.Branch || a.SHA != b.SHA || a.Headline != b.Headline || !a.CommittedAt.Equal(b.CommittedAt) ||
		a.Rollup != b.Rollup || a.LastError != b.LastError || len(a.Failing) != len(b.Failing) {
		return false
	}
	for i := range a.Failing {
		x, y := a.Failing[i], b.Failing[i]
		if x.Name != y.Name || x.Workflow != y.Workflow || x.URL != y.URL || x.Conclusion != y.Conclusion {
			return false
		}
	}
	return true
}

// ---- branch pull requests ------------------------------------------------------

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
	s.act.brMu.Lock()
	st, ok := s.act.branchStates[k]
	s.act.brMu.Unlock()
	if !ok {
		var err error
		st, ok, err = loadActivityRow[BranchPullRequests](ctx, s.cache, activityBranchKey(k))
		if err != nil {
			s.log.Warn("gh cache read failed", "err", err)
		}
		if ok {
			s.act.brMu.Lock()
			if _, raced := s.act.branchStates[k]; !raced {
				s.act.branchStates[k] = st
			}
			s.act.brMu.Unlock()
		}
	}
	now := s.opts.Now()
	s.mu.Lock()
	w := s.act.branches[k]
	if w == nil {
		w = &branchWatch{next: now}
		if ok && now.Sub(st.FetchedAt) < s.opts.RepoInterval {
			w.next = st.FetchedAt.Add(s.opts.RepoInterval)
		}
		s.act.branches[k] = w
	}
	w.requested = now
	s.mu.Unlock()
	s.nudge()
	st.Slug, st.HeadRef = key, head
	return st, nil
}

func (s *Store) pollBranch(ctx context.Context, k branchKey) error {
	owner, name := splitSlug(k.slug)
	data, err := s.call(ctx, queryBranchPullRequests, map[string]any{
		"owner": owner, "name": name, "head": k.head, "first": branchPullRequestsMax,
	})
	var prs []PullRequest
	if err == nil {
		prs, err = decodeBranchPullRequests(data)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	s.mu.Lock()
	if w := s.act.branches[k]; w != nil {
		s.reschedule(&w.next, &w.failures, s.opts.RepoInterval, err)
	}
	s.mu.Unlock()
	s.act.brMu.Lock()
	st := s.act.branchStates[k]
	st.Slug, st.HeadRef = k.slug, k.head
	if err != nil {
		st.LastError = err.Error()
	} else {
		st.PullRequests = keepViewerPullRequests(prs, s.branchLogin())
		st.FetchedAt, st.LastError = s.opts.Now(), ""
	}
	s.act.branchStates[k] = st
	s.act.brMu.Unlock()
	if err != nil {
		s.log.Warn("gh branch pull requests poll failed", "slug", k.slug, "head", k.head, "err", err)
	} else if err := s.cache.saveActivity(ctx, activityBranchKey(k), st.FetchedAt, st); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	publish(s, BranchPullRequestsUpdated{Slug: k.slug, HeadRef: k.head, FetchedAt: st.FetchedAt})
	return err
}

// branchLogin is the author kept in branch pull requests; empty (keep all) until the
// viewer is known.
func (s *Store) branchLogin() string {
	if s.opts.SearchAs != "" {
		return s.opts.SearchAs
	}
	if v := s.Snapshot().Viewer.Viewer; v != nil {
		return v.Login
	}
	return ""
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

// ---- snapshot and events -------------------------------------------------------

// updateDashboard applies fn to a copy of the dashboard and publishes a new snapshot.
// It announces DashboardUpdated when always is set or the error changed.
func (s *Store) updateDashboard(fn func(*Dashboard), always bool) {
	s.snapMu.Lock()
	n := s.snap.Load().clone()
	before := n.Dashboard.LastError + "\x00" + n.Dashboard.Stats.LastError
	fn(&n.Dashboard)
	after := n.Dashboard.LastError + "\x00" + n.Dashboard.Stats.LastError
	s.snap.Store(n)
	s.snapMu.Unlock()
	if always || before != after {
		publish(s, DashboardUpdated{FetchedAt: n.Dashboard.FetchedAt})
	}
}

func (s *Store) publishActivity(r RepoState) {
	publish(s, RepoActivityUpdated{Slug: r.Slug, FetchedAt: r.Activity.Stats.FetchedAt})
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

// monthWindows returns the month containing now and the one before, in now's location.
func monthWindows(now time.Time) (this, last monthWindow) {
	mk := func(start time.Time) monthWindow {
		return monthWindow{Start: start, End: start.AddDate(0, 1, 0).Add(-time.Second), Label: start.Format("2006-01")}
	}
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	return mk(start), mk(start.AddDate(0, -1, 0))
}
