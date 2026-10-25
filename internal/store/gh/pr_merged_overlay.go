package gh

import (
	"cmp"
	"slices"
	"sync"
	"time"
)

// A merge shows at once (docs/notes/bridge-fix-c-daemon.md). The dashboards are search
// results, and GitHub's search index trails a merge by a minute or so: the poll right
// after MergePullRequest still finds the pull request open in the viewer's lists, so a
// page or the PRs page would keep a Merge button on a merged pull request. A merge this
// store made therefore moves the pull request to recently merged in the published
// dashboard at once, and every poll keeps it there until the searches agree (it is in
// recently merged and in no open list) or mergeMarkTTL passes.
//
// The overlay is for what clients see only. The poll's diffs (PullRequestChanged, the
// merged-this-month check) and the cache use the dashboard as the poll left it, so a
// wake on "merged" still fires when the poll sees the merge, as it did before.

// mergeMarkTTL bounds how long a merge this store made overrides the searches.
const mergeMarkTTL = 10 * time.Minute

// mergeMark is a merge this store made: the pull request as recently merged lists it.
type mergeMark struct {
	pr PullRequest
	at time.Time
}

// mergedOverlay holds the marks and the dashboard the last poll produced before them.
// Its methods run under snapMu (inside updateSnapshot), mu guards the reads outside it.
type mergedOverlay struct {
	mu    sync.Mutex
	marks map[fullKey]mergeMark
	// polled is the dashboard without the marks, once there has been a mark; nil means
	// the published dashboard has none.
	polled *Dashboard
}

// basis is the dashboard as the last poll left it: the baseline of the next poll's
// diffs.
func (o *mergedOverlay) basis(published Dashboard) Dashboard {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.polled != nil {
		return *o.polled
	}
	return published
}

// mark records the merge of k at now and returns the dashboard to publish, false when
// the pull request is in none of the dashboard's lists (nothing to move).
func (o *mergedOverlay) mark(k fullKey, published Dashboard, now time.Time) (Dashboard, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.polled == nil {
		d := published
		o.polled = &d
	}
	pr, ok := findPullRequest(*o.polled, k)
	if !ok {
		return published, false
	}
	pr.State, pr.MergedAt = PullRequestMerged, now
	if o.marks == nil {
		o.marks = map[fullKey]mergeMark{}
	}
	o.marks[k] = mergeMark{pr: pr, at: now}
	d, _ := overlayMerges(*o.polled, o.marks, now)
	// What the poll did not write keeps its published value (a failed poll's error).
	d.FetchedAt, d.LastError, d.Stats = published.FetchedAt, published.LastError, published.Stats
	return d, true
}

// apply records polled as the poll's dashboard and returns it with the marks the
// searches do not show yet; marks they show, and expired ones, are dropped.
func (o *mergedOverlay) apply(polled Dashboard, now time.Time) Dashboard {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 {
		o.polled = nil
		return polled
	}
	d := polled
	o.polled = &d
	out, done := overlayMerges(polled, o.marks, now)
	for _, k := range done {
		delete(o.marks, k)
	}
	if len(o.marks) == 0 {
		o.polled = nil
	}
	return out
}

// overlayMerges moves each marked pull request from the open lists to recently merged
// and returns the keys whose marks are done: confirmed by the searches (in recently
// merged, in no open list), or older than mergeMarkTTL. A disabled dashboard has no
// lists to fix.
func overlayMerges(d Dashboard, marks map[fullKey]mergeMark, now time.Time) (Dashboard, []fullKey) {
	var done []fullKey
	if d.Disabled {
		for k := range marks {
			done = append(done, k)
		}
		return d, done
	}
	for k, m := range marks {
		is := func(p PullRequest) bool { return samePullRequest(p, k, m.pr.ID) }
		open := slices.ContainsFunc(d.Authored, is) || slices.ContainsFunc(d.ReviewRequested, is) || slices.ContainsFunc(d.Reviewed, is)
		merged := slices.ContainsFunc(d.RecentlyMerged, is)
		if (merged && !open) || now.Sub(m.at) >= mergeMarkTTL {
			done = append(done, k)
			continue
		}
		drop := func(list []PullRequest, total *int) []PullRequest {
			n := len(list)
			list = slices.DeleteFunc(slices.Clone(list), is)
			*total = max(0, *total-(n-len(list)))
			return list
		}
		d.Authored = drop(d.Authored, &d.AuthoredTotal)
		d.ReviewRequested = drop(d.ReviewRequested, &d.ReviewRequestedTotal)
		d.Reviewed = drop(d.Reviewed, &d.ReviewedTotal)
		if !merged {
			d.RecentlyMerged = append([]PullRequest{m.pr}, d.RecentlyMerged...)
			d.RecentlyMergedTotal++
		}
	}
	slices.SortFunc(done, func(a, b fullKey) int { return cmp.Or(cmp.Compare(a.slug, b.slug), cmp.Compare(a.number, b.number)) })
	return d, done
}

// findPullRequest is k in d's lists, the open ones first.
func findPullRequest(d Dashboard, k fullKey) (PullRequest, bool) {
	for _, list := range [][]PullRequest{d.Authored, d.ReviewRequested, d.Reviewed, d.RecentlyMerged} {
		if i := slices.IndexFunc(list, func(p PullRequest) bool { return samePullRequest(p, k, "") }); i >= 0 {
			return list[i], true
		}
	}
	return PullRequest{}, false
}

// samePullRequest reports whether p is k: the same node id when both are known, else
// the same repository and number.
func samePullRequest(p PullRequest, k fullKey, id string) bool {
	if id != "" && p.ID != "" {
		return p.ID == id
	}
	slug, err := NormalizeSlug(p.Repo)
	return err == nil && slug == k.slug && p.Number == k.number
}

// markMerged shows the merge of k in the published dashboard at once (see above) and
// publishes DashboardUpdated when it moved anything.
func (s *Store) markMerged(k fullKey) {
	moved := false
	s.updateSnapshot(func(n *Snapshot) {
		n.Dashboard, moved = s.mergedShown.mark(k, n.Dashboard, s.opts.Now())
	})
	if moved {
		s.log.Info("gh merge shown before the searches have it", "pr", k.String())
		publish(s, DashboardUpdated{FetchedAt: s.Snapshot().Dashboard.FetchedAt})
	}
}
