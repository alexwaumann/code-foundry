package gh

import (
	"cmp"
	"slices"
	"strings"
)

// Granular pull request events (docs/notes/gh-events-1-pull-request-changed.md). The
// coarse events (DashboardUpdated, BranchPullRequestsUpdated, ...) say "re-read"; a
// PullRequestChanged says what changed about one pull request. The poll derives it by
// comparing each pull request's summary before and after, so it costs no request.

// ChangeKind names one thing that changed about a pull request. The values are stable:
// clients (plugins, thread wake subscriptions) match on them.
type ChangeKind string

// Change kinds.
const (
	// ChangeAppeared: the pull request is in the viewer's scope (a dashboard list or a
	// watched branch) for the first time. Never after a restart for what the cache
	// held, and never for the lists a poll fetches for the first time (a new install,
	// dashboards turned back on, a branch watched for the first time): those are
	// recorded silently. With nothing to compare, the only change that can come with
	// it is ChangeReviewRequested (it is in the viewer's review-requested list).
	ChangeAppeared ChangeKind = "appeared"
	// ChangeMerged, ChangeClosed, ChangeReopened: the state moved (OldState, NewState).
	ChangeMerged   ChangeKind = "merged"
	ChangeClosed   ChangeKind = "closed"
	ChangeReopened ChangeKind = "reopened"
	// ChangeHeadPushed: the head commit moved (a push or a force push; OldHeadSHA,
	// NewHeadSHA).
	ChangeHeadPushed ChangeKind = "head_pushed"
	// ChangeChecks: the head commit's check rollup changed, its state or any count
	// (OldChecks, NewChecks). A push usually brings one too: the new head's checks.
	ChangeChecks ChangeKind = "checks"
	// ChangeReviewDecision: GitHub's review decision moved (OldReviewDecision,
	// NewReviewDecision). Open pull requests only.
	ChangeReviewDecision ChangeKind = "review_decision"
	// ChangeReviews: the submitted reviews count rose (OldCount, NewCount). Open pull
	// requests only.
	ChangeReviews ChangeKind = "reviews"
	// ChangeComments: the issue and review comments count rose (OldCount, NewCount).
	// Open pull requests only.
	ChangeComments ChangeKind = "comments"
	// ChangeReviewRequested: a review was requested (Requested: the new logins and
	// "org/team" slugs; Viewer when the viewer is asked).
	ChangeReviewRequested ChangeKind = "review_requested"
	// ChangeDraft: draft toggled (OldDraft, NewDraft).
	ChangeDraft ChangeKind = "draft"
	// ChangeTitle: the title changed (OldTitle, NewTitle).
	ChangeTitle ChangeKind = "title"
)

// ChangeKinds lists every kind in the order a PullRequestChanged lists its changes.
var ChangeKinds = []ChangeKind{
	ChangeAppeared, ChangeMerged, ChangeClosed, ChangeReopened, ChangeHeadPushed, ChangeChecks,
	ChangeReviewDecision, ChangeReviews, ChangeComments, ChangeReviewRequested, ChangeDraft, ChangeTitle,
}

// Change is one change of a pull request. Kind says which of the other fields apply;
// the rest are zero. Counts only: never a comment's or a review's text.
type Change struct {
	Kind ChangeKind
	// merged, closed, reopened.
	OldState, NewState PullRequestState
	// head_pushed.
	OldHeadSHA, NewHeadSHA string
	// checks.
	OldChecks, NewChecks CheckRollup
	// review_decision.
	OldReviewDecision, NewReviewDecision ReviewDecision
	// reviews, comments.
	OldCount, NewCount int
	// review_requested: the logins and "org/team" slugs newly requested. Viewer is set
	// when the viewer's login is among them or the pull request entered the viewer's
	// review-requested list (which covers a request through a team; Requested may then
	// be empty when only the list said so).
	Requested []string
	Viewer    bool
	// draft.
	OldDraft, NewDraft bool
	// title.
	OldTitle, NewTitle string
}

// PullRequestChanged is published once per pull request per poll when anything in
// Changes happened to it, after the coarse events of that poll. Latency is the poll
// interval. Every pull request the poll saw counts (the viewer's dashboards and the
// watched branches), each at most once however many lists hold it.
type PullRequestChanged struct {
	// Slug is the repository ("owner/name", lower case).
	Slug   string
	Number int
	URL    string
	// HeadRef is the head branch.
	HeadRef string
	// PullRequest is the summary after the change (Partial only when the poll knows
	// only its fingerprint, which never happens with ChangeAppeared).
	PullRequest PullRequest
	// Changes in ChangeKinds order; never empty.
	Changes []Change
}

// Has reports whether e has a change of one of kinds.
func (e PullRequestChanged) Has(kinds ...ChangeKind) bool {
	return slices.ContainsFunc(e.Changes, func(c Change) bool { return slices.Contains(kinds, c.Kind) })
}

// prList is one list of pull requests a poll refreshed: what it held before the poll
// and what it holds now.
type prList struct {
	prev, next []PullRequest
	// slug and head fill a placeholder's repository and head branch (a watched branch's
	// list); empty for the dashboards.
	slug, head string
	// checks is set when the poll's fingerprints for the list carry the check rollup
	// (every list but the recently merged search), so a placeholder's Checks are known.
	checks bool
	// baseline is set when prev is a state the list was polled into before (in this
	// run or loaded from the cache). A list without one announces nothing as appeared.
	baseline bool
	// reviewRequested marks the viewer's review-requested dashboard.
	reviewRequested bool
}

// prSide is a pull request as one side of the comparison holds it.
type prSide struct {
	pr PullRequest
	// checks is set when pr.Checks is known (a detail, or a fingerprint with the rollup).
	checks bool
}

// prChanges compares the lists a poll refreshed and returns the events, sorted by
// repository and number. known is the store's state before the poll (every list,
// including the ones this poll did not refresh): a pull request new to the refreshed
// lists but known elsewhere is compared with that, not announced. pending holds the
// pull requests whose appearance waits for their detail (a placeholder is announced
// once a later poll fills it); prChanges updates it. viewer is the viewer's login.
func prChanges(lists []prList, known map[string]PullRequest, pending map[string]bool, viewer string) []PullRequestChanged {
	index := func(next bool) (map[string]prSide, []string) {
		idx := map[string]prSide{}
		var order []string
		for _, l := range lists {
			prs := l.prev
			if next {
				prs = l.next
			}
			for _, p := range prs {
				if p.ID == "" {
					continue
				}
				if _, ok := idx[p.ID]; ok {
					continue // the first list wins: lists come freshest and richest first
				}
				p.Repo = cmp.Or(p.Repo, l.slug)
				p.HeadRef = cmp.Or(p.HeadRef, l.head)
				idx[p.ID] = prSide{pr: p, checks: !p.Partial || l.checks}
				order = append(order, p.ID)
			}
		}
		return idx, order
	}
	prev, _ := index(false)
	next, order := index(true)
	baselined, prevRR, nextRR := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, l := range lists {
		if !l.baseline {
			continue
		}
		for _, p := range l.next {
			baselined[p.ID] = true
			if l.reviewRequested {
				nextRR[p.ID] = true
			}
		}
		if l.reviewRequested {
			for _, p := range l.prev {
				prevRR[p.ID] = true
			}
		}
	}
	for id := range pending {
		if _, ok := next[id]; !ok {
			delete(pending, id) // left before its detail came
		}
	}

	var out []PullRequestChanged
	for _, id := range order {
		n := next[id]
		p, had := prev[id]
		if !had {
			if k, ok := known[id]; ok {
				p, had = prSide{pr: k, checks: !k.Partial}, true
			}
		}
		var changes []Change
		switch {
		case !had && !baselined[id]:
			continue // a list's first poll: recorded, not announced
		case !had && n.pr.Partial, pending[id] && n.pr.Partial:
			pending[id] = true // announced once the detail comes
			continue
		case !had, pending[id]:
			delete(pending, id)
			changes = []Change{{Kind: ChangeAppeared}}
		default:
			changes = diffPullRequest(p, n, viewer)
		}
		if nextRR[id] && !prevRR[id] {
			changes = viewerRequested(changes)
		}
		if len(changes) == 0 {
			continue
		}
		slices.SortStableFunc(changes, func(a, b Change) int {
			return slices.Index(ChangeKinds, a.Kind) - slices.Index(ChangeKinds, b.Kind)
		})
		out = append(out, PullRequestChanged{
			Slug: n.pr.Repo, Number: n.pr.Number, URL: n.pr.URL, HeadRef: n.pr.HeadRef,
			PullRequest: n.pr, Changes: changes,
		})
	}
	slices.SortFunc(out, func(a, b PullRequestChanged) int {
		return cmp.Or(cmp.Compare(a.Slug, b.Slug), cmp.Compare(a.Number, b.Number))
	})
	return out
}

// viewerRequested records that the pull request entered the viewer's review-requested
// list: the review_requested change gets Viewer, or is added.
func viewerRequested(changes []Change) []Change {
	for i := range changes {
		if changes[i].Kind == ChangeReviewRequested {
			changes[i].Viewer = true
			return changes
		}
	}
	return append(changes, Change{Kind: ChangeReviewRequested, Viewer: true})
}

// diffPullRequest compares two summaries of one pull request, field by field where
// both sides have the field: a placeholder has only the fingerprint's (state, head,
// and the checks when its list carries them); a closed or merged pull request's summary
// has no review decision, counts or review requests.
func diffPullRequest(p, n prSide, viewer string) []Change {
	a, b := p.pr, n.pr
	var out []Change
	if a.State != b.State && a.State != "" && b.State != "" {
		kind := ChangeClosed
		switch b.State {
		case PullRequestMerged:
			kind = ChangeMerged
		case PullRequestOpen:
			kind = ChangeReopened
		}
		out = append(out, Change{Kind: kind, OldState: a.State, NewState: b.State})
	}
	if a.HeadSHA != b.HeadSHA && a.HeadSHA != "" && b.HeadSHA != "" {
		out = append(out, Change{Kind: ChangeHeadPushed, OldHeadSHA: a.HeadSHA, NewHeadSHA: b.HeadSHA})
	}
	if p.checks && n.checks && a.Checks != b.Checks {
		out = append(out, Change{Kind: ChangeChecks, OldChecks: a.Checks, NewChecks: b.Checks})
	}
	if !a.Partial && !b.Partial {
		if a.Draft != b.Draft {
			out = append(out, Change{Kind: ChangeDraft, OldDraft: a.Draft, NewDraft: b.Draft})
		}
		if a.Title != b.Title {
			out = append(out, Change{Kind: ChangeTitle, OldTitle: a.Title, NewTitle: b.Title})
		}
	}
	if !openDetail(a) || !openDetail(b) {
		return out
	}
	if a.ReviewDecision != b.ReviewDecision {
		out = append(out, Change{Kind: ChangeReviewDecision, OldReviewDecision: a.ReviewDecision, NewReviewDecision: b.ReviewDecision})
	}
	if b.Reviews > a.Reviews {
		out = append(out, Change{Kind: ChangeReviews, OldCount: a.Reviews, NewCount: b.Reviews})
	}
	if b.Comments > a.Comments {
		out = append(out, Change{Kind: ChangeComments, OldCount: a.Comments, NewCount: b.Comments})
	}
	var added []string
	for _, r := range b.ReviewRequests {
		if !slices.ContainsFunc(a.ReviewRequests, func(x string) bool { return strings.EqualFold(x, r) }) {
			added = append(added, r)
		}
	}
	if len(added) > 0 {
		out = append(out, Change{Kind: ChangeReviewRequested, Requested: added,
			Viewer: viewer != "" && slices.ContainsFunc(added, func(x string) bool { return strings.EqualFold(x, viewer) })})
	}
	return out
}

// openDetail reports whether p carries an open pull request's detail fields (review
// decision, counts, review requests): it is open, not a placeholder, and was not
// stored with the summary only (it was closed when fetched; see needsDetail).
func openDetail(p PullRequest) bool {
	return !p.Partial && p.State == PullRequestOpen && (p.Mergeable != "" || p.MergeStateStatus != "")
}
