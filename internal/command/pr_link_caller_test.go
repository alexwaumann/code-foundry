package command_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

// prLinkJSON is the part of pr.create's and pr.revert's --json these tests read.
type prLinkJSON struct {
	URL        string              `json:"url"`
	Summary    string              `json:"summary"`
	ThreadLink *command.ThreadLink `json:"threadLink"`
}

func decodePRLinkJSON(t *testing.T, res command.Result) prLinkJSON {
	t.Helper()
	js, err := res.EncodeJSON()
	if err != nil {
		t.Fatal(err)
	}
	var out prLinkJSON
	if err := json.Unmarshal([]byte(js), &out); err != nil {
		t.Fatalf("json %s: %v", js, err)
	}
	return out
}

// pr.create links the pull request it opened, or the branch's open one it answered
// with, to the calling thread: the CLI's thread or the app's selected one. No thread, no
// URL or a failed create links nothing; a failed link is in the message, not an error.
func TestPRCreateLinksCallingThread(t *testing.T) {
	const url = "https://github.com/me/repo/pull/4"
	created := &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_SUCCEEDED, Summary: "created pull request #4", Url: url}
	exists := &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_SUCCEEDED, Summary: "pull request #4 already exists", Url: url}
	has := &v1.Thread{Name: "fix", LinkedPullRequests: []*v1.LinkedPullRequest{{Slug: "me/repo", Number: 4, Url: url}}}
	cli := command.Context{ActiveThreadID: "s-c", ActiveWorktreePath: "/gh"}
	app := command.Context{ActiveThreadID: "s-c", ActiveWorktreePath: "/gh", ActiveView: "thread"}
	tests := []struct {
		name     string
		ctx      command.Context
		op       *v1.GitOp
		current  *v1.Thread
		linkErr  error
		wantMsg  string
		wantLink *command.ThreadLink
		wantCode connect.Code
	}{
		{name: "no thread: nothing linked", ctx: command.Context{ActiveWorktreePath: "/gh"}, op: created,
			wantMsg: "created pull request #4: " + url},
		{name: "a thread's CLI", ctx: cli, op: created, current: &v1.Thread{Name: "fix"},
			wantMsg:  "created pull request #4: " + url + "\nlinked me/repo#4 to thread fix (s-c)",
			wantLink: &command.ThreadLink{ThreadID: "s-c", Linked: true, Slug: "me/repo", Number: 4, URL: url}},
		{name: "the app's selected thread", ctx: app, op: created,
			wantMsg:  "created pull request #4: " + url + "\nlinked me/repo#4 to thread s-c",
			wantLink: &command.ThreadLink{ThreadID: "s-c", Linked: true, Slug: "me/repo", Number: 4, URL: url}},
		{name: "already exists, already linked", ctx: cli, op: exists, current: has,
			wantMsg:  "pull request #4 already exists: " + url + "\nthread fix (s-c) already has me/repo#4 linked",
			wantLink: &command.ThreadLink{ThreadID: "s-c", Slug: "me/repo", Number: 4, URL: url}},
		{name: "already exists, not yet linked", ctx: cli, op: exists, current: &v1.Thread{Name: "fix"},
			wantMsg:  "pull request #4 already exists: " + url + "\nlinked me/repo#4 to thread fix (s-c)",
			wantLink: &command.ThreadLink{ThreadID: "s-c", Linked: true, Slug: "me/repo", Number: 4, URL: url}},
		{name: "link fails: the create still succeeds", ctx: cli, op: created, linkErr: connect.NewError(connect.CodeNotFound, errors.New("thread s-c not found")),
			wantMsg:  "created pull request #4: " + url + "\ncould not link " + url + " to thread s-c: thread s-c not found",
			wantLink: &command.ThreadLink{ThreadID: "s-c", URL: url, Error: "thread s-c not found"}},
		{name: "no URL in gh's answer: nothing linked", ctx: cli, op: &v1.GitOp{State: v1.GitOpState_GIT_OP_STATE_SUCCEEDED, Summary: "created pull request"},
			wantMsg: "created pull request"},
		{name: "failed create: nothing linked", ctx: cli, op: &v1.GitOp{Title: "Create PR", State: v1.GitOpState_GIT_OP_STATE_FAILED, Summary: "no commits"},
			wantCode: connect.CodeUnknown},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			gb := &commandtest.GitOps{Op: tt.op}
			tb := &commandtest.Thread{Current: tt.current, Err: tt.linkErr}
			if err := command.RegisterGitOps(reg, command.GitOpsDeps{
				Backend: gb, Link: tb, GitHubSlug: func(command.Context) string { return "me/repo" },
			}); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "pr.create", nil)
			if tt.wantCode != 0 {
				if connect.CodeOf(err) != tt.wantCode {
					t.Fatalf("err = %v, want code %v", err, tt.wantCode)
				}
				if reqs := tb.Requests(); len(reqs) != 0 {
					t.Errorf("link requests = %v, want none", reqs)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			got := decodePRLinkJSON(t, res)
			if got.URL != tt.op.GetUrl() || got.Summary != tt.op.GetSummary() {
				t.Errorf("json op fields = %+v, want the op's", got)
			}
			if !jsonEqual(got.ThreadLink, tt.wantLink) {
				t.Errorf("threadLink = %+v, want %+v", got.ThreadLink, tt.wantLink)
			}
			reqs := tb.Requests()
			if tt.wantLink == nil {
				if len(reqs) != 0 {
					t.Errorf("link requests = %v, want none", reqs)
				}
				if _, ok := res.JSON.(*v1.GitOp); !ok {
					t.Errorf("JSON = %T, want the op unchanged", res.JSON)
				}
				return
			}
			want := &v1.LinkThreadPullRequestRequest{Id: "s-c", PullRequest: url}
			if len(reqs) != 1 || !proto.Equal(reqs[0], want) {
				t.Errorf("link requests = %v, want %v", reqs, want)
			}
		})
	}
}

// pr.revert links the revert pull request to the calling thread, as pr.create does.
func TestPRRevertLinksCallingThread(t *testing.T) {
	const url = "https://github.com/o/r/pull/99"
	tests := []struct {
		name     string
		ctx      command.Context
		wantMsg  string
		wantLink *command.ThreadLink
	}{
		{name: "no thread: nothing linked", wantMsg: "Opened #99 to revert #7: " + url},
		{name: "a thread's CLI", ctx: command.Context{ActiveThreadID: "s-c"},
			wantMsg:  "Opened #99 to revert #7: " + url + "\nlinked o/r#99 to thread s-c",
			wantLink: &command.ThreadLink{ThreadID: "s-c", Linked: true, Slug: "o/r", Number: 99, URL: url}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg := command.NewRegistry()
			tb := &commandtest.Thread{}
			if err := command.RegisterPullRequest(reg, &commandtest.Gh{}, tb); err != nil {
				t.Fatal(err)
			}
			res, err := reg.Invoke(context.Background(), tt.ctx, "pr.revert", map[string]string{"repo-slug": "o/r", "number": "7"}, command.Confirmed(true))
			if err != nil {
				t.Fatal(err)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
			got := decodePRLinkJSON(t, res)
			if got.URL != url {
				t.Errorf("json url = %q, want %q", got.URL, url)
			}
			if !jsonEqual(got.ThreadLink, tt.wantLink) {
				t.Errorf("threadLink = %+v, want %+v", got.ThreadLink, tt.wantLink)
			}
			if n := len(tb.Requests()); (tt.wantLink != nil) != (n == 1) || n > 1 {
				t.Errorf("link requests = %v", tb.Requests())
			}
		})
	}
}

func jsonEqual(a, b *command.ThreadLink) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}
