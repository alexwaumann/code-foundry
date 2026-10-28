package thread

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestParsePullRequestTarget(t *testing.T) {
	for _, tt := range []struct{ in, want string }{
		{"alexwaumann/code-foundry#210", "alexwaumann/code-foundry#210"},
		{"  Acme/Web.Site#7 ", "acme/web.site#7"},
		{"Acme_cof/web#7", "acme_cof/web#7"},
		{"https://github.com/Acme/web/pull/12", "acme/web#12"},
		{"http://www.github.com/acme/web/pull/12/files", "acme/web#12"},
		{"github.com/acme/web/pull/12#discussion_r1", "acme/web#12"},
		{"https://github.com/acme/web/pull/0012?w=1", "acme/web#12"},
		{"acme/web#0", ""},
		{"acme/web", ""},
		{"acme#12", ""},
		{"acme/..#12", ""},
		{"https://gitlab.com/acme/web/pull/12", ""},
		{"https://github.com/acme/web/issues/12", ""},
		{"-acme/web#1", ""},
		{"acme/web#1234567890", ""},
	} {
		got, err := ParsePullRequestTarget(tt.in)
		if tt.want == "" {
			if !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("%q: %q, %v; want invalid argument", tt.in, got, err)
			}
			continue
		}
		if err != nil || got != tt.want {
			t.Errorf("%q: %q, %v; want %q", tt.in, got, err, tt.want)
		}
	}
}

func TestSubscribeTargetPullRequest(t *testing.T) {
	for _, tt := range []struct {
		o    SubscribeOptions
		cond Condition
		fail bool
	}{
		{o: SubscribeOptions{TargetPullRequest: "a/b#1"}, cond: CondChecksDone},
		{o: SubscribeOptions{TargetPullRequest: "a/b#1", Condition: CondReview}, cond: CondReview},
		{o: SubscribeOptions{TargetPullRequest: "a/b#1", Condition: CondSettled}, fail: true},
		{o: SubscribeOptions{TargetPullRequest: "a/b#1", Condition: CondFinished}, fail: true},
		{o: SubscribeOptions{TargetThreadID: "s-1", Condition: CondChecksDone}, fail: true},
		{o: SubscribeOptions{TargetRunID: "r-1", Condition: CondMerged}, fail: true},
		{o: SubscribeOptions{TargetPullRequest: "a/b#1", TargetThreadID: "s-1"}, fail: true},
		{o: SubscribeOptions{TargetPullRequest: "a/b"}, fail: true},
	} {
		kind, target, cond, err := subscribeTarget(tt.o)
		if tt.fail {
			if !errors.Is(err, ErrInvalidArgument) {
				t.Errorf("%+v: %v, want invalid argument", tt.o, err)
			}
			continue
		}
		if err != nil || kind != TargetPullRequest || target != "a/b#1" || cond != tt.cond {
			t.Errorf("%+v: %s %s %s %v", tt.o, kind, target, cond, err)
		}
	}
}

var (
	pending4 = PRChecks{State: "PENDING", Total: 4, Passed: 2, Pending: 2}
	passed4  = PRChecks{State: "SUCCESS", Total: 4, Passed: 4}
	failed4  = PRChecks{State: "FAILURE", Total: 4, Passed: 3, Failed: 1}
	failing  = PRChecks{State: "FAILURE", Total: 4, Passed: 1, Failed: 1, Pending: 2}
)

// prEvent is an open pull request acme/web#7 after changes.
func prEvent(checks PRChecks, changes ...PullRequestChange) PullRequestEvent {
	return PullRequestEvent{PullRequest: PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: checks}, Changes: changes}
}

func checksChange(old, new PRChecks) PullRequestChange {
	return PullRequestChange{Kind: PRChangeChecks, OldChecks: old, NewChecks: new}
}

func TestMatchPullRequest(t *testing.T) {
	push := PullRequestChange{Kind: PRChangeHeadPushed, OldHeadSHA: "a", NewHeadSHA: "b"}
	reviews := PullRequestChange{Kind: PRChangeReviews, OldCount: 0, NewCount: 1}
	decision := PullRequestChange{Kind: PRChangeReviewDecision, OldReviewDecision: "REVIEW_REQUIRED", NewReviewDecision: "APPROVED"}
	comments := PullRequestChange{Kind: PRChangeComments, OldCount: 1, NewCount: 3}
	requested := PullRequestChange{Kind: PRChangeReviewRequested, Requested: []string{"octocat"}}
	merged := PullRequestChange{Kind: PRChangeMerged, OldState: "open", NewState: "merged"}
	closed := PullRequestChange{Kind: PRChangeClosed, OldState: "open", NewState: "closed"}
	appeared := PullRequestChange{Kind: PRChangeAppeared}
	title := PullRequestChange{Kind: PRChangeTitle, OldTitle: "a", NewTitle: "b"}
	appearedAs := func(state string, checks PRChecks) PullRequestEvent {
		e := prEvent(checks, appeared)
		e.PullRequest.State = state
		return e
	}

	tests := []struct {
		name string
		e    PullRequestEvent
		want map[Condition]string // matched kinds, comma-separated; unlisted: no fire
	}{
		{"checks finish green", prEvent(passed4, checksChange(pending4, passed4)),
			map[Condition]string{CondChecksDone: "checks", CondChecksPassed: "checks", CondChanged: "checks"}},
		{"checks finish red", prEvent(failed4, checksChange(pending4, failed4)),
			map[Condition]string{CondChecksDone: "checks", CondChecksFailed: "checks", CondChanged: "checks"}},
		{"a failure while two still run: failed, not done", prEvent(failing, checksChange(pending4, failing)),
			map[Condition]string{CondChecksFailed: "checks", CondChanged: "checks"}},
		{"the rest finish after a failure: done, not failed again", prEvent(failed4, checksChange(failing, failed4)),
			map[Condition]string{CondChecksDone: "checks", CondChanged: "checks"}},
		{"progress", prEvent(pending4, checksChange(PRChecks{State: "PENDING", Total: 4, Pending: 4}, pending4)),
			map[Condition]string{CondChanged: "checks"}},
		{"a push: new checks pending", prEvent(pending4, push, checksChange(passed4, pending4)),
			map[Condition]string{CondHeadPushed: "head_pushed", CondChanged: "head_pushed,checks"}},
		{"a push whose checks already passed between polls", prEvent(passed4, push),
			map[Condition]string{CondHeadPushed: "head_pushed", CondChecksDone: "head_pushed", CondChecksPassed: "head_pushed", CondChanged: "head_pushed"}},
		{"a review submitted and the decision moved, with comments: one poll", prEvent(passed4, decision, reviews, comments),
			map[Condition]string{CondReview: "review_decision,reviews", CondComment: "comments", CondChanged: "review_decision,reviews,comments"}},
		{"a review requested", prEvent(passed4, requested),
			map[Condition]string{CondReviewRequested: "review_requested", CondChanged: "review_requested"}},
		{"merged", prEvent(passed4, merged), map[Condition]string{CondMerged: "merged", CondChanged: "merged"}},
		{"closed", prEvent(passed4, closed), map[Condition]string{CondClosed: "closed", CondChanged: "closed"}},
		{"a title", prEvent(passed4, title), map[Condition]string{CondChanged: "title"}},
		{"first seen with checks done", appearedAs("open", passed4),
			map[Condition]string{CondChecksDone: "appeared", CondChecksPassed: "appeared", CondChanged: "appeared"}},
		{"first seen merged", appearedAs("merged", passed4), map[Condition]string{CondMerged: "appeared", CondChanged: "appeared"}},
		{"first seen closed, no checks", appearedAs("closed", PRChecks{}), map[Condition]string{CondClosed: "appeared", CondChanged: "appeared"}},
	}
	for _, tt := range tests {
		for _, c := range PullRequestConditions {
			var kinds []string
			for _, ch := range matchPullRequest(c, tt.e) {
				kinds = append(kinds, string(ch.Kind))
			}
			if got := strings.Join(kinds, ","); got != tt.want[c] {
				t.Errorf("%s: %s matched %q, want %q", tt.name, c, got, tt.want[c])
			}
		}
	}
}

func TestPRAlreadyMet(t *testing.T) {
	open := func(c PRChecks) PullRequestInfo { return PullRequestInfo{State: "open", Checks: c} }
	tests := []struct {
		p    PullRequestInfo
		want []Condition
	}{
		{open(passed4), []Condition{CondChecksDone, CondChecksPassed}},
		{open(failed4), []Condition{CondChecksDone, CondChecksFailed}},
		{open(failing), []Condition{CondChecksFailed}},
		{open(pending4), nil},
		{open(PRChecks{}), nil},
		{PullRequestInfo{State: "merged", Checks: passed4}, []Condition{CondMerged}},
		{PullRequestInfo{State: "closed", Checks: failed4}, []Condition{CondClosed}},
	}
	for _, tt := range tests {
		for _, c := range PullRequestConditions {
			if got := prAlreadyMet(c, tt.p); got != slices.Contains(tt.want, c) {
				t.Errorf("%s %+v: %s = %v", tt.p.State, tt.p.Checks, c, got)
			}
		}
	}
}

func TestPRWakeMessage(t *testing.T) {
	at := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	p := PullRequestInfo{Slug: "alexwaumann/code-foundry", Number: 210, URL: "https://github.com/alexwaumann/code-foundry/pull/210",
		Title: "gh: pullRequestChanged events", State: "open", HeadSHA: "4a3d1baedec1", HeadRef: "cf/x", ReviewDecision: "APPROVED",
		Checks: PRChecks{State: "SUCCESS", Total: 5, Passed: 4, Skipped: 1}, Reviews: 2, Comments: 3,
		LatestReviews: []PRReview{{Author: "hubot", State: "COMMENTED", SubmittedAt: at.Add(-time.Hour)}, {Author: "octocat", State: "APPROVED", SubmittedAt: at}}}
	who := `Pull request alexwaumann/code-foundry#210 "gh: pullRequestChanged events": `
	tests := []struct {
		c       Condition
		changes []PullRequestChange
		want    string
	}{
		{CondChecksDone, []PullRequestChange{checksChange(pending4, p.Checks)}, "checks done (4 passed, 0 failed, 1 skipped)."},
		{CondChecksPassed, nil, "checks passed (4/5)."},
		{CondReview, []PullRequestChange{{Kind: PRChangeReviews, OldCount: 1, NewCount: 2}}, "a review was submitted (APPROVED by octocat)."},
		{CondReview, []PullRequestChange{{Kind: PRChangeReviewDecision}}, "the review decision changed to APPROVED."},
		{CondComment, []PullRequestChange{{Kind: PRChangeComments, OldCount: 2, NewCount: 3}}, "a new comment (3 in all)."},
		{CondComment, []PullRequestChange{{Kind: PRChangeComments, OldCount: 0, NewCount: 3}}, "3 new comments (3 in all)."},
		{CondReviewRequested, []PullRequestChange{{Kind: PRChangeReviewRequested, Requested: []string{"octocat", "org/team"}}}, "a review was requested from octocat, org/team."},
		{CondReviewRequested, []PullRequestChange{{Kind: PRChangeReviewRequested, ViewerRequested: true}}, "a review was requested from you."},
		{CondHeadPushed, []PullRequestChange{{Kind: PRChangeHeadPushed, OldHeadSHA: "1b8930b8aaaa", NewHeadSHA: "4a3d1baedec1"}}, "new commits were pushed (head 1b8930b → 4a3d1ba)."},
		{CondMerged, nil, "merged."},
		{CondClosed, nil, "closed without merging."},
		{CondChanged, []PullRequestChange{{Kind: PRChangeHeadPushed}, {Kind: PRChangeChecks}}, "changed (head_pushed, checks)."},
	}
	for _, tt := range tests {
		if got := prWakeTitle(tt.c, p, tt.changes); got != who+tt.want {
			t.Errorf("%s: %q, want %q", tt.c, got, who+tt.want)
		}
	}
	failedP := p
	failedP.Checks, failedP.Title = failing, ""
	if got := prWakeTitle(CondChecksFailed, failedP, nil); got != "Pull request alexwaumann/code-foundry#210: checks failed (1 failed, 1 passed, 2 pending)." {
		t.Errorf("failed, untitled: %q", got)
	}
	commented := p
	commented.ReviewDecision = "CHANGES_REQUESTED"
	commented.LatestReviews = []PRReview{{Author: "hubot", State: "COMMENTED", SubmittedAt: at}}
	if got := prWhat(CondReview, commented, []PullRequestChange{{Kind: PRChangeReviews}}); got != "a review was submitted (COMMENTED by hubot; review decision CHANGES_REQUESTED)" {
		t.Errorf("review with another decision: %q", got)
	}

	msg := prWake(Subscription{ID: "sub-1", Condition: CondChecksDone}, p, []PullRequestChange{
		checksChange(pending4, p.Checks), {Kind: PRChangeReviewRequested, Requested: nil, ViewerRequested: true}}, at)
	if msg.Origin != OriginWake || msg.WakeTitle != who+"checks done (4 passed, 0 failed, 1 skipped)." ||
		msg.Text != "[code-foundry wake] "+msg.WakeTitle+"\n```json\n"+msg.WakeJSON+"\n```" {
		t.Errorf("message = %+v", msg)
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(msg.WakeJSON), &payload); err != nil {
		t.Fatal(err)
	}
	pr := payload["pull_request"].(map[string]any)
	changes := payload["changes"].([]any)
	checks := changes[0].(map[string]any)
	reqd := changes[1].(map[string]any)
	if payload["kind"] != "pull_request" || payload["condition"] != "checks_done" || payload["subscription_id"] != "sub-1" ||
		payload["fired_at"] != "2026-10-18T12:00:00.000Z" || pr["slug"] != "alexwaumann/code-foundry" || pr["number"] != 210.0 ||
		pr["head_sha"] != "4a3d1baedec1" || pr["review_decision"] != "APPROVED" || pr["merged_at"] != "" ||
		pr["checks"].(map[string]any)["skipped"] != 1.0 || len(pr["latest_reviews"].([]any)) != 2 || pr["review_requests"] == nil {
		t.Errorf("payload:\n%s", msg.WakeJSON)
	}
	if len(checks) != 3 || checks["kind"] != "checks" || checks["old_checks"].(map[string]any)["pending"] != 2.0 {
		t.Errorf("checks change only has its fields: %v", checks)
	}
	if len(reqd) != 3 || reqd["viewer_requested"] != true || len(reqd["requested"].([]any)) != 0 {
		t.Errorf("review_requested change: %v", reqd)
	}
	for _, key := range []string{`"latest_reviews": [`, `"submitted_at": "2026-10-18T12:00:00.000Z"`, `"draft": false`} {
		if !strings.Contains(msg.WakeJSON, key) {
			t.Errorf("JSON lacks %s:\n%s", key, msg.WakeJSON)
		}
	}
	if m := prWake(Subscription{ID: "sub-2", Condition: CondMerged}, PullRequestInfo{Slug: "a/b", Number: 1, State: "merged"}, nil, at); !strings.Contains(m.WakeJSON, `"changes": []`) ||
		!strings.Contains(m.WakeJSON, `"latest_reviews": []`) || !strings.Contains(m.WakeJSON, `"review_requests": []`) {
		t.Errorf("at once, no lists:\n%s", m.WakeJSON)
	}
}

func TestPRStatusWords(t *testing.T) {
	for _, tt := range []struct {
		p    PullRequestInfo
		want string
	}{
		{PullRequestInfo{State: "open", Checks: pending4}, "open · checks pending (2/4)"},
		{PullRequestInfo{State: "open", Checks: passed4, ReviewDecision: "APPROVED"}, "open · checks passed (4/4) · approved"},
		{PullRequestInfo{State: "open", Draft: true, Checks: failing, ReviewDecision: "CHANGES_REQUESTED"}, "open · draft · checks failed (1/4) · changes requested"},
		{PullRequestInfo{State: "open"}, "open · no checks"},
		{PullRequestInfo{State: "merged", Checks: passed4}, "merged"},
		{PullRequestInfo{State: "closed"}, "closed"},
	} {
		if got := prStatusWords(tt.p); got != tt.want {
			t.Errorf("%+v: %q, want %q", tt.p, got, tt.want)
		}
	}
}

// fakePRs stands in for the GitHub store (Options.PullRequest, WatchPullRequests).
type fakePRs struct {
	mu      sync.Mutex
	prs     map[string]PullRequestInfo
	watched [][]string
}

func newFakePRs(prs ...PullRequestInfo) *fakePRs {
	f := &fakePRs{prs: map[string]PullRequestInfo{}}
	for _, p := range prs {
		f.prs[p.Target()] = p
	}
	return f
}

func (f *fakePRs) opts(o *Options) {
	o.PullRequest = func(_ context.Context, target string) (PullRequestInfo, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p, ok := f.prs[target]
		return p, ok
	}
	o.WatchPullRequests = func(targets []string) {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.watched = append(f.watched, targets)
	}
}

func (f *fakePRs) set(p PullRequestInfo) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.prs[p.Target()] = p
}

// lastWatched is the last set WatchPullRequests got, and how many calls there were.
func (f *fakePRs) lastWatched() ([]string, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.watched) == 0 {
		return nil, 0
	}
	return f.watched[len(f.watched)-1], len(f.watched)
}

func wakeTitles(items []Item) []string {
	var out []string
	for _, w := range wakes(items) {
		out = append(out, w.WakeTitle)
	}
	return out
}

func TestPullRequestSubscriptions(t *testing.T) {
	const target = "acme/web#7"
	prs := newFakePRs()
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	sub := func(o SubscribeOptions) SubscribeResult {
		t.Helper()
		o.SubscriberID = parent.ID
		res, err := e.m.Subscribe(e.ctx(), o)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	// Unknown to the GitHub store: armed, nothing fires; the URL is normalised.
	done := sub(SubscribeOptions{TargetPullRequest: "https://github.com/Acme/web/pull/7"})
	if done.Fired || done.Subscription.TargetID != target || done.Subscription.Condition != CondChecksDone || done.Subscription.Repeat {
		t.Fatalf("checks_done = %+v", done)
	}
	review := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondReview, Repeat: true})
	if w, _ := prs.lastWatched(); !slices.Equal(w, []string{target}) {
		t.Errorf("watched %v", w)
	}
	if got, _ := e.subscription(review.Subscription.ID); got.TargetName != target || got.TargetStatus != "not polled yet" {
		t.Errorf("listed unknown = %+v", got)
	}
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, Title: "Retry", State: "open", Checks: pending4})
	if got, _ := e.subscription(review.Subscription.ID); got.TargetName != "acme/web#7 Retry" || got.TargetStatus != "open · checks pending (2/4)" {
		t.Errorf("listed = %+v", got)
	}

	// Checks finish: checks_done fires once and goes; review does not fire.
	ev := prEvent(passed4, checksChange(pending4, passed4))
	ev.PullRequest.Title = "Retry"
	e.m.PullRequestChanged(ev)
	e.m.PullRequestChanged(ev) // the same again: checks_done is gone, nothing else matches
	items := e.waitItems(parent.ID, "the checks wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if got := wakeTitles(items); got[0] != `Pull request acme/web#7 "Retry": checks done (4 passed, 0 failed).` {
		t.Errorf("wake %q", got[0])
	}
	if _, kept := e.subscription(done.Subscription.ID); kept {
		t.Error("the one-shot checks_done stayed")
	}
	// A review, its decision and comments in one poll: one wake; then another review.
	ev = prEvent(passed4, PullRequestChange{Kind: PRChangeReviewDecision, NewReviewDecision: "CHANGES_REQUESTED"},
		PullRequestChange{Kind: PRChangeReviews, NewCount: 1}, PullRequestChange{Kind: PRChangeComments, NewCount: 2})
	ev.PullRequest.ReviewDecision, ev.PullRequest.LatestReviews = "CHANGES_REQUESTED", []PRReview{{Author: "octocat", State: "CHANGES_REQUESTED"}}
	e.m.PullRequestChanged(ev)
	e.waitItems(parent.ID, "the review wake", func(items []Item) bool { return len(wakes(items)) == 2 })
	e.m.PullRequestChanged(prEvent(passed4, PullRequestChange{Kind: PRChangeReviews, OldCount: 1, NewCount: 2}))
	items = e.waitItems(parent.ID, "the second review wake", func(items []Item) bool { return len(wakes(items)) == 3 })
	if w := wakes(items)[1]; w.WakeTitle != "Pull request acme/web#7: a review was submitted (CHANGES_REQUESTED by octocat)." ||
		!strings.Contains(w.WakeJSON, `"kind": "review_decision"`) || !strings.Contains(w.WakeJSON, `"kind": "reviews"`) ||
		strings.Contains(w.WakeJSON, `"kind": "comments"`) {
		t.Errorf("review wake %q\n%s", w.WakeTitle, w.WakeJSON)
	}
	if got, kept := e.subscription(review.Subscription.ID); !kept || got.FiredCount != 2 {
		t.Errorf("review = %+v (kept %v)", got, kept)
	}
	// Another pull request's change wakes nobody.
	other := prEvent(passed4, PullRequestChange{Kind: PRChangeReviews, NewCount: 9})
	other.PullRequest.Number = 8
	e.m.PullRequestChanged(other)

	// Fire at once from the cache: checks_passed once (not kept), checks_done repeat (kept).
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, Title: "Retry", State: "open", Checks: passed4})
	if res := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondChecksPassed}); !res.Fired {
		t.Errorf("checks_passed at once = %+v", res)
	} else if _, kept := e.subscription(res.Subscription.ID); kept {
		t.Error("a one-shot that fired at once was kept")
	}
	again := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondChecksDone, Repeat: true})
	if !again.Fired {
		t.Errorf("checks_done repeat at once = %+v", again)
	}
	closed := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondClosed, Repeat: true})
	merged := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondMerged, Repeat: true})
	if closed.Fired || merged.Fired {
		t.Errorf("closed/merged fired on an open pull request")
	}
	e.waitItems(parent.ID, "the at-once wakes", func(items []Item) bool { return len(wakes(items)) == 5 })

	// Merged: merged fires even with repeat, and every subscription to it goes.
	ev = prEvent(passed4, PullRequestChange{Kind: PRChangeMerged, OldState: "open", NewState: "merged"})
	ev.PullRequest.State = "merged"
	e.m.PullRequestChanged(ev)
	items = e.waitItems(parent.ID, "the merged wake", func(items []Item) bool { return len(wakes(items)) == 6 })
	if got := wakeTitles(items)[5]; got != "Pull request acme/web#7: merged." {
		t.Errorf("merged wake %q", got)
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), parent.ID); len(subs) != 0 {
		t.Errorf("left after the merge: %+v", subs)
	}
	if w, _ := prs.lastWatched(); len(w) != 0 {
		t.Errorf("still watched after the merge: %v", w)
	}
	// Merged in the cache: merged fires at once and is not kept; anything else is refused.
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, State: "merged"})
	if res := sub(SubscribeOptions{TargetPullRequest: target, Condition: CondMerged, Repeat: true}); !res.Fired {
		t.Errorf("merged at once = %+v", res)
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondComment}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("comment on a merged pull request = %v", err)
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), parent.ID); len(subs) != 0 {
		t.Errorf("left: %+v", subs)
	}
}

func TestPullRequestSubscriptionsClosed(t *testing.T) {
	const target = "acme/web#7"
	prs := newFakePRs()
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	closed, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondClosed, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	comment, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondComment})
	if err != nil {
		t.Fatal(err)
	}
	ev := prEvent(passed4, PullRequestChange{Kind: PRChangeClosed, OldState: "open", NewState: "closed"})
	ev.PullRequest.State = "closed"
	e.m.PullRequestChanged(ev)
	e.waitItems(parent.ID, "the closed wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	if _, kept := e.subscription(closed.Subscription.ID); kept {
		t.Error("closed stayed with repeat")
	}
	if _, kept := e.subscription(comment.Subscription.ID); !kept {
		t.Error("comment went with the close (it may reopen)")
	}
	// Unsubscribe by the pull request (a URL), then nothing is watched.
	gone, err := e.m.Unsubscribe(e.ctx(), UnsubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: "https://github.com/acme/web/pull/7"})
	if err != nil || len(gone) != 1 || gone[0].ID != comment.Subscription.ID {
		t.Errorf("Unsubscribe = %+v, %v", gone, err)
	}
	if w, _ := prs.lastWatched(); len(w) != 0 {
		t.Errorf("watched %v", w)
	}
}

func TestPullRequestSubscriptionsRefuse(t *testing.T) {
	e := newEnv(t)
	a := e.stopped("a")
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: a.ID, TargetPullRequest: "a/b#1"}); !errors.Is(err, ErrFailedPrecondition) {
		t.Errorf("without the GitHub store = %v", err)
	}
	prs := newFakePRs()
	e = newEnv(t, prs.opts)
	a = e.stopped("a")
	for _, o := range []SubscribeOptions{
		{SubscriberID: a.ID, TargetPullRequest: "a/b#1", Condition: CondSettled},
		{SubscriberID: a.ID, TargetPullRequest: "a/b"},
		{SubscriberID: a.ID, TargetThreadID: a.ID, Condition: CondChecksDone},
	} {
		if _, err := e.m.Subscribe(e.ctx(), o); !errors.Is(err, ErrInvalidArgument) {
			t.Errorf("%+v: %v, want invalid argument", o, err)
		}
	}
	if _, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: "s-nope", TargetPullRequest: "a/b#1"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("unknown subscriber = %v", err)
	}
	if _, n := prs.lastWatched(); n != 0 {
		t.Errorf("refusals told the GitHub store %d times", n)
	}
}

// Rehydrated pull request subscriptions are watched again at startup, nothing fires
// for what happened while the daemon was stopped, and the next change fires. Archiving
// the subscriber deletes them.
func TestPullRequestSubscriptionsRehydrate(t *testing.T) {
	const target = "acme/web#7"
	prs := newFakePRs()
	e := newEnv(t, prs.opts)
	parent := e.stopped("parent")
	res, err := e.m.Subscribe(e.ctx(), SubscribeOptions{SubscriberID: parent.ID, TargetPullRequest: target, Condition: CondComment, Repeat: true})
	if err != nil {
		t.Fatal(err)
	}
	prs.set(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: passed4, Comments: 5})

	restarted := newFakePRs(PullRequestInfo{Slug: "acme/web", Number: 7, State: "open", Checks: passed4, Comments: 5})
	e.restart(restarted.opts)
	if w, n := restarted.lastWatched(); n != 1 || !slices.Equal(w, []string{target}) {
		t.Errorf("watched at startup %v (%d calls)", w, n)
	}
	subs, _ := e.m.Subscriptions(e.ctx(), "")
	if len(subs) != 1 || subs[0].ID != res.Subscription.ID || !subs[0].Repeat || subs[0].Condition != CondComment {
		t.Fatalf("after restart = %+v", subs)
	}
	time.Sleep(50 * time.Millisecond)
	if n := len(wakes(e.items(parent.ID).Items)); n != 0 {
		t.Errorf("%d wakes at startup", n)
	}
	e.m.PullRequestChanged(prEvent(passed4, PullRequestChange{Kind: PRChangeComments, OldCount: 5, NewCount: 6}))
	e.waitItems(parent.ID, "the comment wake", func(items []Item) bool { return len(wakes(items)) == 1 })
	e.waitFor(parent.ID, "the woken turn's end", func(s Thread) bool { return s.Status == StatusNeedsAttention && s.StatusReason == "finished" })

	if _, err := e.m.Archive(e.ctx(), parent.ID, true); err != nil {
		t.Fatal(err)
	}
	if subs, _ := e.m.Subscriptions(e.ctx(), ""); len(subs) != 0 {
		t.Errorf("left after archiving the subscriber: %+v", subs)
	}
	if w, _ := restarted.lastWatched(); len(w) != 0 {
		t.Errorf("watched after archiving the subscriber: %v", w)
	}
}
