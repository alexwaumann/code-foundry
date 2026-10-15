package api

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func TestGhSubmitPullRequestReview(t *testing.T) {
	ctx := context.Background()
	at := timestamppb.New(time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	const (
		approve = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_APPROVE
		changes = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_REQUEST_CHANGES
		comment = v1.PullRequestReviewEvent_PULL_REQUEST_REVIEW_EVENT_COMMENT
	)
	tests := []struct {
		name    string
		req     *v1.SubmitPullRequestReviewRequest
		storeEr error
		code    connect.Code
		errHas  string
		want    *v1.SubmitPullRequestReviewResponse
		wantRec string // what the store was asked; "" for nothing
	}{
		{name: "approve without a body", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "O/R", Number: 8, Event: approve},
			want: &v1.SubmitPullRequestReviewResponse{Id: "PRR_8_0", Url: "https://github.com/o/r/pull/8#pullrequestreview-0",
				State: v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_APPROVED, Author: "octocat", SubmittedAt: at},
			wantRec: "review-submit o/r#8 APPROVE "},
		{name: "request changes", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: changes, Body: " fix x "},
			want: &v1.SubmitPullRequestReviewResponse{Id: "PRR_8_0", Url: "https://github.com/o/r/pull/8#pullrequestreview-0",
				State: v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_CHANGES_REQUESTED, Author: "octocat", SubmittedAt: at},
			wantRec: "review-submit o/r#8 REQUEST_CHANGES fix x"},
		{name: "comment on one's own", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: comment, Body: "note"},
			want: &v1.SubmitPullRequestReviewResponse{Id: "PRR_7_2", Url: "https://github.com/o/r/pull/7#pullrequestreview-2",
				State: v1.PullRequestReviewState_PULL_REQUEST_REVIEW_STATE_COMMENTED, Author: "octocat", SubmittedAt: at},
			wantRec: "review-submit o/r#7 COMMENT note"},
		{name: "approving one's own: failed precondition with GitHub's message", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 7, Event: approve},
			code: connect.CodeFailedPrecondition, errHas: "Can not approve your own pull request", wantRec: "review-submit o/r#7 APPROVE "},
		{name: "no event: invalid argument, store not asked", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Body: "x"},
			code: connect.CodeInvalidArgument},
		{name: "comment without a body: invalid argument", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: comment, Body: "  "},
			code: connect.CodeInvalidArgument},
		{name: "request changes without a body: invalid argument", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: changes},
			code: connect.CodeInvalidArgument},
		{name: "too long: invalid argument", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: approve, Body: strings.Repeat("x", gh.MaxCommentChars+1)},
			code: connect.CodeInvalidArgument},
		{name: "unknown pull request", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 10, Event: approve},
			code: connect.CodeNotFound, wantRec: "review-submit o/r#10 APPROVE "},
		{name: "bad slug", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "x", Number: 8, Event: approve}, code: connect.CodeInvalidArgument},
		{name: "no write access is permission denied", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: approve},
			storeEr: gh.ErrPermissionDenied, code: connect.CodePermissionDenied, wantRec: "review-submit o/r#8 APPROVE "},
		{name: "rate limited", req: &v1.SubmitPullRequestReviewRequest{RepoSlug: "o/r", Number: 8, Event: approve},
			storeEr: gh.ErrRateLimited, code: connect.CodeResourceExhausted, wantRec: "review-submit o/r#8 APPROVE "},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			store.SetViewer(gh.ViewerState{Authenticated: true, Viewer: &gh.Viewer{Login: "octocat"}})
			store.SetFullPullRequest("o/r", detailFixture(time.Time{})) // #7 by octocat, two comments
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_8", Number: 8, Author: "kim", State: gh.PullRequestOpen}})
			store.SetError(tt.storeEr)
			stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchGhRequest{}))
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			res, err := client.SubmitPullRequestReview(ctx, connect.NewRequest(tt.req))
			if rec := reviewCalls(store.Calls()); tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code || !strings.Contains(err.Error(), tt.errHas) {
					t.Errorf("err = %v, want %v containing %q", err, tt.code, tt.errHas)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(res.Msg, tt.want) {
				t.Errorf("got %v, want %v", res.Msg, tt.want)
			}
			waitDetailEvent(t, stream, tt.req.GetNumber())
		})
	}
}

func TestGhAddPullRequestComment(t *testing.T) {
	ctx := context.Background()
	at := timestamppb.New(time.Date(2026, 10, 15, 12, 0, 0, 0, time.UTC))
	tests := []struct {
		name    string
		req     *v1.AddPullRequestCommentRequest
		code    connect.Code
		want    *v1.AddPullRequestCommentResponse
		wantRec string
	}{
		{name: "posted, trimmed", req: &v1.AddPullRequestCommentRequest{RepoSlug: "O/R", Number: 7, Body: "\n thanks \n"},
			want:    &v1.AddPullRequestCommentResponse{Id: "IC_7_2", Url: "https://github.com/o/r/pull/7#issuecomment-2", CreatedAt: at},
			wantRec: "comment o/r#7 thanks"},
		{name: "empty body: invalid argument, store not asked", req: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 7, Body: " "},
			code: connect.CodeInvalidArgument},
		{name: "too long: invalid argument", req: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 7, Body: strings.Repeat("é", gh.MaxCommentChars+1)},
			code: connect.CodeInvalidArgument},
		{name: "unknown pull request", req: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 10, Body: "x"},
			code: connect.CodeNotFound, wantRec: "comment o/r#10 x"},
		{name: "bad number", req: &v1.AddPullRequestCommentRequest{RepoSlug: "o/r", Number: 0, Body: "x"}, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			store.SetFullPullRequest("o/r", detailFixture(time.Time{}))
			stream, err := client.Watch(ctx, connect.NewRequest(&v1.WatchGhRequest{}))
			if err != nil {
				t.Fatal(err)
			}
			defer stream.Close()
			res, err := client.AddPullRequestComment(ctx, connect.NewRequest(tt.req))
			if rec := reviewCalls(store.Calls()); tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if !proto.Equal(res.Msg, tt.want) {
				t.Errorf("got %v, want %v", res.Msg, tt.want)
			}
			waitDetailEvent(t, stream, tt.req.GetNumber())
			// The comment is in the detail clients re-read.
			d, err := client.GetPullRequestDetail(ctx, connect.NewRequest(&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7}))
			if err != nil {
				t.Fatal(err)
			}
			if cs := d.Msg.GetDetail().GetComments(); len(cs) != 3 || cs[2].GetBody() != "thanks" ||
				cs[2].GetKind() != v1.PullRequestCommentKind_PULL_REQUEST_COMMENT_KIND_ISSUE_COMMENT {
				t.Errorf("comments after = %v", cs)
			}
		})
	}
}

// reviewCalls keeps the fake store's review and comment calls.
func reviewCalls(calls []string) []string {
	var out []string
	for _, c := range calls {
		if strings.HasPrefix(c, "review-submit ") || strings.HasPrefix(c, "comment ") {
			out = append(out, c)
		}
	}
	return out
}

// waitDetailEvent reads the Watch stream until pull_request_detail_updated for o/r#n.
func waitDetailEvent(t *testing.T, stream *connect.ServerStreamForClient[v1.GhEvent], n int32) {
	t.Helper()
	for stream.Receive() {
		if ev := stream.Msg().GetPullRequestDetailUpdated(); ev != nil && ev.GetNumber() == n {
			if ev.GetRepoSlug() != "o/r" {
				t.Errorf("event = %v", ev)
			}
			return
		}
	}
	t.Errorf("no detail event for #%d: %v", n, stream.Err())
}
