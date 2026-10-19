package gh

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

// openPR is a pull request with an open pull request's detail.
func openPR(id string, number int) PullRequest {
	p := fakePR(id, "o/r", number, time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC))
	p.Comments, p.Reviews, p.URL = 1, 1, fmt.Sprintf("https://github.com/o/r/pull/%d", number)
	return p
}

// summary is p as a closed or merged pull request's summary holds it.
func summary(p PullRequest, st PullRequestState) PullRequest {
	p.State = st
	p.ReviewDecision, p.Mergeable, p.MergeStateStatus = "", "", ""
	p.Comments, p.Reviews, p.LatestReviews, p.ReviewRequests = 0, 0, nil, nil
	return p
}

// placeholder is p known only by its fingerprint.
func placeholder(p PullRequest, withChecks bool) PullRequest {
	f := prFingerprint{ID: p.ID, Number: p.Number, Repo: p.Repo, UpdatedAt: p.UpdatedAt, State: p.State, HeadSHA: p.HeadSHA,
		Author: p.Author, HasChecks: withChecks}
	if withChecks {
		f.Checks = p.Checks
	}
	return f.placeholder()
}

// kinds renders events as "#n:kind,kind" lines.
func kinds(evs []PullRequestChanged) string {
	var out []string
	for _, e := range evs {
		var ks []string
		for _, c := range e.Changes {
			ks = append(ks, string(c.Kind))
		}
		out = append(out, fmt.Sprintf("#%d:%s", e.Number, strings.Join(ks, ",")))
	}
	return strings.Join(out, " ")
}

func with(p PullRequest, fn func(*PullRequest)) PullRequest {
	fn(&p)
	return p
}

func TestDiffPullRequest(t *testing.T) {
	a := openPR("PR_a", 1)
	full := func(p PullRequest) prSide { return prSide{pr: p, checks: true} }
	pending := CheckRollup{State: RollupPending, Total: 3, Passed: 1, Pending: 2}
	tests := []struct {
		name string
		p, n prSide
		want []Change
	}{
		{"nothing", full(a), full(a), nil},
		{"updatedAt and size alone", full(a), full(with(a, func(p *PullRequest) {
			p.UpdatedAt, p.Additions, p.Mergeable = p.UpdatedAt.Add(time.Minute), 99, MergeableConflicting
		})), nil},
		{"merged", full(a), full(summary(a, PullRequestMerged)),
			[]Change{{Kind: ChangeMerged, OldState: PullRequestOpen, NewState: PullRequestMerged}}},
		{"closed", full(a), full(summary(a, PullRequestClosed)),
			[]Change{{Kind: ChangeClosed, OldState: PullRequestOpen, NewState: PullRequestClosed}}},
		{"reopened: no counts against the closed summary", full(summary(a, PullRequestClosed)), full(a),
			[]Change{{Kind: ChangeReopened, OldState: PullRequestClosed, NewState: PullRequestOpen}}},
		{"head pushed with new checks", full(a), full(with(a, func(p *PullRequest) { p.HeadSHA, p.Checks = "abc", pending })),
			[]Change{
				{Kind: ChangeHeadPushed, OldHeadSHA: a.HeadSHA, NewHeadSHA: "abc"},
				{Kind: ChangeChecks, OldChecks: a.Checks, NewChecks: pending},
			}},
		{"checks pending to failure", full(with(a, func(p *PullRequest) { p.Checks = pending })),
			full(with(a, func(p *PullRequest) { p.Checks = CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1} })),
			[]Change{{Kind: ChangeChecks, OldChecks: pending, NewChecks: CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1}}}},
		{"check count only", full(with(a, func(p *PullRequest) { p.Checks = pending })),
			full(with(a, func(p *PullRequest) { p.Checks = CheckRollup{State: RollupPending, Total: 3, Passed: 2, Pending: 1} })),
			[]Change{{Kind: ChangeChecks, OldChecks: pending, NewChecks: CheckRollup{State: RollupPending, Total: 3, Passed: 2, Pending: 1}}}},
		{"review decision", full(a), full(with(a, func(p *PullRequest) { p.ReviewDecision = ReviewApproved })),
			[]Change{{Kind: ChangeReviewDecision, OldReviewDecision: ReviewRequired, NewReviewDecision: ReviewApproved}}},
		{"reviews and comments rose", full(a), full(with(a, func(p *PullRequest) { p.Reviews, p.Comments = 2, 4 })),
			[]Change{{Kind: ChangeReviews, OldCount: 1, NewCount: 2}, {Kind: ChangeComments, OldCount: 1, NewCount: 4}}},
		{"counts fell: nothing", full(a), full(with(a, func(p *PullRequest) { p.Reviews, p.Comments = 0, 0 })), nil},
		{"review requested: someone", full(a), full(with(a, func(p *PullRequest) { p.ReviewRequests = []string{"hubot"} })),
			[]Change{{Kind: ChangeReviewRequested, Requested: []string{"hubot"}}}},
		{"review requested: the viewer and a team", full(with(a, func(p *PullRequest) { p.ReviewRequests = []string{"hubot"} })),
			full(with(a, func(p *PullRequest) { p.ReviewRequests = []string{"HUBOT", "Octocat", "org/team"} })),
			[]Change{{Kind: ChangeReviewRequested, Requested: []string{"Octocat", "org/team"}, Viewer: true}}},
		{"request withdrawn: nothing", full(with(a, func(p *PullRequest) { p.ReviewRequests = []string{"hubot"} })), full(a), nil},
		{"draft and title", full(a), full(with(a, func(p *PullRequest) { p.Draft, p.Title = true, "WIP" })),
			[]Change{{Kind: ChangeDraft, NewDraft: true}, {Kind: ChangeTitle, OldTitle: "PR 1", NewTitle: "WIP"}}},
		{"placeholder after: only the fingerprint's fields", full(a),
			prSide{pr: placeholder(with(a, func(p *PullRequest) { p.Title, p.Reviews = "", 0 }), true), checks: true}, nil},
		{"placeholder after: head moved", full(a),
			prSide{pr: placeholder(with(a, func(p *PullRequest) { p.HeadSHA = "abc" }), true), checks: true},
			[]Change{{Kind: ChangeHeadPushed, OldHeadSHA: a.HeadSHA, NewHeadSHA: "abc"}}},
		{"placeholder before: the detail fills nothing in", prSide{pr: placeholder(a, true), checks: true},
			full(with(a, func(p *PullRequest) { p.Reviews = 3 })), nil},
		{"placeholder without its rollup: checks not compared", prSide{pr: placeholder(summary(a, PullRequestMerged), false)},
			full(summary(a, PullRequestMerged)), nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := diffPullRequest(tt.p, tt.n, "octocat")
			if !reflect.DeepEqual(got, tt.want) {
				t.Errorf("got  %+v\nwant %+v", got, tt.want)
			}
		})
	}
}

func TestPRChanges(t *testing.T) {
	a, b, c := openPR("PR_a", 1), openPR("PR_b", 2), openPR("PR_c", 3)
	a2 := with(a, func(p *PullRequest) { p.Checks = CheckRollup{State: RollupFailure, Total: 3, Passed: 2, Failed: 1} })
	list := func(prev, next []PullRequest) prList {
		return prList{prev: prev, next: next, checks: true, baseline: true}
	}
	prs := func(p ...PullRequest) []PullRequest { return append([]PullRequest{}, p...) }
	tests := []struct {
		name    string
		lists   []prList
		known   map[string]PullRequest
		pending map[string]bool
		want    string
		after   map[string]bool // pending afterwards
	}{
		{name: "unchanged", lists: []prList{list(prs(a, b), prs(a, b))}},
		{name: "one changed", lists: []prList{list(prs(a, b), prs(a2, b))}, want: "#1:checks"},
		{name: "appeared", lists: []prList{list(prs(a), prs(a, b))}, want: "#2:appeared"},
		{name: "a list's first poll announces nothing",
			lists: []prList{{prev: nil, next: prs(a, b), checks: true}}},
		{name: "first poll of a list, but known elsewhere: compared with that",
			lists: []prList{{next: prs(a2), checks: true}}, known: map[string]PullRequest{"PR_a": a}, want: "#1:checks"},
		{name: "new to the refreshed lists, known elsewhere: not appeared",
			lists: []prList{list(nil, prs(a))}, known: map[string]PullRequest{"PR_a": a}},
		{name: "in two lists: one event, the first list's copy",
			lists: []prList{list(prs(a), prs(a2)), list(prs(a), prs(a2)), {prev: prs(a), next: prs(placeholder(a, false)), baseline: true}},
			want:  "#1:checks"},
		{name: "left every list: state unknown, nothing", lists: []prList{list(prs(a, b), prs(b))}},
		{name: "left the open list for the merged one: merged",
			lists: []prList{list(prs(a, b), prs(b)), {prev: nil, next: prs(summary(a, PullRequestMerged)), baseline: true}},
			want:  "#1:merged"},
		{name: "closed, still on its watched branch",
			lists: []prList{list(prs(a), nil), list(prs(a), prs(summary(a, PullRequestClosed)))}, want: "#1:closed"},
		{name: "a placeholder waits for its detail",
			lists: []prList{list(prs(a), prs(a, placeholder(b, true)))}, after: map[string]bool{"PR_b": true}},
		{name: "still a placeholder: still waiting",
			lists:   []prList{list(prs(a, placeholder(b, true)), prs(a, placeholder(b, true)))},
			pending: map[string]bool{"PR_b": true}, after: map[string]bool{"PR_b": true}},
		{name: "the detail came: appeared",
			lists:   []prList{list(prs(a, placeholder(b, true)), prs(a, b))},
			pending: map[string]bool{"PR_b": true}, want: "#2:appeared", after: map[string]bool{}},
		{name: "left before its detail came: forgotten",
			lists:   []prList{list(prs(a, placeholder(b, true)), prs(a))},
			pending: map[string]bool{"PR_b": true}, after: map[string]bool{}},
		{name: "entered the review-requested list",
			lists: []prList{list(prs(a, c), prs(a, c)), {prev: prs(), next: prs(c, b), checks: true, baseline: true, reviewRequested: true}},
			want:  "#2:appeared,review_requested #3:review_requested"},
		{name: "review-requested list polled for the first time: nothing",
			lists: []prList{list(prs(c), prs(c)), {next: prs(c), checks: true, reviewRequested: true}}},
		{name: "sorted by repository and number",
			lists: []prList{list(prs(c, a), prs(with(c, func(p *PullRequest) { p.Title = "x" }), a2))}, want: "#1:checks #3:title"},
		{name: "a placeholder fills in its branch's repository and head",
			lists: []prList{{prev: prs(), next: prs(with(b, func(p *PullRequest) { p.Repo, p.HeadRef = "", "" })), slug: "o/r", head: "feat", checks: true, baseline: true}},
			want:  "#2:appeared"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pending := tt.pending
			if pending == nil {
				pending = map[string]bool{}
			}
			got := prChanges(tt.lists, tt.known, pending, "octocat")
			if k := kinds(got); k != tt.want {
				t.Errorf("events %q, want %q", k, tt.want)
			}
			if tt.after != nil && !reflect.DeepEqual(pending, tt.after) {
				t.Errorf("pending %v, want %v", pending, tt.after)
			}
			for _, e := range got {
				if e.Slug != "o/r" || e.URL == "" || e.HeadRef == "" || e.PullRequest.ID == "" || len(e.Changes) == 0 {
					t.Errorf("event %+v", e)
				}
				if e.Has(ChangeAppeared) && e.PullRequest.Partial {
					t.Errorf("appeared with a placeholder: %+v", e)
				}
			}
		})
	}
}
