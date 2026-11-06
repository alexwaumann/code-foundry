package api

import (
	"context"
	"slices"
	"testing"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

func TestGhSetPullRequestCheckbox(t *testing.T) {
	ctx := context.Background()
	tests := []struct {
		name    string
		req     *v1.SetPullRequestCheckboxRequest
		code    connect.Code
		wantMsg string
		wantRec string
	}{
		{name: "ticks", req: &v1.SetPullRequestCheckboxRequest{RepoSlug: "o/r", Number: 7, Index: 1, Text: "b", Checked: true},
			wantMsg: "Changed task 2 on #7", wantRec: "checkbox o/r#7 1 true b"},
		{name: "the item changed: failed precondition", req: &v1.SetPullRequestCheckboxRequest{RepoSlug: "o/r", Number: 7, Text: "old", Checked: true},
			code: connect.CodeFailedPrecondition, wantRec: "checkbox o/r#7 0 true old"},
		{name: "unknown: not found", req: &v1.SetPullRequestCheckboxRequest{RepoSlug: "o/r", Number: 8, Text: "a"},
			code: connect.CodeNotFound, wantRec: "checkbox o/r#8 0 false a"},
		{name: "bad number: invalid argument, store not asked", req: &v1.SetPullRequestCheckboxRequest{RepoSlug: "o/r", Number: -1},
			code: connect.CodeInvalidArgument},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			store, client, _ := newGhTest(t)
			store.SetFullPullRequest("o/r", gh.FullPullRequest{PullRequest: gh.PullRequest{ID: "PR_7", Number: 7, State: gh.PullRequestOpen}, Body: "- [x] a\n- [ ] b\n"})
			res, err := client.SetPullRequestCheckbox(ctx, connect.NewRequest(tt.req))
			if rec := callsWithPrefix(store.Calls(), "checkbox "); tt.wantRec == "" && len(rec) != 0 || tt.wantRec != "" && !slices.Equal(rec, []string{tt.wantRec}) {
				t.Errorf("store calls = %q, want %q", rec, tt.wantRec)
			}
			if tt.code != 0 {
				if connect.CodeOf(err) != tt.code {
					t.Errorf("err = %v, want %v", err, tt.code)
				}
				return
			}
			if err != nil || !res.Msg.GetChanged() || res.Msg.GetMessage() != tt.wantMsg {
				t.Errorf("response = %v, %v; want %q", res, err, tt.wantMsg)
			}
		})
	}
}
