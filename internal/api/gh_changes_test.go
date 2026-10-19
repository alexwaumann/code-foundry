package api

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func TestPullRequestChangeToProto(t *testing.T) {
	pending := gh.CheckRollup{State: gh.RollupPending, Total: 2, Pending: 2}
	failed := gh.CheckRollup{State: gh.RollupFailure, Total: 2, Passed: 1, Failed: 1}
	// Every value set: only the kind's own reach the message.
	all := gh.Change{
		OldState: gh.PullRequestOpen, NewState: gh.PullRequestMerged, OldHeadSHA: "a", NewHeadSHA: "b",
		OldChecks: pending, NewChecks: failed, OldReviewDecision: gh.ReviewRequired, NewReviewDecision: gh.ReviewApproved,
		OldCount: 1, NewCount: 3, Requested: []string{"octocat", "org/team"}, Viewer: true,
		OldDraft: true, NewDraft: false, OldTitle: "WIP", NewTitle: "Done",
	}
	tests := []struct {
		kind gh.ChangeKind
		want *v1.PullRequestChange
	}{
		{gh.ChangeAppeared, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_APPEARED}},
		{gh.ChangeMerged, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_MERGED,
			OldState: v1.PullRequestState_PULL_REQUEST_STATE_OPEN, NewState: v1.PullRequestState_PULL_REQUEST_STATE_MERGED}},
		{gh.ChangeClosed, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_CLOSED,
			OldState: v1.PullRequestState_PULL_REQUEST_STATE_OPEN, NewState: v1.PullRequestState_PULL_REQUEST_STATE_MERGED}},
		{gh.ChangeReopened, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_REOPENED,
			OldState: v1.PullRequestState_PULL_REQUEST_STATE_OPEN, NewState: v1.PullRequestState_PULL_REQUEST_STATE_MERGED}},
		{gh.ChangeHeadPushed, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_HEAD_PUSHED, OldHeadSha: "a", NewHeadSha: "b"}},
		{gh.ChangeChecks, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_CHECKS,
			OldChecks: rollupToProto(pending), NewChecks: rollupToProto(failed)}},
		{gh.ChangeReviewDecision, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_REVIEW_DECISION,
			OldReviewDecision: v1.ReviewDecision_REVIEW_DECISION_REVIEW_REQUIRED, NewReviewDecision: v1.ReviewDecision_REVIEW_DECISION_APPROVED}},
		{gh.ChangeReviews, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_REVIEWS, OldCount: 1, NewCount: 3}},
		{gh.ChangeComments, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_COMMENTS, OldCount: 1, NewCount: 3}},
		{gh.ChangeReviewRequested, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_REVIEW_REQUESTED,
			Requested: []string{"octocat", "org/team"}, ViewerRequested: true}},
		{gh.ChangeDraft, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_DRAFT, OldDraft: true}},
		{gh.ChangeTitle, &v1.PullRequestChange{Kind: v1.PullRequestChangeKind_PULL_REQUEST_CHANGE_KIND_TITLE, OldTitle: "WIP", NewTitle: "Done"}},
	}
	if len(tests) != len(gh.ChangeKinds) || len(v1.PullRequestChangeKind_name)-1 != len(gh.ChangeKinds) {
		t.Errorf("%d cases and %d proto kinds for %d kinds", len(tests), len(v1.PullRequestChangeKind_name)-1, len(gh.ChangeKinds))
	}
	for _, tt := range tests {
		t.Run(string(tt.kind), func(t *testing.T) {
			c := all
			c.Kind = tt.kind
			if got := pullRequestChangeToProto(c); !proto.Equal(got, tt.want) {
				t.Errorf("got  %v\nwant %v", got, tt.want)
			}
		})
	}
}

// changedEvent is a checks change on an open pull request.
func changedEvent() gh.PullRequestChanged {
	pr := gh.PullRequest{
		ID: "PR_1", Number: 7, Title: "Fix the login redirect", Repo: "o/r", HeadRef: "cf/login", HeadSHA: "abc",
		URL: "https://github.com/o/r/pull/7", State: gh.PullRequestOpen, Comments: 2,
		Checks: gh.CheckRollup{State: gh.RollupSuccess, Total: 2, Passed: 2},
	}
	return gh.PullRequestChanged{Slug: "o/r", Number: 7, URL: pr.URL, HeadRef: pr.HeadRef, PullRequest: pr, Changes: []gh.Change{{
		Kind: gh.ChangeChecks, OldChecks: gh.CheckRollup{State: gh.RollupPending, Total: 2, Passed: 1, Pending: 1}, NewChecks: pr.Checks,
	}}}
}

// The JSON plugins and `code-foundry events --json` get (protojson of the Event).
func TestPullRequestChangedJSON(t *testing.T) {
	b, err := protojson.Marshal(ghWrap(ghPullRequestChangedEvent(changedEvent())))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"gh": map[string]any{"pullRequestChanged": map[string]any{
		"repoSlug": "o/r", "number": 7.0, "url": "https://github.com/o/r/pull/7", "headRef": "cf/login",
		"pullRequest": map[string]any{
			"repoSlug": "o/r", "number": 7.0, "title": "Fix the login redirect", "headRef": "cf/login", "headSha": "abc",
			"url": "https://github.com/o/r/pull/7", "state": "PULL_REQUEST_STATE_OPEN", "commentCount": 2.0,
			"checks": map[string]any{"state": "CHECK_ROLLUP_STATE_SUCCESS", "total": 2.0, "passed": 2.0},
		},
		"changes": []any{map[string]any{
			"kind":      "PULL_REQUEST_CHANGE_KIND_CHECKS",
			"oldChecks": map[string]any{"state": "CHECK_ROLLUP_STATE_PENDING", "total": 2.0, "passed": 1.0, "pending": 1.0},
			"newChecks": map[string]any{"state": "CHECK_ROLLUP_STATE_SUCCESS", "total": 2.0, "passed": 2.0},
		}},
	}}}
	gb, _ := json.Marshal(got)
	wb, _ := json.Marshal(want)
	if string(gb) != string(wb) {
		t.Errorf("json\n got %s\nwant %s", gb, wb)
	}
}

func TestGhWatchPullRequestChanged(t *testing.T) {
	store, client, _ := newGhTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchGhRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	store.ChangePullRequest(changedEvent())
	if !stream.Receive() {
		t.Fatalf("no event: %v", stream.Err())
	}
	ev := stream.Msg().GetPullRequestChanged()
	if ev.GetNumber() != 7 || ev.GetPullRequest().GetTitle() != "Fix the login redirect" ||
		ev.GetChanges()[0].GetNewChecks().GetState() != v1.CheckRollupState_CHECK_ROLLUP_STATE_SUCCESS {
		t.Errorf("event %v", stream.Msg())
	}
}

func TestEventsPullRequestChanged(t *testing.T) {
	f := newEventsFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	s := f.watch(t, ctx, v1.EventSource_EVENT_SOURCE_GH)
	for range 3 { // viewer, polled, dashboard
		if ev := s.next(); ev.GetSeq() != 0 {
			t.Fatalf("snapshot event with a seq: %v", ev)
		}
	}
	f.gh.ChangePullRequest(changedEvent())
	ev := s.next()
	if p := ev.GetGh().GetPullRequestChanged(); p.GetRepoSlug() != "o/r" || p.GetNumber() != 7 || ev.GetSeq() == 0 {
		t.Errorf("event %v", ev)
	}
}
