package thread

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The wake message of a pull request subscription (subscriptions_pr.go):
//
//	[code-foundry wake] Pull request acme/web#210 "Retry backoff": checks done (4 passed, 0 failed).
//	```json
//	{ "kind": "pull_request", "subscription_id": "sub-…", "condition": "checks_done", "fired_at": "…",
//	  "pull_request": { … }, "changes": [ { "kind": "checks", "old_checks": {…}, "new_checks": {…} } ] }
//	```
//
// Counts and states only, never a review's or a comment's text.

type wakePRPayload struct {
	Kind           string         `json:"kind"`
	SubscriptionID string         `json:"subscription_id"`
	Condition      Condition      `json:"condition"`
	FiredAt        string         `json:"fired_at"`
	PullRequest    wakePR         `json:"pull_request"`
	Changes        []wakePRChange `json:"changes"`
}

type wakePR struct {
	Slug           string         `json:"slug"`
	Number         int            `json:"number"`
	URL            string         `json:"url"`
	Title          string         `json:"title"`
	State          string         `json:"state"`
	HeadSHA        string         `json:"head_sha"`
	HeadRef        string         `json:"head_ref"`
	Draft          bool           `json:"draft"`
	ReviewDecision string         `json:"review_decision"`
	Checks         wakeChecks     `json:"checks"`
	Reviews        int            `json:"reviews"`
	Comments       int            `json:"comments"`
	ReviewRequests []string       `json:"review_requests"`
	LatestReviews  []wakePRReview `json:"latest_reviews"`
	MergedAt       string         `json:"merged_at"`
}

type wakeChecks struct {
	State   string `json:"state"`
	Total   int    `json:"total"`
	Passed  int    `json:"passed"`
	Failed  int    `json:"failed"`
	Pending int    `json:"pending"`
	Skipped int    `json:"skipped"`
}

type wakePRReview struct {
	Author      string `json:"author"`
	State       string `json:"state"`
	SubmittedAt string `json:"submitted_at"`
}

// wakePRChange is one change with only its kind's fields (the names are the
// PullRequestChange proto's).
type wakePRChange struct {
	Kind              PRChangeKind `json:"kind"`
	OldState          *string      `json:"old_state,omitempty"`
	NewState          *string      `json:"new_state,omitempty"`
	OldHeadSHA        *string      `json:"old_head_sha,omitempty"`
	NewHeadSHA        *string      `json:"new_head_sha,omitempty"`
	OldChecks         *wakeChecks  `json:"old_checks,omitempty"`
	NewChecks         *wakeChecks  `json:"new_checks,omitempty"`
	OldReviewDecision *string      `json:"old_review_decision,omitempty"`
	NewReviewDecision *string      `json:"new_review_decision,omitempty"`
	OldCount          *int         `json:"old_count,omitempty"`
	NewCount          *int         `json:"new_count,omitempty"`
	Requested         *[]string    `json:"requested,omitempty"`
	ViewerRequested   *bool        `json:"viewer_requested,omitempty"`
	OldDraft          *bool        `json:"old_draft,omitempty"`
	NewDraft          *bool        `json:"new_draft,omitempty"`
	OldTitle          *string      `json:"old_title,omitempty"`
	NewTitle          *string      `json:"new_title,omitempty"`
}

func ptr[T any](v T) *T { return &v }

func wakeChecksOf(c PRChecks) wakeChecks { return wakeChecks(c) }

func wakePRChangeOf(c PullRequestChange) wakePRChange {
	w := wakePRChange{Kind: c.Kind}
	switch c.Kind {
	case PRChangeMerged, PRChangeClosed, PRChangeReopened:
		w.OldState, w.NewState = ptr(c.OldState), ptr(c.NewState)
	case PRChangeHeadPushed:
		w.OldHeadSHA, w.NewHeadSHA = ptr(c.OldHeadSHA), ptr(c.NewHeadSHA)
	case PRChangeChecks:
		w.OldChecks, w.NewChecks = ptr(wakeChecksOf(c.OldChecks)), ptr(wakeChecksOf(c.NewChecks))
	case PRChangeReviewDecision:
		w.OldReviewDecision, w.NewReviewDecision = ptr(c.OldReviewDecision), ptr(c.NewReviewDecision)
	case PRChangeReviews, PRChangeComments:
		w.OldCount, w.NewCount = ptr(c.OldCount), ptr(c.NewCount)
	case PRChangeReviewRequested:
		w.Requested, w.ViewerRequested = ptr(append([]string{}, c.Requested...)), ptr(c.ViewerRequested)
	case PRChangeDraft:
		w.OldDraft, w.NewDraft = ptr(c.OldDraft), ptr(c.NewDraft)
	case PRChangeTitle:
		w.OldTitle, w.NewTitle = ptr(c.OldTitle), ptr(c.NewTitle)
	}
	return w
}

// prWake is the wake message of sub about pull request p, fired at for changes (none
// when it fired at subscribe time).
func prWake(sub Subscription, p PullRequestInfo, changes []PullRequestChange, at time.Time) Message {
	pr := wakePR{
		Slug: p.Slug, Number: p.Number, URL: p.URL, Title: p.Title, State: p.State, HeadSHA: p.HeadSHA, HeadRef: p.HeadRef,
		Draft: p.Draft, ReviewDecision: p.ReviewDecision, Checks: wakeChecksOf(p.Checks), Reviews: p.Reviews,
		Comments: p.Comments, ReviewRequests: append([]string{}, p.ReviewRequests...), LatestReviews: []wakePRReview{},
		MergedAt: wakeTime(p.MergedAt),
	}
	for _, r := range p.LatestReviews {
		pr.LatestReviews = append(pr.LatestReviews, wakePRReview{Author: r.Author, State: r.State, SubmittedAt: wakeTime(r.SubmittedAt)})
	}
	payload := wakePRPayload{Kind: "pull_request", SubscriptionID: sub.ID, Condition: sub.Condition, FiredAt: wakeTime(at),
		PullRequest: pr, Changes: []wakePRChange{}}
	for _, c := range changes {
		payload.Changes = append(payload.Changes, wakePRChangeOf(c))
	}
	return wakeMessage(prWakeTitle(sub.Condition, p, changes), payload)
}

// prWakeTitle is a pull request wake's header without its prefix:
// `Pull request acme/web#12 "Fix login": checks done (4 passed, 0 failed).`
func prWakeTitle(c Condition, p PullRequestInfo, changes []PullRequestChange) string {
	who := "Pull request " + p.Target()
	if p.Title != "" {
		who += " " + strconv.Quote(oneLine(p.Title, maxHeaderSummary))
	}
	return who + ": " + prWhat(c, p, changes) + "."
}

// prWhat says what happened for condition c.
func prWhat(c Condition, p PullRequestInfo, changes []PullRequestChange) string {
	find := func(k PRChangeKind) (PullRequestChange, bool) {
		i := slices.IndexFunc(changes, func(x PullRequestChange) bool { return x.Kind == k })
		if i < 0 {
			return PullRequestChange{}, false
		}
		return changes[i], true
	}
	ck := p.Checks
	switch c {
	case CondChecksDone:
		s := fmt.Sprintf("checks done (%d passed, %d failed", ck.Passed, ck.Failed)
		if ck.Skipped > 0 {
			s += fmt.Sprintf(", %d skipped", ck.Skipped)
		}
		return s + ")"
	case CondChecksPassed:
		return fmt.Sprintf("checks passed (%d/%d)", ck.Passed, ck.Total)
	case CondChecksFailed:
		return fmt.Sprintf("checks failed (%d failed, %d passed, %d pending)", ck.Failed, ck.Passed, ck.Pending)
	case CondReview:
		if _, ok := find(PRChangeReviews); !ok {
			return "the review decision changed to " + cmpOrNone(p.ReviewDecision)
		}
		var detail []string
		latest := latestReview(p.LatestReviews)
		if latest.State != "" {
			detail = append(detail, latest.State+" by "+cmpOrNone(latest.Author))
		}
		if p.ReviewDecision != "" && p.ReviewDecision != latest.State {
			detail = append(detail, "review decision "+p.ReviewDecision)
		}
		if len(detail) == 0 {
			return "a review was submitted"
		}
		return "a review was submitted (" + strings.Join(detail, "; ") + ")"
	case CondComment:
		ch, _ := find(PRChangeComments)
		n := ch.NewCount - ch.OldCount
		if n == 1 {
			return fmt.Sprintf("a new comment (%d in all)", ch.NewCount)
		}
		return fmt.Sprintf("%d new comments (%d in all)", n, ch.NewCount)
	case CondReviewRequested:
		ch, _ := find(PRChangeReviewRequested)
		who := slices.Clone(ch.Requested)
		if ch.ViewerRequested && len(who) == 0 {
			who = []string{"you"}
		}
		if len(who) == 0 {
			return "a review was requested"
		}
		return "a review was requested from " + strings.Join(who, ", ")
	case CondHeadPushed:
		ch, _ := find(PRChangeHeadPushed)
		return "new commits were pushed (head " + shortSHA(ch.OldHeadSHA) + " → " + shortSHA(ch.NewHeadSHA) + ")"
	case CondMerged:
		return "merged"
	case CondClosed:
		return "closed without merging"
	}
	var kinds []string
	for _, ch := range changes {
		kinds = append(kinds, string(ch.Kind))
	}
	return "changed (" + strings.Join(kinds, ", ") + ")"
}

// latestReview is the most recently submitted review; zero when none.
func latestReview(rs []PRReview) PRReview {
	var out PRReview
	for _, r := range rs {
		if out.State == "" || r.SubmittedAt.After(out.SubmittedAt) {
			out = r
		}
	}
	return out
}

func cmpOrNone(s string) string {
	if s == "" {
		return "none"
	}
	return s
}

func shortSHA(s string) string {
	if len(s) > 7 {
		return s[:7]
	}
	return cmpOrNone(s)
}
