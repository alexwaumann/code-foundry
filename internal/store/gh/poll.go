package gh

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
)

// Jobs run on the worker goroutine (Store.Run). Each request goes through call/callDoc,
// which paces it and applies global effects; the functions here apply per-job effects:
// snapshot, cache, schedule, and bus events.
//
// A poll is:
//
//  1. One fingerprint request (poll_query.go): the viewer, the dashboard searches, every
//     tracked repository's default branch head with check counts, the watched branches'
//     pull requests, and the monthly stats when due.
//  2. Detail requests only for pull requests whose fingerprint moved (new, updatedAt,
//     state, head, or check rollup state changed; mergeability still being computed).
//     Check count changes alone are applied from the fingerprint.
//  3. One request for the failing checks of default branches whose head or failure
//     count changed, only when they have failures.
//  4. Two REST commit searches when the stats are due.
//
// Then the snapshot is updated and events go out only for what changed, plus Polled.

// isGlobal reports errors handled by a store-wide pause rather than per-job backoff.
func isGlobal(err error) bool {
	return errors.Is(err, ErrNotAuthenticated) || errors.Is(err, ErrRateLimited) || errors.Is(err, ErrNetwork)
}

// mergeableRechecks is how many polls in a row refetch an open pull request whose
// mergeability GitHub is still computing (UNKNOWN): it computes lazily after a push and
// does not bump updatedAt when done.
const mergeableRechecks = 3

// cycleStats counts one poll's requests for the debug log.
type cycleStats struct {
	requests, cost, details int
}

// poll runs one poll. Its error is the fingerprint request's (the parts that follow log
// and record their own errors).
func (s *Store) poll(ctx context.Context) error {
	start := s.opts.Now()
	cfg := s.config()
	plan, idle := s.planPoll(cfg, start)
	s.cycle = cycleStats{}
	err := s.runPoll(ctx, cfg, &plan, idle)
	if ctx.Err() == nil {
		attrs := append([]any{"requests", s.cycle.requests, "cost", s.cycle.cost, "details", s.cycle.details,
			"dur", s.opts.Now().Sub(start).Round(time.Millisecond).String()}, plan.summary()...)
		if err != nil {
			attrs = append(attrs, "err", err)
		}
		s.log.Debug("gh poll", attrs...)
	}
	return err
}

func (s *Store) runPoll(ctx context.Context, cfg Config, plan *pollPlan, idle bool) error {
	doc, vars, err := plan.build()
	if err != nil {
		return s.pollFailed(ctx, cfg, err, false)
	}
	data, err := s.callDoc(ctx, queryPoll, doc, vars)
	var partial *PartialError
	if err != nil && !errors.As(err, &partial) {
		// GitHub gives up on queries that need >10s of server time. Retry soon with
		// smaller searches; the sizes stick.
		shrunk := isServerTimeout(err) && s.shrinkSearches(plan)
		return s.pollFailed(ctx, cfg, err, shrunk)
	}
	res, err := decodePoll(plan, data, partial)
	if err != nil {
		return s.pollFailed(ctx, cfg, err, false)
	}
	if partial != nil {
		if e := partial.Unplaced(); e != nil {
			s.log.Warn("gh poll partial errors", "err", e)
		}
	}
	s.applyPoll(ctx, cfg, plan, &res, idle)
	return nil
}

// planPoll decides what this poll asks for. idle is set when nothing is tracked or
// watched (only the viewer is fetched, at IdleInterval).
func (s *Store) planPoll(cfg Config, now time.Time) (pollPlan, bool) {
	s.mu.Lock()
	tracked := slices.Sorted(maps.Keys(s.tracked))
	heads := map[string][]string{}
	for k, at := range s.watches {
		if now.Sub(at) > s.opts.BranchWatch {
			delete(s.watches, k)
			continue
		}
		heads[k.slug] = append(heads[k.slug], k.head)
	}
	statsDue := s.opts.StatsInterval > 0 && len(tracked) > 0 && !now.Before(s.statsNext)
	s.pollAgain = false // what was asked for so far is in this plan
	s.mu.Unlock()

	var plan pollPlan
	if s.opts.SearchAs != "" && s.searchAsID == "" {
		plan.searchAs = s.opts.SearchAs
	}
	if cfg.Dashboards && len(tracked) > 0 {
		plan.sections = dashboardSections(s.searchLogin(), now)
		for i := range plan.sections {
			if n := s.searchFirst[plan.sections[i].name]; n > 0 {
				plan.sections[i].first = n
			}
		}
	}
	author := s.authorID()
	switch {
	case statsDue && author != "":
		this, last := monthWindows(now)
		plan.stats = &statsPlan{this: this, last: last, login: s.viewerLogin(), author: author, me: s.searchLogin()}
	case statsDue:
		plan.statsDeferred = true
	}
	isTracked := map[string]bool{}
	for _, slug := range tracked {
		isTracked[slug] = true
	}
	slugs := slices.Sorted(maps.Keys(isTracked))
	for slug := range heads {
		if !isTracked[slug] {
			slugs = append(slugs, slug)
		}
	}
	slices.Sort(slugs)
	for _, slug := range slugs {
		slices.Sort(heads[slug])
		plan.repos = append(plan.repos, repoPlan{
			slug: slug, defaultBranch: isTracked[slug], branches: heads[slug],
			history: plan.stats != nil && isTracked[slug],
		})
	}
	return plan, len(tracked) == 0 && len(heads) == 0
}

// authorID is the node id commit history is filtered by: the viewer's, or SearchAs's
// (learned by a poll); empty until known.
func (s *Store) authorID() string {
	if s.opts.SearchAs != "" {
		return s.searchAsID
	}
	if v := s.Snapshot().Viewer.Viewer; v != nil {
		return v.ID
	}
	return ""
}

// shrinkSearches halves every search of plan (floor minSearchFirst) for the next polls.
// It reports whether anything shrank.
func (s *Store) shrinkSearches(plan *pollPlan) bool {
	shrunk := false
	for _, sec := range plan.sections {
		if sec.first > minSearchFirst {
			s.searchFirst[sec.name] = max(minSearchFirst, sec.first/2)
			shrunk = true
		}
	}
	if shrunk {
		s.log.Info("gh poll timed out; shrinking searches", "sizes", s.searchFirst)
	}
	return shrunk
}

// pollFailed records a failed poll. retryNow polls again as soon as MinGap allows,
// without counting a failure.
func (s *Store) pollFailed(ctx context.Context, cfg Config, err error, retryNow bool) error {
	if ctx.Err() != nil {
		return err
	}
	now := s.opts.Now()
	s.mu.Lock()
	switch {
	case retryNow:
		s.schedulePollLocked(now, now)
	case isGlobal(err):
		// Left due: the store-wide pause (or the auth check) holds it.
	default:
		s.pollFailures++
		s.pollAgain = false // a failing poll is not retried early
		s.pollNext = now.Add(backoff(cfg.PollInterval, s.opts.MaxBackoff, s.pollFailures, s.opts.Rand()))
	}
	s.mu.Unlock()
	s.log.Warn("gh poll failed", "err", err)
	msg := err.Error()
	s.updateSnapshot(func(n *Snapshot) {
		n.Poll.LastError = msg
		n.Dashboard.LastError = msg
	})
	snap := s.Snapshot()
	publish(s, Polled{FetchedAt: snap.Poll.FetchedAt, LastError: msg})
	return err
}

// applyPoll turns a decoded poll into the new state: details for what changed, failing
// checks, stats, then one snapshot update and events for what differs.
func (s *Store) applyPoll(ctx context.Context, cfg Config, plan *pollPlan, res *pollResult, idle bool) {
	s.applyViewer(ctx, res)
	snap := s.Snapshot()

	// 1. Pull requests: everything the lists reference, resolved to details.
	known := knownPullRequests(snap, &s.branches)
	var fps []prFingerprint
	seen := map[string]bool{}
	add := func(list []prFingerprint) {
		for _, f := range list {
			if !seen[f.ID] {
				seen[f.ID] = true
				fps = append(fps, f)
			}
		}
	}
	for _, sec := range plan.sections {
		add(res.Sections[sec.name].PRs)
	}
	// Only the viewer's own branch PRs are kept, so only they get details (a watched
	// default branch of a busy repository lists other people's PRs).
	login := res.Viewer.Login
	if s.opts.SearchAs != "" {
		login = s.opts.SearchAs
	}
	for _, rp := range plan.repos {
		rr := res.Repos[rp.slug]
		for _, head := range rp.branches {
			if fps, ok := rr.Branches[head]; ok {
				rr.Branches[head] = keepViewerFingerprints(fps, login)
				add(rr.Branches[head])
			}
		}
	}
	s.staleFullDetails(fps) // cached detail panels of what moved (pr_detail.go)
	var need []prFingerprint
	for _, f := range fps {
		k, ok := known[f.ID]
		if s.needsDetail(k, ok, f) {
			need = append(need, f)
		}
	}
	for id := range s.recheck {
		if !seen[id] {
			delete(s.recheck, id)
		}
	}
	fetched, detailErr := s.fetchDetails(ctx, need)
	if ctx.Err() != nil {
		return
	}
	resolve := func(f prFingerprint) PullRequest {
		if d, ok := fetched[f.ID]; ok {
			return d
		}
		k, ok := known[f.ID]
		if !ok {
			return f.placeholder()
		}
		if f.HasChecks {
			k.Checks = f.Checks
		}
		return k
	}
	resolveAll := func(list []prFingerprint) []PullRequest {
		out := make([]PullRequest, 0, len(list))
		for _, f := range list {
			out = append(out, resolve(f))
		}
		return out
	}

	// 2. Default branches, with failing checks where they changed.
	now := s.opts.Now()
	cis := map[string]BranchCI{}
	var ciReqs []ciRequest
	for _, rp := range plan.repos {
		if !rp.defaultBranch {
			continue
		}
		ci, fetch := s.nextBranchCI(rp.slug, snap.Repos[rp.slug].Activity.DefaultBranch, res.Repos[rp.slug], now)
		cis[rp.slug] = ci
		if fetch {
			ciReqs = append(ciReqs, ciRequest{slug: rp.slug, sha: ci.SHA})
		}
	}
	s.fetchFailing(ctx, ciReqs, cis)

	// 3. Stats.
	var stats *MonthlyStats
	repoStats := map[string]MonthlyStats{}
	if plan.stats != nil {
		stats = s.applyStats(ctx, cfg, plan, res, snap, repoStats)
	}
	if ctx.Err() != nil {
		return
	}

	// 4. One snapshot update; then events and cache writes for what changed.
	now = s.opts.Now()
	pollErr := ""
	if detailErr != nil {
		pollErr = "pull request details: " + detailErr.Error()
	}
	var dashErrs []string
	newDash := snap.Dashboard
	newDash.FetchedAt, newDash.Disabled = now, !cfg.Dashboards
	switch {
	case !cfg.Dashboards:
		newDash.Authored, newDash.ReviewRequested, newDash.Reviewed, newDash.RecentlyMerged = nil, nil, nil, nil
		newDash.AuthoredTotal, newDash.ReviewRequestedTotal, newDash.ReviewedTotal, newDash.RecentlyMergedTotal = 0, 0, 0, 0
	case len(plan.sections) > 0:
		set := func(name string, list *[]PullRequest, total *int) {
			r := res.Sections[name]
			if r.Err != nil {
				dashErrs = append(dashErrs, name+": "+r.Err.Error())
				return // keep the last good list
			}
			*list, *total = resolveAll(r.PRs), r.Total
		}
		set(sectionAuthored, &newDash.Authored, &newDash.AuthoredTotal)
		set(sectionReview, &newDash.ReviewRequested, &newDash.ReviewRequestedTotal)
		set(sectionReviewed, &newDash.Reviewed, &newDash.ReviewedTotal)
		set(sectionMerged, &newDash.RecentlyMerged, &newDash.RecentlyMergedTotal)
		requested := map[string]bool{}
		for _, p := range newDash.ReviewRequested {
			requested[p.ID] = true
		}
		newDash.Reviewed = slices.DeleteFunc(slices.Clone(newDash.Reviewed), func(p PullRequest) bool { return requested[p.ID] })
	}
	newDash.LastError = strings.Join(dashErrs, "; ")
	if stats != nil {
		newDash.Stats = *stats
	}
	dashChanged := !sameDashboard(snap.Dashboard, newDash)

	type branchUpdate struct {
		k  branchKey
		st BranchPullRequests
	}
	var branchUpdates []branchUpdate
	for _, rp := range plan.repos {
		rr := res.Repos[rp.slug]
		for _, head := range rp.branches {
			k := branchKey{rp.slug, head}
			prev, had := s.branches.get(k)
			st := BranchPullRequests{Slug: rp.slug, HeadRef: head, PullRequests: prev.PullRequests, FetchedAt: prev.FetchedAt}
			if err := cmpErr(rr.Err, rr.BranchErr[head]); err != nil {
				st.LastError = err.Error()
			} else {
				st.PullRequests = resolveAll(rr.Branches[head])
				st.FetchedAt = now
			}
			changed := !had || prev.FetchedAt.IsZero() || prev.LastError != st.LastError || !sameJSON(prev.PullRequests, st.PullRequests)
			s.branches.set(k, st)
			if changed {
				branchUpdates = append(branchUpdates, branchUpdate{k, st})
			}
		}
	}

	var repoChanged []string
	s.updateSnapshot(func(n *Snapshot) {
		n.Dashboard = newDash
		n.Poll = PollState{FetchedAt: now, LastError: pollErr}
		for slug, ci := range cis {
			r := n.Repos[slug]
			r.Slug = slug
			old := r.Activity
			r.Activity.DefaultBranch = ci
			if st, ok := repoStats[slug]; ok {
				r.Activity.Stats = st
			}
			if !sameBranchCI(old.DefaultBranch, r.Activity.DefaultBranch) || !sameStats(old.Stats, r.Activity.Stats) {
				repoChanged = append(repoChanged, slug)
			}
			n.Repos[slug] = r
		}
	})
	slices.Sort(repoChanged)

	// The stats row is written whenever stats were fetched: its time schedules them
	// after a restart.
	if stats != nil && stats.LastError == "" {
		if err := s.cache.saveActivity(ctx, activityStats, stats.FetchedAt, *stats); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
	}
	if dashChanged {
		if err := s.cache.saveActivity(ctx, activityDashboard, now, newDash); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
		publish(s, DashboardUpdated{FetchedAt: now})
	}
	for _, slug := range repoChanged {
		a := s.Snapshot().Repos[slug].Activity
		if err := s.cache.saveActivity(ctx, activityDefaultBranch+slug, now, a.DefaultBranch); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
		if _, ok := repoStats[slug]; ok {
			if err := s.cache.saveActivity(ctx, activityRepoStats+slug, now, a.Stats); err != nil {
				s.log.Warn("gh cache write failed", "err", err)
			}
		}
		publish(s, RepoActivityUpdated{Slug: slug, FetchedAt: now})
	}
	for _, u := range branchUpdates {
		if u.st.LastError == "" {
			if err := s.cache.saveActivity(ctx, activityBranchKey(u.k), now, u.st); err != nil {
				s.log.Warn("gh cache write failed", "err", err)
			}
		}
		publish(s, BranchPullRequestsUpdated{Slug: u.k.slug, HeadRef: u.k.head, FetchedAt: u.st.FetchedAt})
	}
	if err := s.cache.saveActivity(ctx, activityPoll, now, pollRow{FetchedAt: now}); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	publish(s, Polled{FetchedAt: now, LastError: pollErr})

	interval := cfg.PollInterval
	switch {
	case plan.statsDeferred && s.authorID() != "":
		interval = 0 // the stats waited for the viewer's id, which this poll brought
	case idle:
		interval = s.opts.IdleInterval
	}
	s.mu.Lock()
	s.pollFailures = 0
	s.schedulePollLocked(now, now.Add(interval))
	s.mu.Unlock()
}

// applyViewer records the poll's viewer; ViewerUpdated goes out only when it changed.
func (s *Store) applyViewer(ctx context.Context, res *pollResult) {
	if res.SearchAsID != "" {
		s.searchAsID = res.SearchAsID
	}
	v := *res.Viewer
	now := s.opts.Now()
	cur := s.Snapshot().Viewer
	if cur.Viewer == nil || *cur.Viewer != v {
		if err := s.cache.saveViewer(ctx, v, now); err != nil {
			s.log.Warn("gh cache write failed", "err", err)
		}
	}
	s.updateViewer(func(vs *ViewerState) {
		vs.Viewer, vs.Authenticated, vs.FetchedAt, vs.LastError = &v, true, now, ""
	})
}

// knownPullRequests indexes the pull requests the published state already holds, by
// node id: the poll's diff baseline. Rebuilding it per poll keeps no second copy of the
// state to drift.
func knownPullRequests(snap *Snapshot, b *branchStates) map[string]PullRequest {
	out := map[string]PullRequest{}
	addAll := func(prs []PullRequest) {
		for _, p := range prs {
			if p.ID != "" {
				out[p.ID] = p
			}
		}
	}
	d := snap.Dashboard
	addAll(d.RecentlyMerged)
	addAll(d.Reviewed)
	addAll(d.ReviewRequested)
	addAll(d.Authored)
	b.mu.Lock()
	for _, st := range b.m {
		addAll(st.PullRequests)
	}
	b.mu.Unlock()
	return out
}

// needsDetail reports whether a pull request must be (re)fetched: it is new or only a
// placeholder, its updatedAt, state, or head moved, its check rollup state changed
// (mergeStateStatus depends on it), it is open but was stored with the summary only,
// or GitHub was still computing its mergeability.
func (s *Store) needsDetail(k PullRequest, ok bool, f prFingerprint) bool {
	switch {
	case !ok || k.Partial:
		return true
	case !k.UpdatedAt.Equal(f.UpdatedAt) || k.State != f.State || k.HeadSHA != f.HeadSHA:
		return true
	case f.HasChecks && k.Checks.State != f.Checks.State:
		return true
	case f.State == PullRequestOpen && k.Mergeable == "" && k.MergeStateStatus == "":
		return true // summary only (it was closed when fetched)
	case s.recheck[f.ID] > 0:
		s.recheck[f.ID]--
		return true
	}
	return false
}

// fetchDetails fetches the pull requests in need, open ones with every field and
// closed ones with the summary, in batches. It returns what it got and the first error
// that stopped it (a 502/504 halves the batch and retries first).
func (s *Store) fetchDetails(ctx context.Context, need []prFingerprint) (map[string]PullRequest, error) {
	out := map[string]PullRequest{}
	var open, closed []string
	for _, f := range need {
		if f.State == PullRequestOpen {
			open = append(open, f.ID)
		} else {
			closed = append(closed, f.ID)
		}
	}
	for len(open) > 0 || len(closed) > 0 {
		n := s.detailBatch
		o, c := open[:min(n, len(open))], closed[:min(n*closedPerOpen, len(closed))]
		data, err := s.call(ctx, queryPullRequestDetails, map[string]any{"open": nonNil(o), "closed": nonNil(c)})
		if err != nil && !isPartial(err) {
			if isServerTimeout(err) && n > minDetailBatch {
				s.detailBatch = max(minDetailBatch, n/2)
				s.log.Info("gh details timed out; shrinking batch", "batch", s.detailBatch)
				continue
			}
			return out, err
		}
		got, err := decodeDetails(data)
		if err != nil {
			return out, err
		}
		for id, p := range got {
			out[id] = p
			s.cycle.details++
			if p.State == PullRequestOpen && (p.Mergeable == MergeableUnknown || p.MergeStateStatus == "UNKNOWN") {
				if _, ok := s.recheck[id]; !ok {
					s.recheck[id] = mergeableRechecks
				}
			} else {
				delete(s.recheck, id)
			}
		}
		open, closed = open[len(o):], closed[len(c):]
	}
	return out, nil
}

func nonNil(ids []string) []string {
	if ids == nil {
		return []string{}
	}
	return ids
}

// failingKeyOf identifies the failing-check list a BranchCI holds: it is refetched when
// the head or the failure count moves.
func failingKeyOf(ci BranchCI) string {
	if ci.SHA == "" {
		return ""
	}
	return fmt.Sprintf("%s|%d", ci.SHA, ci.Rollup.Failed)
}

// nextBranchCI computes a tracked repository's default branch CI from the poll. fetch
// is set when its failing checks must be fetched (head or failure count changed).
func (s *Store) nextBranchCI(slug string, prev BranchCI, rr repoResult, now time.Time) (BranchCI, bool) {
	if rr.Err != nil {
		ci := prev
		ci.LastError = rr.Err.Error()
		return ci, false
	}
	fp := rr.DefaultBranch
	if fp == nil { // empty repository
		return BranchCI{FetchedAt: now}, false
	}
	ci := BranchCI{Branch: fp.Branch, SHA: fp.SHA, Headline: fp.Headline, CommittedAt: fp.CommittedAt, Rollup: fp.Rollup, FetchedAt: now}
	key := failingKeyOf(ci)
	switch {
	case ci.Rollup.Failed == 0:
		s.failingKey[slug] = key
		return ci, false
	case s.failingKey[slug] == key:
		ci.Failing = prev.Failing
		return ci, false
	}
	if prev.SHA == ci.SHA {
		ci.Failing = prev.Failing // until the fetch replaces it
	}
	return ci, true
}

// fetchFailing fetches the failing checks of the default branches in reqs (one request
// for all, more pages only when failures are beyond the first 100 checks) into cis.
func (s *Store) fetchFailing(ctx context.Context, reqs []ciRequest, cis map[string]BranchCI) {
	if len(reqs) == 0 {
		return
	}
	doc, vars, err := defaultBranchChecksDoc(reqs)
	if err != nil {
		s.log.Warn("gh default branch checks", "err", err)
		return
	}
	data, err := s.callDoc(ctx, queryDefaultBranchChecks, doc, vars)
	var partial *PartialError
	if err != nil && !errors.As(err, &partial) {
		s.log.Warn("gh default branch checks failed", "err", err)
		return
	}
	pages, errs := decodeDefaultBranchChecks(reqs, data, partial)
	for _, r := range reqs {
		if err := errs[r.slug]; err != nil {
			s.log.Warn("gh default branch checks failed", "slug", r.slug, "err", err)
			continue
		}
		ci, page := cis[r.slug], pages[r.slug]
		failing := failingRuns(page.Runs)
		owner, name := splitSlug(r.slug)
		next := page.Next
		complete := true
		for p := 1; ci.Rollup.Failed > len(failing) && next.HasNextPage && next.EndCursor != ""; p++ {
			if p >= s.opts.MaxPages {
				break
			}
			data, err := s.call(ctx, queryChecks, map[string]any{"owner": owner, "name": name, "ref": ci.SHA, "after": next.EndCursor})
			var cp checksPage
			if err == nil {
				cp, _, err = decodeChecks(data)
			}
			if err != nil {
				s.log.Warn("gh default branch checks page failed", "slug", r.slug, "err", err)
				complete = false
				break
			}
			failing = append(failing, failingRuns(cp.Runs)...)
			next = cp.Next
		}
		sortRuns(failing)
		ci.Failing = failing
		cis[r.slug] = ci
		if complete {
			s.failingKey[r.slug] = failingKeyOf(ci)
		}
	}
}

// applyStats turns the poll's stats part (and the REST commit searches) into the
// global stats, which it returns, and per-repository stats, which it adds to repoStats.
func (s *Store) applyStats(ctx context.Context, cfg Config, plan *pollPlan, res *pollResult, snap *Snapshot, repoStats map[string]MonthlyStats) *MonthlyStats {
	sp, st := plan.stats, res.Stats
	now := s.opts.Now()
	if st == nil || st.Err != nil {
		err := errors.New("no stats in the response")
		if st != nil {
			err = st.Err
		}
		s.mu.Lock()
		s.statsFailures++
		s.statsNext = now.Add(backoff(cfg.PollInterval, s.opts.MaxBackoff, s.statsFailures, s.opts.Rand()))
		s.mu.Unlock()
		s.log.Warn("gh stats failed", "err", err)
		g := snap.Dashboard.Stats
		g.LastError = err.Error()
		return &g
	}
	global := MonthlyStats{
		ThisMonth:     MonthCount{Month: sp.this.Label, Merged: st.MergedThis, Commits: st.ContribThis},
		LastMonth:     MonthCount{Month: sp.last.Label, Merged: st.MergedLast, Commits: st.ContribLast},
		CommitsSource: CommitsFromContributions,
	}
	// REST search/commits counts commits by author date in our time zone, which
	// contributionsCollection cannot (it buckets by UTC day). Prefer it when it works.
	if rr, ok := s.opts.Runner.(RESTRunner); ok {
		me := sp.me
		ct, err1 := s.searchCommits(ctx, rr, fmt.Sprintf("author:%s author-date:%s", me, sp.this.searchRange()))
		var cl int
		var err2 error
		if err1 == nil {
			cl, err2 = s.searchCommits(ctx, rr, fmt.Sprintf("author:%s author-date:%s", me, sp.last.searchRange()))
		}
		if err := cmp.Or(err1, err2); err != nil {
			if ctx.Err() == nil {
				s.log.Warn("gh commit search failed; using contributions", "err", err)
			}
		} else {
			global.ThisMonth.Commits, global.LastMonth.Commits, global.CommitsSource = ct, cl, CommitsFromSearch
		}
	}
	if !st.HasContrib && global.CommitsSource == CommitsFromContributions {
		global.CommitsSource = ""
	}
	global.FetchedAt = s.opts.Now()
	if st.RecentTotal > len(st.Recent) {
		s.log.Info("gh merged pull requests exceed the stats list; per-repository merged counts are lower bounds",
			"total", st.RecentTotal, "listed", len(st.Recent))
	}
	for _, rp := range plan.repos {
		if !rp.history {
			continue
		}
		rr := res.Repos[rp.slug]
		prev := snap.Repos[rp.slug].Activity.Stats
		if rr.History == nil {
			prev.LastError = cmpErr(rr.Err, errors.New("no commit history in the response")).Error()
			repoStats[rp.slug] = prev
			continue
		}
		rs := MonthlyStats{
			ThisMonth:     MonthCount{Month: sp.this.Label, Commits: rr.History[0]},
			LastMonth:     MonthCount{Month: sp.last.Label, Commits: rr.History[1]},
			CommitsSource: CommitsFromSearch,
			FetchedAt:     global.FetchedAt,
		}
		for _, m := range st.Recent {
			if m.Repo != rp.slug {
				continue
			}
			switch {
			case sp.this.contains(m.MergedAt):
				rs.ThisMonth.Merged++
			case sp.last.contains(m.MergedAt):
				rs.LastMonth.Merged++
			}
		}
		repoStats[rp.slug] = rs
	}
	s.mu.Lock()
	s.statsFailures = 0
	s.statsNext = now.Add(s.opts.StatsInterval)
	s.mu.Unlock()
	return &global
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
	s.cycle.requests++
	s.log.Debug("gh request", "rest", "search/commits", "q", q, "dur", s.lastEnd.Sub(start).Round(time.Millisecond).String(), "err", err)
	if err != nil {
		if isAuthOrNetwork(err) {
			s.noteResult(ctx, err, nil)
		}
		return 0, err
	}
	return decodeSearchTotal(body)
}

// ---- comparisons ---------------------------------------------------------------

// sameJSON compares two values by their JSON encoding (what the cache and clients
// see), which sidesteps time.Time's location and monotonic-clock fields.
func sameJSON(a, b any) bool {
	x, err1 := json.Marshal(a)
	y, err2 := json.Marshal(b)
	return err1 == nil && err2 == nil && string(x) == string(y)
}

// sameDashboard compares everything clients see except FetchedAt.
func sameDashboard(a, b Dashboard) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	a.Stats.FetchedAt, b.Stats.FetchedAt = time.Time{}, time.Time{}
	return a.LastError == b.LastError && a.Disabled == b.Disabled && a.Stats.LastError == b.Stats.LastError &&
		sameJSON(a, b) && sameJSON(a.Stats, b.Stats)
}

// sameBranchCI compares everything but FetchedAt.
func sameBranchCI(a, b BranchCI) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	return a.LastError == b.LastError && sameJSON(a, b)
}

// sameStats compares everything but FetchedAt.
func sameStats(a, b MonthlyStats) bool {
	a.FetchedAt, b.FetchedAt = time.Time{}, time.Time{}
	return a.LastError == b.LastError && sameJSON(a, b)
}

// ---- auth ----------------------------------------------------------------------

// checkAuth runs while gh is known to be unauthenticated. Runner.AuthStatus asks gh for
// its token again and validates it with one REST call (GET /user); on success, polling
// resumes and the next GraphQL success clears the auth state.
func (s *Store) checkAuth(ctx context.Context) {
	if err := s.pace(ctx); err != nil {
		return
	}
	st, err := s.opts.Runner.AuthStatus(ctx)
	s.lastEnd = s.opts.Now()
	if ctx.Err() != nil {
		return
	}
	now := s.opts.Now()
	s.mu.Lock()
	if err == nil && st.LoggedIn {
		// Resume polling. authFailures is kept so that a token REST accepts but GraphQL
		// rejects keeps backing off instead of looping at AuthRetry.
		s.authBad = false
		s.pollNext = now
		s.mu.Unlock()
		s.log.Info("gh authenticated again; resuming", "login", st.Login)
		return
	}
	s.authFailures++
	s.authNext = now.Add(backoff(s.opts.AuthRetry, s.opts.MaxBackoff, s.authFailures, s.opts.Rand()))
	s.mu.Unlock()
	msg := ErrNotAuthenticated.Error()
	switch {
	case err != nil:
		msg = err.Error()
	case st.Error != "":
		msg += ": " + st.Error
	}
	s.updateViewer(func(vs *ViewerState) { vs.Authenticated, vs.LastError = false, msg })
}

// ---- on-demand reads -----------------------------------------------------------

func (s *Store) fetchPullRequest(ctx context.Context, slug string, number int) (PullRequestDetail, error) {
	owner, name := splitSlug(slug)
	var (
		pr    PullRequest
		runs  []CheckRun
		after string
	)
	for range s.opts.MaxPages {
		vars := map[string]any{"owner": owner, "name": name, "number": number}
		if after != "" {
			vars["after"] = after
		}
		data, err := s.call(ctx, queryPullRequest, vars)
		if err != nil {
			return PullRequestDetail{}, err
		}
		p, page, _, err := decodePullRequest(data)
		if err != nil {
			return PullRequestDetail{}, err
		}
		pr = p
		runs = append(runs, page.Runs...)
		if !page.Next.HasNextPage || page.Next.EndCursor == "" {
			break
		}
		after = page.Next.EndCursor
	}
	sortRuns(runs)
	d := PullRequestDetail{PullRequest: pr, Checks: runs, FetchedAt: s.opts.Now()}
	if err := s.cache.saveDetail(ctx, slug, d); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	return d, nil
}

func (s *Store) fetchChecks(ctx context.Context, slug, ref string) (RefChecks, error) {
	owner, name := splitSlug(slug)
	var (
		out   RefChecks
		after string
	)
	for range s.opts.MaxPages {
		vars := map[string]any{"owner": owner, "name": name, "ref": ref}
		if after != "" {
			vars["after"] = after
		}
		data, err := s.call(ctx, queryChecks, vars)
		if err != nil {
			return RefChecks{}, err
		}
		page, _, err := decodeChecks(data)
		if err != nil {
			return RefChecks{}, err
		}
		out.SHA, out.Rollup = page.SHA, page.Rollup
		out.Runs = append(out.Runs, page.Runs...)
		if !page.Next.HasNextPage || page.Next.EndCursor == "" {
			break
		}
		after = page.Next.EndCursor
	}
	sortRuns(out.Runs)
	out.FetchedAt = s.opts.Now()
	if err := s.cache.saveChecks(ctx, slug, ref, out); err != nil {
		s.log.Warn("gh cache write failed", "err", err)
	}
	return out, nil
}

// ---- snapshot ------------------------------------------------------------------

// updateSnapshot applies fn to a copy of the snapshot and publishes it.
func (s *Store) updateSnapshot(fn func(*Snapshot)) {
	s.snapMu.Lock()
	defer s.snapMu.Unlock()
	n := s.snap.Load().clone()
	fn(n)
	s.snap.Store(n)
}

// updateRepo applies fn to a copy of slug's state and publishes a new snapshot.
func (s *Store) updateRepo(slug string, fn func(*RepoState)) RepoState {
	var r RepoState
	s.updateSnapshot(func(n *Snapshot) {
		r = n.Repos[slug]
		r.Slug = slug
		fn(&r)
		n.Repos[slug] = r
	})
	return r
}

// updateViewer applies fn to a copy of the viewer state, publishes a new snapshot, and
// announces it when anything but FetchedAt changed.
func (s *Store) updateViewer(fn func(*ViewerState)) {
	var before, after ViewerState
	s.updateSnapshot(func(n *Snapshot) {
		before = n.Viewer
		fn(&n.Viewer)
		after = n.Viewer
	})
	sameViewer := (before.Viewer == nil) == (after.Viewer == nil) && (before.Viewer == nil || *before.Viewer == *after.Viewer)
	if sameViewer && before.Authenticated == after.Authenticated && before.LastError == after.LastError {
		return
	}
	publish(s, ViewerUpdated{FetchedAt: after.FetchedAt})
}

func (s *Store) setAuthenticated(ok bool, msg string) {
	s.updateViewer(func(vs *ViewerState) {
		vs.Authenticated = ok
		if msg != "" || ok {
			vs.LastError = msg
		}
	})
}
