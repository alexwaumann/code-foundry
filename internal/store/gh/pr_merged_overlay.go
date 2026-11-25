package gh

import (
	"cmp"
	"slices"
	"strings"
	"sync"
	"time"
)

// Local mutation overlay (docs/notes/bridge-fix-c-daemon.md,
// docs/notes/perf-gh-mutation-patch-overlay.md). The dashboards and project lists are
// GitHub search results, and GitHub's search index trails a mutation by a minute or so:
// a poll right after MergePullRequest, SetPullRequestClosed, SetPullRequestDraft, or
// SubmitPullRequestReview can still see the previous state in the viewer's lists.
//
// Mutations this store made therefore overlay the published Dashboard, Snapshot.Projects,
// and BranchPullRequests lists at once, and every poll keeps each overlay active until
// GitHub's searches confirm the new state or mergeMarkTTL passes.
//
// The overlay is for what clients see only. The poll's diffs (PullRequestChanged, the
// merged-this-month check) and the SQLite dashboard cache use the dashboard and branch
// lists as the poll left them (basis), so a wake on "merged" or "closed" still fires when
// the poll sees it, as it did before.

// mergeMarkTTL bounds how long a local mutation overrides GitHub's search results.
const mergeMarkTTL = 10 * time.Minute

// localMark records local mutations this store made to one pull request before GitHub's
// search index catches up. Each field expires independently after mergeMarkTTL or once
// the searches agree.
type localMark struct {
	// state is PullRequestMerged, PullRequestClosed, or PullRequestOpen (reopened).
	state   PullRequestState
	stateAt time.Time
	// pr is the pull request snapshot used to place a merged PR into RecentlyMerged or
	// restore a reopened PR into its open list while the searches lag.
	pr PullRequest
	// originSection remembers which dashboard open list k belonged to before a local
	// close, or sectionAuthored when reopening a viewer-authored PR not yet in the lists.
	originSection string
	// wasInDashboard records whether k was present in the dashboard when the mark was
	// recorded, so dashboard-only confirmation does not drop branch-only marks.
	wasInDashboard bool

	draft      *bool
	draftAt    time.Time
	mergeState MergeStateStatus

	reviewDecision   ReviewDecision
	reviewDecisionAt time.Time

	updatedAt time.Time
}

func (m localMark) empty() bool {
	return m.state == "" && m.draft == nil && m.reviewDecision == ""
}

func (m localMark) id() string { return m.pr.ID }

// localOverlay holds the local mutation marks and the un-overlaid dashboard/projects the
// last poll produced before them. Dashboard/projects mutations run under snapMu (inside
// updateSnapshot); mu guards all reads and writes.
type localOverlay struct {
	mu    sync.Mutex
	marks map[fullKey]localMark
	// polled is the dashboard without the marks, once there has been a mark; nil means
	// the published dashboard has none.
	polled *Dashboard
	// polledProjects is the project-wide lists without the marks, when active.
	polledProjects *ProjectPullRequests
}

// basis is the dashboard as the last poll left it: the baseline of the next poll's diffs.
func (o *localOverlay) basis(published Dashboard) Dashboard {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.polled != nil {
		return *o.polled
	}
	return published
}

// projectsBasis is Snapshot.Projects as the last poll left it.
func (o *localOverlay) projectsBasis(published ProjectPullRequests) ProjectPullRequests {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.polledProjects != nil {
		return *o.polledProjects
	}
	return published
}

// record updates k's mark under o.mu and returns the overlaid Dashboard and
// ProjectPullRequests to publish (along with whether either changed). fallback is used
// when k is not currently in the dashboard (e.g. a branch-only or reopened PR).
func (o *localOverlay) record(k fullKey, published Dashboard, publishedProjects ProjectPullRequests, fallback PullRequest, now time.Time, edit func(m *localMark, found PullRequest, section string)) (Dashboard, ProjectPullRequests, bool, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.polled == nil {
		d := published
		o.polled = &d
	}
	if o.polledProjects == nil {
		p := publishedProjects
		o.polledProjects = &p
	}
	if o.marks == nil {
		o.marks = map[fullKey]localMark{}
	}
	m := o.marks[k]
	found, section, inDash := findPullRequestSection(*o.polled, k)
	if !inDash {
		if m.pr.ID != "" || m.pr.Number > 0 {
			found = m.pr
		} else if fallback.ID != "" || fallback.Number > 0 {
			found = fallback
		}
	} else {
		m.wasInDashboard = true
		if m.originSection == "" && section != "" && section != sectionMerged {
			m.originSection = section
		}
	}
	edit(&m, found, section)
	if m.empty() {
		delete(o.marks, k)
	} else {
		o.marks[k] = m
	}
	if len(o.marks) == 0 {
		d, p := *o.polled, *o.polledProjects
		o.polled, o.polledProjects = nil, nil
		d.FetchedAt, d.LastError, d.Stats = published.FetchedAt, published.LastError, published.Stats
		p.FetchedAt, p.LastError = publishedProjects.FetchedAt, publishedProjects.LastError
		return d, p, !sameDashboard(published, d), !sameProjects(publishedProjects, p)
	}
	d, _, _ := overlayDashboard(*o.polled, o.marks, now)
	// What the poll did not write keeps its published value (a failed poll's error).
	d.FetchedAt, d.LastError, d.Stats = published.FetchedAt, published.LastError, published.Stats
	p := overlayProjects(*o.polledProjects, o.marks, now)
	p.FetchedAt, p.LastError = publishedProjects.FetchedAt, publishedProjects.LastError
	return d, p, !sameDashboard(published, d), !sameProjects(publishedProjects, p)
}

// apply records polled as the poll's dashboard and returns it with the marks the
// searches do not show yet; marks they show, and expired ones, are dropped.
func (o *localOverlay) apply(polled Dashboard, now time.Time) Dashboard {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 {
		o.polled = nil
		o.polledProjects = nil
		return polled
	}
	d := polled
	o.polled = &d
	out, next, _ := overlayDashboard(polled, o.marks, now)
	o.marks = next
	if len(o.marks) == 0 {
		o.polled = nil
		o.polledProjects = nil
	}
	return out
}

// applyProjects records polled as the poll's ProjectPullRequests, clears any
// non-dashboard mark fields that Projects already confirms, and returns it with active
// local marks overlaid.
func (o *localOverlay) applyProjects(polled ProjectPullRequests, now time.Time) ProjectPullRequests {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 {
		o.polledProjects = nil
		return polled
	}
	p := polled
	o.polledProjects = &p
	for k, m := range o.marks {
		if m.wasInDashboard {
			continue
		}
		is := func(pr PullRequest) bool { return samePullRequest(pr, k, m.id()) }
		inOpen := slices.ContainsFunc(polled.Open.PullRequests, is)
		inMerged := slices.ContainsFunc(polled.Merged.PullRequests, is)
		if m.state != "" {
			if now.Sub(m.stateAt) >= mergeMarkTTL ||
				(m.state == PullRequestMerged && inMerged && !inOpen) ||
				(m.state == PullRequestClosed && !inOpen) ||
				(m.state == PullRequestOpen && inOpen) {
				m.state, m.stateAt = "", time.Time{}
			}
		}
		if m.draft != nil {
			idx := slices.IndexFunc(polled.Open.PullRequests, is)
			if now.Sub(m.draftAt) >= mergeMarkTTL || (idx >= 0 && polled.Open.PullRequests[idx].Draft == *m.draft) {
				m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
			}
		}
		if m.reviewDecision != "" {
			idx := slices.IndexFunc(polled.Open.PullRequests, is)
			if now.Sub(m.reviewDecisionAt) >= mergeMarkTTL || (idx >= 0 && polled.Open.PullRequests[idx].ReviewDecision == m.reviewDecision) {
				m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
			}
		}
		if m.empty() {
			delete(o.marks, k)
		} else {
			o.marks[k] = m
		}
	}
	if len(o.marks) == 0 {
		o.polled = nil
		o.polledProjects = nil
		return polled
	}
	return overlayProjects(polled, o.marks, now)
}

// confirmBranches clears non-dashboard mark fields that a live branch poll has already
// caught up with, and expires old marks.
func (o *localOverlay) confirmBranches(prs []PullRequest, now time.Time) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 {
		return
	}
	for k, m := range o.marks {
		if m.wasInDashboard {
			continue
		}
		idx := slices.IndexFunc(prs, func(p PullRequest) bool { return samePullRequest(p, k, m.id()) })
		if idx < 0 {
			continue
		}
		p := prs[idx]
		if m.state != "" && (p.State == m.state || now.Sub(m.stateAt) >= mergeMarkTTL) {
			m.state, m.stateAt = "", time.Time{}
		}
		if m.draft != nil && (p.Draft == *m.draft || now.Sub(m.draftAt) >= mergeMarkTTL) {
			m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
		}
		if m.reviewDecision != "" && (p.ReviewDecision == m.reviewDecision || now.Sub(m.reviewDecisionAt) >= mergeMarkTTL) {
			m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
		}
		if m.empty() {
			delete(o.marks, k)
		} else {
			o.marks[k] = m
		}
	}
	if len(o.marks) == 0 {
		o.polled = nil
		o.polledProjects = nil
	}
}

// applyBranch returns st with any active local marks overlaid onto its PullRequests
// without mutating st's backing slice or the overlay state.
func (o *localOverlay) applyBranch(st BranchPullRequests, now time.Time) BranchPullRequests {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 || len(st.PullRequests) == 0 {
		return st
	}
	var cloned []PullRequest
	for i, p := range st.PullRequests {
		patched, changed := applyMarksToPR(p, o.marks, now)
		if !changed {
			continue
		}
		if cloned == nil {
			cloned = slices.Clone(st.PullRequests)
		}
		cloned[i] = patched
	}
	if cloned != nil {
		st.PullRequests = cloned
	}
	return st
}

// applyPullRequest returns p with any active local mark overlaid.
func (o *localOverlay) applyPullRequest(p PullRequest, now time.Time) PullRequest {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.marks) == 0 {
		return p
	}
	patched, _ := applyMarksToPR(p, o.marks, now)
	return patched
}

// applyMarksToPR overlays any unexpired mark matching p.
func applyMarksToPR(p PullRequest, marks map[fullKey]localMark, now time.Time) (PullRequest, bool) {
	for k, m := range marks {
		if !samePullRequest(p, k, m.id()) {
			continue
		}
		changed := false
		if m.state != "" && now.Sub(m.stateAt) < mergeMarkTTL {
			if p.State != m.state {
				p.State = m.state
				changed = true
			}
			if m.state == PullRequestMerged && p.MergedAt.IsZero() && !m.pr.MergedAt.IsZero() {
				p.MergedAt = m.pr.MergedAt
				changed = true
			}
		}
		if m.draft != nil && now.Sub(m.draftAt) < mergeMarkTTL {
			if p.Draft != *m.draft {
				p.Draft = *m.draft
				changed = true
			}
			if m.mergeState != "" && p.MergeStateStatus != m.mergeState {
				p.MergeStateStatus = m.mergeState
				changed = true
			}
		}
		if m.reviewDecision != "" && now.Sub(m.reviewDecisionAt) < mergeMarkTTL {
			if p.ReviewDecision != m.reviewDecision {
				p.ReviewDecision = m.reviewDecision
				changed = true
			}
		}
		if changed && !m.updatedAt.IsZero() && m.updatedAt.After(p.UpdatedAt) {
			p.UpdatedAt = m.updatedAt
		}
		return p, changed
	}
	return p, false
}

// overlayDashboard applies marks onto d without mutating d's slices, returning the
// overlaid dashboard, the remaining unconfirmed marks, and the sorted keys whose marks
// are completely done (confirmed by the searches or expired).
func overlayDashboard(d Dashboard, marks map[fullKey]localMark, now time.Time) (Dashboard, map[fullKey]localMark, []fullKey) {
	var done []fullKey
	if d.Disabled {
		for k := range marks {
			done = append(done, k)
		}
		slices.SortFunc(done, compareFullKey)
		return d, nil, done
	}
	remaining := make(map[fullKey]localMark, len(marks))
	for k, m := range marks {
		is := func(p PullRequest) bool { return samePullRequest(p, k, m.id()) }
		inAuthored := slices.ContainsFunc(d.Authored, is)
		inReview := slices.ContainsFunc(d.ReviewRequested, is)
		inReviewed := slices.ContainsFunc(d.Reviewed, is)
		inOpen := inAuthored || inReview || inReviewed
		inMerged := slices.ContainsFunc(d.RecentlyMerged, is)

		drop := func(list []PullRequest, total *int) []PullRequest {
			n := len(list)
			if !slices.ContainsFunc(list, is) {
				return list
			}
			list = slices.DeleteFunc(slices.Clone(list), is)
			*total = max(0, *total-(n-len(list)))
			return list
		}

		// 1. State transition (merged / closed / reopened).
		if m.state != "" {
			if now.Sub(m.stateAt) >= mergeMarkTTL {
				m.state, m.stateAt = "", time.Time{}
			} else {
				switch m.state {
				case PullRequestMerged:
					if inMerged && !inOpen {
						m.state, m.stateAt = "", time.Time{}
					} else if m.wasInDashboard || inOpen {
						d.Authored = drop(d.Authored, &d.AuthoredTotal)
						d.ReviewRequested = drop(d.ReviewRequested, &d.ReviewRequestedTotal)
						d.Reviewed = drop(d.Reviewed, &d.ReviewedTotal)
						if !inMerged && (m.pr.ID != "" || m.pr.Number > 0) {
							d.RecentlyMerged = append([]PullRequest{m.pr}, d.RecentlyMerged...)
							d.RecentlyMergedTotal++
						}
						inOpen = false
					}
				case PullRequestClosed:
					if !inOpen && m.wasInDashboard {
						m.state, m.stateAt = "", time.Time{}
					} else if inOpen {
						d.Authored = drop(d.Authored, &d.AuthoredTotal)
						d.ReviewRequested = drop(d.ReviewRequested, &d.ReviewRequestedTotal)
						d.Reviewed = drop(d.Reviewed, &d.ReviewedTotal)
						inOpen = false
					}
				case PullRequestOpen:
					if inOpen {
						m.state, m.stateAt = "", time.Time{}
					} else if !d.FetchedAt.IsZero() && (m.pr.ID != "" || m.pr.Number > 0) {
						switch m.originSection {
						case sectionAuthored:
							d.Authored = append([]PullRequest{m.pr}, d.Authored...)
							d.AuthoredTotal++
							inOpen = true
						case sectionReview:
							d.ReviewRequested = append([]PullRequest{m.pr}, d.ReviewRequested...)
							d.ReviewRequestedTotal++
							inOpen = true
						case sectionReviewed:
							d.Reviewed = append([]PullRequest{m.pr}, d.Reviewed...)
							d.ReviewedTotal++
							inOpen = true
						}
					}
				}
			}
		}

		// Helper to check if every open dashboard occurrence of k satisfies pred, and to
		// patch every open dashboard occurrence of k in place (cloning modified slices).
		allOpenMatch := func(pred func(PullRequest) bool) (found, all bool) {
			all = true
			for _, list := range [][]PullRequest{d.Authored, d.ReviewRequested, d.Reviewed} {
				for _, p := range list {
					if is(p) {
						found = true
						if !pred(p) {
							all = false
						}
					}
				}
			}
			return found, all
		}
		patchOpen := func(fn func(*PullRequest)) {
			patchList := func(list []PullRequest) []PullRequest {
				var out []PullRequest
				for i, p := range list {
					if !is(p) {
						continue
					}
					if out == nil {
						out = slices.Clone(list)
					}
					fn(&out[i])
				}
				if out != nil {
					return out
				}
				return list
			}
			d.Authored = patchList(d.Authored)
			d.ReviewRequested = patchList(d.ReviewRequested)
			d.Reviewed = patchList(d.Reviewed)
		}

		// 2. Draft toggle.
		if m.draft != nil {
			if now.Sub(m.draftAt) >= mergeMarkTTL {
				m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
			} else {
				found, ok := allOpenMatch(func(p PullRequest) bool { return p.Draft == *m.draft })
				switch {
				case found && ok:
					m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
				case !found && m.wasInDashboard && m.state == "":
					m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
				case found:
					want := *m.draft
					ms := m.mergeState
					up := m.updatedAt
					patchOpen(func(p *PullRequest) {
						p.Draft = want
						if ms != "" {
							p.MergeStateStatus = ms
						}
						advanceUpdatedAt(&p.UpdatedAt, up)
					})
				}
			}
		}

		// 3. Review decision.
		if m.reviewDecision != "" {
			if now.Sub(m.reviewDecisionAt) >= mergeMarkTTL {
				m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
			} else {
				found, ok := allOpenMatch(func(p PullRequest) bool { return p.ReviewDecision == m.reviewDecision })
				switch {
				case found && ok:
					m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
				case !found && m.wasInDashboard && m.state == "":
					m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
				case found:
					dec := m.reviewDecision
					up := m.updatedAt
					patchOpen(func(p *PullRequest) {
						p.ReviewDecision = dec
						advanceUpdatedAt(&p.UpdatedAt, up)
					})
				}
			}
		}

		if m.empty() {
			done = append(done, k)
		} else {
			remaining[k] = m
		}
	}
	slices.SortFunc(done, compareFullKey)
	return d, remaining, done
}

// overlayProjects applies active local marks onto ProjectPullRequests without mutating
// the input slices.
func overlayProjects(p ProjectPullRequests, marks map[fullKey]localMark, now time.Time) ProjectPullRequests {
	if len(marks) == 0 {
		return p
	}
	for k, m := range marks {
		is := func(pr PullRequest) bool { return samePullRequest(pr, k, m.id()) }
		if m.state != "" && now.Sub(m.stateAt) < mergeMarkTTL {
			switch m.state {
			case PullRequestMerged:
				if slices.ContainsFunc(p.Open.PullRequests, is) {
					n := len(p.Open.PullRequests)
					p.Open.PullRequests = slices.DeleteFunc(slices.Clone(p.Open.PullRequests), is)
					p.Open.Total = max(0, p.Open.Total-(n-len(p.Open.PullRequests)))
					if !slices.ContainsFunc(p.Merged.PullRequests, is) && (m.pr.ID != "" || m.pr.Number > 0) {
						p.Merged.PullRequests = append([]PullRequest{m.pr}, p.Merged.PullRequests...)
						p.Merged.Total++
					}
				}
			case PullRequestClosed:
				if slices.ContainsFunc(p.Open.PullRequests, is) {
					n := len(p.Open.PullRequests)
					p.Open.PullRequests = slices.DeleteFunc(slices.Clone(p.Open.PullRequests), is)
					p.Open.Total = max(0, p.Open.Total-(n-len(p.Open.PullRequests)))
				}
			}
		}
		if (m.draft != nil && now.Sub(m.draftAt) < mergeMarkTTL) || (m.reviewDecision != "" && now.Sub(m.reviewDecisionAt) < mergeMarkTTL) {
			var out []PullRequest
			for i, pr := range p.Open.PullRequests {
				if !is(pr) {
					continue
				}
				if out == nil {
					out = slices.Clone(p.Open.PullRequests)
				}
				if m.draft != nil && now.Sub(m.draftAt) < mergeMarkTTL {
					out[i].Draft = *m.draft
					if m.mergeState != "" {
						out[i].MergeStateStatus = m.mergeState
					}
				}
				if m.reviewDecision != "" && now.Sub(m.reviewDecisionAt) < mergeMarkTTL {
					out[i].ReviewDecision = m.reviewDecision
				}
				advanceUpdatedAt(&out[i].UpdatedAt, m.updatedAt)
			}
			if out != nil {
				p.Open.PullRequests = out
			}
		}
	}
	return p
}

func compareFullKey(a, b fullKey) int {
	return cmp.Or(cmp.Compare(a.slug, b.slug), cmp.Compare(a.number, b.number))
}

// findPullRequestSection is k in d's lists, the open ones first, along with its section name.
func findPullRequestSection(d Dashboard, k fullKey) (PullRequest, string, bool) {
	for _, s := range []struct {
		name string
		list []PullRequest
	}{
		{sectionAuthored, d.Authored},
		{sectionReview, d.ReviewRequested},
		{sectionReviewed, d.Reviewed},
		{sectionMerged, d.RecentlyMerged},
	} {
		if i := slices.IndexFunc(s.list, func(p PullRequest) bool { return samePullRequest(p, k, "") }); i >= 0 {
			return s.list[i], s.name, true
		}
	}
	return PullRequest{}, "", false
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

// applyLocalMark records a local mutation mark for k, updates the published Snapshot's
// Dashboard and Projects immediately, refreshes summaries, and announces DashboardUpdated
// and any affected BranchPullRequestsUpdated.
func (s *Store) applyLocalMark(k fullKey, edit func(m *localMark, found PullRequest, section string)) {
	now := s.opts.Now()
	var fallback PullRequest
	if e, ok := s.full.entry(k); ok {
		fallback = e.d.PullRequest
	} else if p, ok := s.summaries.get(k); ok {
		fallback = p
	}
	var dashChanged, projChanged bool
	s.updateSnapshot(func(n *Snapshot) {
		n.Dashboard, n.Projects, dashChanged, projChanged = s.localShown.record(k, n.Dashboard, n.Projects, fallback, now, edit)
	})
	snap := s.Snapshot()
	if dashChanged {
		s.summaries.putDashboard(snap, snap.Dashboard)
	}
	if projChanged {
		s.summaries.putProjects(snap, snap.Projects)
	}
	if dashChanged || projChanged {
		publish(s, DashboardUpdated{FetchedAt: snap.Dashboard.FetchedAt})
	}
	if p, ok := s.summaries.get(k); ok {
		if patched := s.localShown.applyPullRequest(p, now); !samePullRequestValue(p, patched) {
			s.summaries.put(k, patched)
		}
	}
	// Notify any cached branch list containing k so BranchPullRequests readers re-read the
	// overlaid state immediately without waiting for the next poll.
	for _, u := range s.branchesMatching(k, fallback.ID) {
		publish(s, BranchPullRequestsUpdated{Slug: u.slug, HeadRef: u.head, FetchedAt: u.fetchedAt})
	}
}

type matchedBranch struct {
	slug, head string
	fetchedAt  time.Time
}

func (s *Store) branchesMatching(k fullKey, id string) []matchedBranch {
	s.branches.mu.Lock()
	defer s.branches.mu.Unlock()
	var out []matchedBranch
	for bk, st := range s.branches.m {
		if slices.ContainsFunc(st.PullRequests, func(p PullRequest) bool { return samePullRequest(p, k, id) }) {
			out = append(out, matchedBranch{slug: bk.slug, head: bk.head, fetchedAt: st.FetchedAt})
		}
	}
	return out
}

// markMerged shows the merge of k in the published lists at once.
func (s *Store) markMerged(k fullKey) {
	s.markMergedAt(k, time.Time{}, time.Time{})
}

// markMergedAt shows the merge of k in the published lists at once using GitHub's
// timestamps when available.
func (s *Store) markMergedAt(k fullKey, mergedAt, updatedAt time.Time) {
	now := s.opts.Now()
	if mergedAt.IsZero() {
		mergedAt = now
	}
	s.applyLocalMark(k, func(m *localMark, found PullRequest, _ string) {
		found.State = PullRequestMerged
		found.MergedAt = mergedAt
		advanceUpdatedAt(&found.UpdatedAt, updatedAt)
		m.state, m.stateAt, m.pr = PullRequestMerged, now, found
		m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
		m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
		advanceUpdatedAt(&m.updatedAt, updatedAt)
	})
	s.log.Info("gh merge shown before the searches have it", "pr", k.String())
}

// markClosed shows a close (closed=true) or reopen (closed=false) of k at once.
func (s *Store) markClosed(k fullKey, state PullRequestState, updatedAt time.Time) {
	now := s.opts.Now()
	viewer := s.viewerLogin()
	s.applyLocalMark(k, func(m *localMark, found PullRequest, section string) {
		found.State = state
		advanceUpdatedAt(&found.UpdatedAt, updatedAt)
		m.state, m.stateAt, m.pr = state, now, found
		if state == PullRequestOpen && m.originSection == "" && viewer != "" && strings.EqualFold(found.Author, viewer) {
			m.originSection = sectionAuthored
		}
		if state != PullRequestOpen {
			m.draft, m.draftAt, m.mergeState = nil, time.Time{}, ""
			m.reviewDecision, m.reviewDecisionAt = "", time.Time{}
		}
		advanceUpdatedAt(&m.updatedAt, updatedAt)
	})
}

// markDraft shows a draft/ready toggle of k at once.
func (s *Store) markDraft(k fullKey, draft bool, mergeState MergeStateStatus, updatedAt time.Time) {
	now := s.opts.Now()
	s.applyLocalMark(k, func(m *localMark, found PullRequest, _ string) {
		d := draft
		m.draft, m.draftAt, m.mergeState = &d, now, mergeState
		if m.pr.ID == "" && found.ID != "" {
			m.pr = found
		}
		if m.pr.ID != "" {
			m.pr.Draft = draft
			if mergeState != "" {
				m.pr.MergeStateStatus = mergeState
			}
		}
		advanceUpdatedAt(&m.updatedAt, updatedAt)
	})
}

// markReviewDecision shows a review decision change on k at once.
func (s *Store) markReviewDecision(k fullKey, decision ReviewDecision, updatedAt time.Time) {
	if decision == "" {
		return
	}
	now := s.opts.Now()
	s.applyLocalMark(k, func(m *localMark, found PullRequest, _ string) {
		m.reviewDecision, m.reviewDecisionAt = decision, now
		if m.pr.ID == "" && found.ID != "" {
			m.pr = found
		}
		if m.pr.ID != "" {
			m.pr.ReviewDecision = decision
		}
		advanceUpdatedAt(&m.updatedAt, updatedAt)
	})
}
