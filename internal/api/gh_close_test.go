package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func TestGhSetPullRequestClosed(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		number  int32
		closed  bool
		code    connect.Code
		want    *v1.SetPullRequestClosedResponse
		wantRec string
	}{
		{name: "close", number: 7, closed: true,
			want: &v1.SetPullRequestClosedResponse{State: v1.PullRequestState_PULL_REQUEST_STATE_CLOSED, Message: "Closed #7"}, wantRec: "close o/r#7"},
		{name: "reopen", number: 9,
			want: &v1.SetPullRequestClosedResponse{State: v1.PullRequestState_PULL_REQUEST_STATE_OPEN, Message: "Reopened #9"}, wantRec: "reopen o/r#9"},
		{name: "reopen a merged one: failed precondition", number: 8, code: connect.CodeFailedPrecondition, wantRec: "reopen o/r#8"},
		{name: "close without permission: permission denied", number: 10, closed: true, code: connect.CodePermissionDenied, wantRec: "close o/r#10"},
		{name: "unknown: not found", number: 11, closed: true, code: connect.CodeNotFound, wantRec: "close o/r#11"},
		{name: "bad number: invalid argument, store not asked", number: -1, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client := newGhTest(t)
			open := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC)) // #7 open
			open.ViewerCanClose = true
			store.SetFullPullRequest("o/r", open)
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_8", Number: 8, State: gh.PullRequestMerged}, ViewerCanClose: true})
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_9", Number: 9, State: gh.PullRequestClosed}, ViewerCanClose: true, ViewerCanReopen: true})
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_10", Number: 10, State: gh.PullRequestOpen}})
			res, err := client.SetPullRequestClosed(ctx, connect.NewRequest(&v1.SetPullRequestClosedRequest{RepoSlug: "o/r", Number: tt.number, Closed: tt.closed}))
			rec := slices.Concat(callsWithPrefix(store.Calls(), "close "), callsWithPrefix(store.Calls(), "reopen "))
			if tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil || res.Msg.GetState() != tt.want.GetState() || res.Msg.GetMessage() != tt.want.GetMessage() {
				t.Errorf("response = %v, %v; want %v", res, err, tt.want)
			}
		})
	}
}

// The detail carries what the viewer may do: viewer_can_close and viewer_can_reopen.
func TestGhPullRequestDetailCloseFields(t *testing.T) {
	store, client := newGhTest(t)
	d := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))
	d.PullRequest.State, d.ViewerCanClose, d.ViewerCanReopen = gh.PullRequestClosed, true, true
	store.SetFullPullRequest("o/r", d)
	res, err := client.GetPullRequestDetail(context.Background(), connect.NewRequest(&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: int32(d.PullRequest.Number)}))
	if err != nil {
		t.Fatal(err)
	}
	if got := res.Msg.GetDetail(); !got.GetViewerCanClose() || !got.GetViewerCanReopen() {
		t.Errorf("viewer_can_close %t, viewer_can_reopen %t; want both", got.GetViewerCanClose(), got.GetViewerCanReopen())
	}
}
