package thread

import (
	"cmp"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Wake subscriptions to pull requests (docs/notes/gh-events-3-pr-wake.md). The target
// is "owner/name#123" (lower-case slug; ParsePullRequestTarget also takes a pull
// request URL). The thread store does not know the GitHub store: the daemon looks pull
// requests up in its cache for it (Options.PullRequest), tells it every change a poll
// saw (Manager.PullRequestChanged, from the GitHub store's PullRequestChanged), and
// keeps the watched pull requests in the poll (Options.WatchPullRequests). A poll
// coalesces a pull request's changes into one event, so a subscription fires at most
// once per poll, with every change that matched. Latency is the GitHub poll interval.

// TargetPullRequest is a pull request target ("owner/name#123").
const TargetPullRequest TargetKind = "pull_request"

// Pull request conditions. Each fires on a change a poll saw (edge-triggered); the
// checks conditions and merged/closed also fire at subscribe time when the cached pull
// request already meets them.
const (
	// CondChecksDone: every check on the head completed, whatever the result (the
	// rollup has checks and none pending).
	CondChecksDone Condition = "checks_done"
	// CondChecksFailed: the rollup became FAILURE or ERROR (checks may still run).
	CondChecksFailed Condition = "checks_failed"
	// CondChecksPassed: the rollup became SUCCESS.
	CondChecksPassed Condition = "checks_passed"
	// CondReview: a review was submitted (the reviews count rose) or the review
	// decision changed.
	CondReview Condition = "review"
	// CondComment: the comments count rose.
	CondComment Condition = "comment"
	// CondReviewRequested: a review was requested.
	CondReviewRequested Condition = "review_requested"
	// CondHeadPushed: the head commit moved.
	CondHeadPushed Condition = "head_pushed"
	// CondMerged: merged. The subscription goes once it fired, even with Repeat.
	CondMerged Condition = "merged"
	// CondClosed: closed without merging. Goes once it fired, even with Repeat.
	CondClosed Condition = "closed"
	// CondChanged: any change the poll reports.
	CondChanged Condition = "changed"
)

// PullRequestConditions are the conditions a pull request target takes; the first is
// the default.
var PullRequestConditions = []Condition{
	CondChecksDone, CondChecksFailed, CondChecksPassed, CondReview, CondComment, CondReviewRequested,
	CondHeadPushed, CondMerged, CondClosed, CondChanged,
}

// PRChecks is a head commit's check rollup. State is GitHub's (SUCCESS, FAILURE, ERROR,
// PENDING, EXPECTED), "" without checks.
type PRChecks struct {
	State                                   string
	Total, Passed, Failed, Pending, Skipped int
}

// PRReview is one reviewer's latest review; State is GitHub's (APPROVED, …).
type PRReview struct {
	Author, State string
	SubmittedAt   time.Time
}

// PullRequestInfo is a pull request as a wake tells it: counts and states, never a
// body. The daemon maps the GitHub store's summary into it.
type PullRequestInfo struct {
	Slug   string // "owner/name", lower case
	Number int
	URL    string
	Title  string
	// State is "open", "merged" or "closed".
	State            string
	HeadSHA, HeadRef string
	Draft            bool
	// ReviewDecision is GitHub's (APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED), "" for
	// none.
	ReviewDecision    string
	Checks            PRChecks
	Reviews, Comments int
	ReviewRequests    []string
	LatestReviews     []PRReview
	MergedAt          time.Time
}

// Target is the pull request's target id: "owner/name#123".
func (p PullRequestInfo) Target() string { return p.Slug + "#" + strconv.Itoa(p.Number) }

// PRChangeKind names a change; the values are the GitHub store's ChangeKind's.
type PRChangeKind string

// Change kinds.
const (
	PRChangeAppeared        PRChangeKind = "appeared"
	PRChangeMerged          PRChangeKind = "merged"
	PRChangeClosed          PRChangeKind = "closed"
	PRChangeReopened        PRChangeKind = "reopened"
	PRChangeHeadPushed      PRChangeKind = "head_pushed"
	PRChangeChecks          PRChangeKind = "checks"
	PRChangeReviewDecision  PRChangeKind = "review_decision"
	PRChangeReviews         PRChangeKind = "reviews"
	PRChangeComments        PRChangeKind = "comments"
	PRChangeReviewRequested PRChangeKind = "review_requested"
	PRChangeDraft           PRChangeKind = "draft"
	PRChangeTitle           PRChangeKind = "title"
)

// PullRequestChange is one change; Kind says which fields apply (as the GitHub store's
// Change). States are "open", "merged", "closed".
type PullRequestChange struct {
	Kind                                 PRChangeKind
	OldState, NewState                   string
	OldHeadSHA, NewHeadSHA               string
	OldChecks, NewChecks                 PRChecks
	OldReviewDecision, NewReviewDecision string
	OldCount, NewCount                   int
	Requested                            []string
	ViewerRequested                      bool
	OldDraft, NewDraft                   bool
	OldTitle, NewTitle                   string
}

// PullRequestEvent is what one poll saw change about one pull request.
type PullRequestEvent struct {
	PullRequest PullRequestInfo // after the change
	Changes     []PullRequestChange
}

func (e PullRequestEvent) has(kinds ...PRChangeKind) bool {
	return slices.ContainsFunc(e.Changes, func(c PullRequestChange) bool { return slices.Contains(kinds, c.Kind) })
}

var (
	// Enterprise managed users and their organisations may carry an "_shortcode" suffix.
	prOwner = `([A-Za-z0-9][A-Za-z0-9_-]{0,38})`
	prName  = `([A-Za-z0-9._-]{1,100})`
	// "owner/name#123".
	prRefRE = regexp.MustCompile(`^` + prOwner + `/` + prName + `#([0-9]{1,9})$`)
	// "https://github.com/owner/name/pull/123", with or without the scheme, and with
	// whatever follows (/files, #discussion_r1, ?w=1).
	prURLRE = regexp.MustCompile(`^(?:https?://)?(?:www\.)?github\.com/` + prOwner + `/` + prName + `/pull/([0-9]{1,9})(?:[/?#].*)?$`)
)

// ParsePullRequestTarget normalises "owner/name#123" or a GitHub pull request URL to
// "owner/name#123" with the slug in lower case.
func ParsePullRequestTarget(s string) (string, error) {
	s = strings.TrimSpace(s)
	m := prRefRE.FindStringSubmatch(s)
	if m == nil {
		m = prURLRE.FindStringSubmatch(s)
	}
	if m == nil || m[2] == "." || m[2] == ".." {
		return "", fmt.Errorf("%w: pull request %q (want owner/name#123 or a github.com pull request URL)", ErrInvalidArgument, s)
	}
	n, err := strconv.Atoi(m[3])
	if err != nil || n <= 0 {
		return "", fmt.Errorf("%w: pull request number in %q", ErrInvalidArgument, s)
	}
	return strings.ToLower(m[1]+"/"+m[2]) + "#" + strconv.Itoa(n), nil
}

// checksMeet reports whether a rollup meets a checks condition.
func checksMeet(c Condition, r PRChecks) bool {
	switch c {
	case CondChecksDone:
		return r.Total > 0 && r.Pending == 0 && r.State != "PENDING" && r.State != "EXPECTED"
	case CondChecksPassed:
		return r.State == "SUCCESS"
	case CondChecksFailed:
		return r.State == "FAILURE" || r.State == "ERROR"
	}
	return false
}

// prAlreadyMet reports whether a cached pull request meets c at subscribe time: only
// the checks conditions and merged/closed have a state to meet.
func prAlreadyMet(c Condition, p PullRequestInfo) bool {
	switch c {
	case CondMerged:
		return p.State == "merged"
	case CondClosed:
		return p.State == "closed"
	case CondChecksDone, CondChecksPassed, CondChecksFailed:
		return p.State == "open" && checksMeet(c, p.Checks)
	}
	return false
}

// prTerminal reports whether a subscription with condition c goes once it fired, even
// with Repeat.
func prTerminal(c Condition) bool { return c == CondMerged || c == CondClosed }

// matchPullRequest returns the changes of e that fire condition c, nil when it does
// not fire. The checks conditions fire on an open pull request when the rollup after
// the event meets them and the rollup before did not; a new head (or a pull request
// first seen) has no rollup before. A pull request first seen already merged or closed fires merged or closed.
func matchPullRequest(c Condition, e PullRequestEvent) []PullRequestChange {
	pick := func(kinds ...PRChangeKind) []PullRequestChange {
		var out []PullRequestChange
		for _, ch := range e.Changes {
			if slices.Contains(kinds, ch.Kind) {
				out = append(out, ch)
			}
		}
		return out
	}
	switch c {
	case CondChecksDone, CondChecksPassed, CondChecksFailed:
		cur := e.PullRequest.Checks
		prev, fresh := cur, e.has(PRChangeHeadPushed, PRChangeAppeared)
		for _, ch := range e.Changes {
			if ch.Kind == PRChangeChecks {
				cur, prev = ch.NewChecks, ch.OldChecks
			}
		}
		if e.PullRequest.State != "open" || !checksMeet(c, cur) || (!fresh && checksMeet(c, prev)) {
			return nil
		}
		return pick(PRChangeAppeared, PRChangeHeadPushed, PRChangeChecks)
	case CondReview:
		return pick(PRChangeReviewDecision, PRChangeReviews)
	case CondComment:
		return pick(PRChangeComments)
	case CondReviewRequested:
		return pick(PRChangeReviewRequested)
	case CondHeadPushed:
		return pick(PRChangeHeadPushed)
	case CondMerged, CondClosed:
		kind := PRChangeMerged
		if c == CondClosed {
			kind = PRChangeClosed
		}
		if out := pick(kind); out != nil {
			return out
		}
		if e.has(PRChangeAppeared) && e.PullRequest.State == string(kind) {
			return pick(PRChangeAppeared)
		}
		return nil
	case CondChanged:
		return slices.Clone(e.Changes)
	}
	return nil
}

// PullRequestChanged fires the subscriptions to e's pull request that its changes
// meet. The daemon calls it for every PullRequestChanged of the GitHub store. A one-shot
// goes once it fired, so do merged and closed; every subscription to a merged pull
// request goes (nothing more will happen to it).
func (m *Manager) PullRequestChanged(e PullRequestEvent) {
	target := e.PullRequest.Target()
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.subs == nil {
		return
	}
	s := m.subs
	s.mu.Lock()
	defer s.mu.Unlock()
	var hit []*subRec
	for _, r := range s.byID {
		if r.s.TargetKind == TargetPullRequest && r.s.TargetID == target {
			hit = append(hit, r)
		}
	}
	slices.SortFunc(hit, func(a, b *subRec) int {
		return cmp.Or(a.s.CreatedAt.Compare(b.s.CreatedAt), strings.Compare(a.s.ID, b.s.ID))
	})
	merged := e.PullRequest.State == "merged" || e.has(PRChangeMerged)
	var gone []string
	for _, r := range hit {
		matched := matchPullRequest(r.s.Condition, e)
		fired := len(matched) > 0 &&
			m.fireLocked(r, func(s Subscription, at time.Time) Message { return prWake(s, e.PullRequest, matched, at) })
		switch {
		case merged:
			gone = append(gone, r.s.ID)
		case fired && (!r.s.Repeat || prTerminal(r.s.Condition)):
			gone = append(gone, r.s.ID)
		case fired:
			s.firedLocked(r)
		}
	}
	if len(gone) > 0 {
		s.removeLocked(gone)
		if merged {
			m.log.Info("wake subscriptions to a merged pull request done", "pull_request", target, "subscriptions", gone)
		}
	}
}

// prStatusWords is a pull request's state for a listing:
// "open · checks pending (2/4) · review required", "merged".
func prStatusWords(p PullRequestInfo) string {
	if p.State != "open" {
		return p.State
	}
	words := []string{"open"}
	if p.Draft {
		words = append(words, "draft")
	}
	c := p.Checks
	switch {
	case c.Total == 0 && c.State == "":
		words = append(words, "no checks")
	case checksMeet(CondChecksFailed, c):
		words = append(words, fmt.Sprintf("checks failed (%d/%d)", c.Failed, c.Total))
	case checksMeet(CondChecksPassed, c):
		words = append(words, fmt.Sprintf("checks passed (%d/%d)", c.Passed, c.Total))
	default:
		words = append(words, fmt.Sprintf("checks pending (%d/%d)", c.Total-c.Pending, c.Total))
	}
	if p.ReviewDecision != "" {
		words = append(words, strings.ToLower(strings.ReplaceAll(p.ReviewDecision, "_", " ")))
	}
	return strings.Join(words, " · ")
}

// prTargetName is a pull request's name for a listing: "owner/name#12 Title".
func prTargetName(p PullRequestInfo) string {
	return strings.TrimSpace(p.Target() + " " + p.Title)
}
