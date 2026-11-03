package api

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func TestGhSetPullRequestDraft(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		number  int32
		draft   bool
		code    connect.Code
		want    *v1.SetPullRequestDraftResponse
		wantRec string
	}{
		{name: "ready", number: 9, want: &v1.SetPullRequestDraftResponse{Message: "Marked #9 ready for review"}, wantRec: "draft o/r#9 false"},
		{name: "to a draft", number: 7, draft: true, want: &v1.SetPullRequestDraftResponse{Draft: true, Message: "Converted #7 to a draft"}, wantRec: "draft o/r#7 true"},
		{name: "already so: failed precondition", number: 7, code: connect.CodeFailedPrecondition, wantRec: "draft o/r#7 false"},
		{name: "merged: failed precondition", number: 8, draft: true, code: connect.CodeFailedPrecondition, wantRec: "draft o/r#8 true"},
		{name: "unknown: not found", number: 10, code: connect.CodeNotFound, wantRec: "draft o/r#10 false"},
		{name: "bad number: invalid argument, store not asked", number: -1, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			store.SetFullPullRequest("o/r", detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))) // #7 open
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_8", Number: 8, State: gh.PullRequestMerged}})
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_9", Number: 9, State: gh.PullRequestOpen, Draft: true}})
			res, err := client.SetPullRequestDraft(ctx, connect.NewRequest(&v1.SetPullRequestDraftRequest{RepoSlug: "o/r", Number: tt.number, Draft: tt.draft}))
			if rec := callsWithPrefix(store.Calls(), "draft "); tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil || res.Msg.GetDraft() != tt.want.GetDraft() || res.Msg.GetMessage() != tt.want.GetMessage() {
				t.Errorf("response = %v, %v; want %v", res, err, tt.want)
			}
		})
	}
}

func TestGhSetPullRequestAutoMerge(t *testing.T) {
	ctx := context.Background()
	const squash = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_SQUASH
	tests := []struct {
		name    string
		req     *v1.SetPullRequestAutoMergeRequest
		allowed bool
		on      bool
		code    connect.Code
		want    *v1.SetPullRequestAutoMergeResponse
		wantRec string
	}{
		{name: "on with squash and the shown head", req: &v1.SetPullRequestAutoMergeRequest{Enabled: true, Method: squash, ExpectedHeadSha: "head-7"}, allowed: true,
			want: &v1.SetPullRequestAutoMergeResponse{Enabled: true, Method: squash, Message: "Auto-merge on for #7 with SQUASH"}, wantRec: "auto-merge o/r#7 on SQUASH head=head-7"},
		{name: "off ignores the method", req: &v1.SetPullRequestAutoMergeRequest{Method: squash, ExpectedHeadSha: "x"}, on: true,
			want: &v1.SetPullRequestAutoMergeResponse{Message: "Auto-merge off for #7"}, wantRec: "auto-merge o/r#7 off"},
		{name: "the repository does not allow it: failed precondition", req: &v1.SetPullRequestAutoMergeRequest{Enabled: true, Method: squash},
			code: connect.CodeFailedPrecondition, wantRec: "auto-merge o/r#7 on SQUASH"},
		{name: "no method to turn it on: invalid argument, store not asked", req: &v1.SetPullRequestAutoMergeRequest{Enabled: true}, allowed: true,
			code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			d := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))
			d.PullRequest.HeadSHA = "head-7"
			d.AutoMergeAllowed, d.AutoMerge = tt.allowed, tt.on
			store.SetFullPullRequest("o/r", d)
			tt.req.RepoSlug, tt.req.Number = "o/r", 7
			res, err := client.SetPullRequestAutoMerge(ctx, connect.NewRequest(tt.req))
			if rec := callsWithPrefix(store.Calls(), "auto-merge "); tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil || res.Msg.GetEnabled() != tt.want.GetEnabled() || res.Msg.GetMethod() != tt.want.GetMethod() || res.Msg.GetMessage() != tt.want.GetMessage() {
				t.Errorf("response = %v, %v; want %v", res, err, tt.want)
			}
		})
	}
}

func TestGhDetailAutoMergeFields(t *testing.T) {
	store, client, _ := newGhTest(t)
	d := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))
	d.AutoMergeAllowed, d.AutoMerge, d.AutoMergeMethod = true, true, gh.MergeRebase
	store.SetFullPullRequest("o/r", d)
	off := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))
	off.PullRequest.Number = 8
	store.SetFullPullRequest("o/r", off)
	for _, tt := range []struct {
		number  int32
		allowed bool
		method  v1.PullRequestMergeMethod
	}{{7, true, v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE}, {8, false, v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_UNSPECIFIED}} {
		res, err := client.GetPullRequestDetail(context.Background(), connect.NewRequest(&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: tt.number}))
		if err != nil {
			t.Fatal(err)
		}
		if got := res.Msg.GetDetail(); got.GetAutoMergeAllowed() != tt.allowed || got.GetAutoMergeMethod() != tt.method {
			t.Errorf("#%d: allowed %t, method %v; want %t, %v", tt.number, got.GetAutoMergeAllowed(), got.GetAutoMergeMethod(), tt.allowed, tt.method)
		}
	}
}

func callsWithPrefix(calls []string, prefix string) []string {
	var out []string
	for _, c := range calls {
		if strings.HasPrefix(c, prefix) {
			out = append(out, c)
		}
	}
	return out
}
