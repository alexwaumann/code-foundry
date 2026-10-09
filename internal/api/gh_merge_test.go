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

func TestGhMergePullRequest(t *testing.T) {
	ctx := context.Background()
	at := time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC)
	const (
		methodMerge  = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_MERGE
		methodSquash = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_SQUASH
		methodRebase = v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE
	)
	tests := []struct {
		name    string
		number  int32
		method  v1.PullRequestMergeMethod
		del     bool
		head    string // expected_head_sha
		code    connect.Code
		want    *v1.MergePullRequestResponse
		wantRec string // what the store was asked; "" for nothing
	}{
		{name: "squash and delete", number: 7, method: methodSquash, del: true,
			want:    &v1.MergePullRequestResponse{Merged: true, Sha: "merge-7", Message: "Merged #7 (merge-7); deleted origin/fix", BranchDeleted: true},
			wantRec: "merge o/r#7 SQUASH delete=true"},
		{name: "the shown head is passed through", number: 7, method: methodSquash, head: "head-7",
			want: &v1.MergePullRequestResponse{Merged: true, Sha: "merge-7", Message: "Merged #7 (merge-7)"}, wantRec: "merge o/r#7 SQUASH delete=false head=head-7"},
		{name: "head changed since shown: failed precondition", number: 7, method: methodSquash, head: "older",
			code: connect.CodeFailedPrecondition, wantRec: "merge o/r#7 SQUASH delete=false head=older"},
		{name: "merge commit", number: 7, method: methodMerge,
			want: &v1.MergePullRequestResponse{Merged: true, Sha: "merge-7", Message: "Merged #7 (merge-7)"}, wantRec: "merge o/r#7 MERGE delete=false"},
		{name: "rebase", number: 7, method: methodRebase,
			want: &v1.MergePullRequestResponse{Merged: true, Sha: "merge-7", Message: "Merged #7 (merge-7)"}, wantRec: "merge o/r#7 REBASE delete=false"},
		{name: "no method: invalid argument, store not asked", number: 7, code: connect.CodeInvalidArgument},
		{name: "draft: failed precondition", number: 9, method: methodSquash, code: connect.CodeFailedPrecondition, wantRec: "merge o/r#9 SQUASH delete=false"},
		{name: "merged: failed precondition", number: 8, method: methodSquash, code: connect.CodeFailedPrecondition, wantRec: "merge o/r#8 SQUASH delete=false"},
		{name: "unknown", number: 10, method: methodSquash, code: connect.CodeNotFound, wantRec: "merge o/r#10 SQUASH delete=false"},
		{name: "bad number", number: -1, method: methodSquash, code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			open := detailFixture(at) // #7 open
			open.PullRequest.HeadRef, open.PullRequest.HeadSHA = "fix", "head-7"
			store.SetFullPullRequest("o/r", open)
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_8", Number: 8, State: gh.PullRequestMerged}})
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_9", Number: 9, State: gh.PullRequestOpen, Draft: true}})
			res, err := client.MergePullRequest(ctx, connect.NewRequest(&v1.MergePullRequestRequest{
				RepoSlug: "o/r", Number: tt.number, Method: tt.method, DeleteBranch: tt.del, ExpectedHeadSha: tt.head,
			}))
			var rec []string
			for _, c := range store.Calls() {
				if strings.HasPrefix(c, "merge ") {
					rec = append(rec, c)
				}
			}
			if tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
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
			got := res.Msg
			if got.GetMerged() != tt.want.GetMerged() || got.GetSha() != tt.want.GetSha() || got.GetMessage() != tt.want.GetMessage() ||
				got.GetBranchDeleted() != tt.want.GetBranchDeleted() {
				t.Errorf("response = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestGhDetailMergeFields(t *testing.T) {
	store, client, _ := newGhTest(t)
	d := detailFixture(time.Date(2026, 10, 9, 6, 0, 0, 0, time.UTC))
	d.MergeMethods = []gh.MergeMethod{gh.MergeCommit, gh.MergeRebase}
	d.AutoMerge = true
	d.DefaultBranch = "trunk"
	store.SetFullPullRequest("o/r", d)
	res, err := client.GetPullRequestDetail(context.Background(), connect.NewRequest(&v1.GetPullRequestDetailRequest{RepoSlug: "o/r", Number: 7}))
	if err != nil {
		t.Fatal(err)
	}
	want := []v1.PullRequestMergeMethod{v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_MERGE, v1.PullRequestMergeMethod_PULL_REQUEST_MERGE_METHOD_REBASE}
	if got := res.Msg.GetDetail(); !slices.Equal(got.GetMergeMethodsAllowed(), want) || !got.GetAutoMergeEnabled() || got.GetDefaultBranch() != "trunk" {
		t.Errorf("methods %v, auto-merge %t, default branch %q", got.GetMergeMethodsAllowed(), got.GetAutoMergeEnabled(), got.GetDefaultBranch())
	}
}
