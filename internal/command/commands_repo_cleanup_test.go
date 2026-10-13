package command_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/command/commandtest"
)

func cleanWt(branch, path string) *v1.Worktree {
	return &v1.Worktree{RepoId: "r1", Branch: branch, Path: path, MergedClean: true, Status: &v1.GitStatus{BaseRef: "origin/main"}}
}

// cleanupFixture is a registry with repo.worktree.cleanup over fakes sharing one call
// log. Repo r1 ("proj", origin) has main at /p and the worktrees a (merged) and b
// (unmerged); r2 ("local") has no remote.
func cleanupFixture(t *testing.T, dry, real *v1.CleanupWorktreesResponse) (*command.Registry, *commandtest.Calls, *commandtest.Repo, *commandtest.GitOps) {
	t.Helper()
	shared := &commandtest.Calls{}
	repo := &commandtest.Repo{
		Calls: commandtest.Calls{Shared: shared},
		Repos: []*v1.Repo{
			{Id: "r1", Name: "proj", Path: "/p", Remotes: []string{"origin"}, Git: true, Worktrees: []*v1.Worktree{{Path: "/p", IsMain: true}}},
			{Id: "r2", Name: "local", Path: "/l", Git: true},
		},
		OnCleanup: func(req *v1.CleanupWorktreesRequest) (*v1.CleanupWorktreesResponse, error) {
			id := map[string]string{"proj": "r1", "r1": "r1", "local": "r2", "r2": "r2"}[req.GetRepo()]
			if id == "" {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("repository not registered"))
			}
			res := real
			if req.GetDryRun() {
				res = dry
			}
			res = proto.CloneOf(res)
			res.RepoId = id
			return res, nil
		},
	}
	ops := &commandtest.GitOps{Calls: commandtest.Calls{Shared: shared}}
	reg := command.NewRegistry()
	if err := command.RegisterRepoCleanup(reg, command.RepoCleanupDeps{
		Repo: repo, GitOps: ops,
		NotGit: func(c command.Context) bool { return c.ActiveRepoID == "plain" },
	}); err != nil {
		t.Fatal(err)
	}
	return reg, shared, repo, ops
}

func TestRepoCleanupArgsAndFlow(t *testing.T) {
	merged := cleanWt("cf/a", "/wt/a")
	unmerged := &v1.Worktree{RepoId: "r1", Branch: "cf/b", Path: "/wt/b"}
	dry := &v1.CleanupWorktreesResponse{RepoId: "r1", Removed: []*v1.Worktree{merged}, Skipped: []*v1.SkippedWorktree{{Worktree: unmerged, Reason: "1 commit not in origin/main"}}}
	tests := []struct {
		name    string
		ctx     command.Context
		args    map[string]string
		real    *v1.CleanupWorktreesResponse
		wantErr string
		// wantSeq is the request types in call order, wantReq the last cleanup request.
		wantSeq []string
		wantReq *v1.CleanupWorktreesRequest
		wantMsg string
	}{
		{
			name: "repo by name, every worktree", args: map[string]string{"repo": "proj"},
			real:    &v1.CleanupWorktreesResponse{RepoId: "r1", Removed: []*v1.Worktree{merged}, Skipped: dry.Skipped},
			wantSeq: []string{"CleanupWorktreesRequest", "ListReposRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Repo: "proj"},
			wantMsg: "Removed 1 worktree: cf/a; kept 1 worktree: cf/b (1 commit not in origin/main)",
		},
		{
			name: "repo from the context, one path", ctx: command.Context{ActiveRepoID: "r1"}, args: map[string]string{"path": "/wt/a"},
			real:    &v1.CleanupWorktreesResponse{RepoId: "r1", Removed: []*v1.Worktree{merged}},
			wantSeq: []string{"CleanupWorktreesRequest", "ListReposRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Repo: "r1", Path: "/wt/a"},
			wantMsg: "Removed 1 worktree: cf/a",
		},
		{
			name: "after the fetch it is no longer merged", args: map[string]string{"repo": "r1", "path": "/wt/a"},
			real:    &v1.CleanupWorktreesResponse{RepoId: "r1", Skipped: []*v1.SkippedWorktree{{Worktree: merged, Reason: "2 commits not in origin/main"}}},
			wantSeq: []string{"CleanupWorktreesRequest", "ListReposRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Repo: "r1", Path: "/wt/a"},
			wantMsg: "Nothing removed; kept 1 worktree: cf/a (2 commits not in origin/main)",
		},
		{
			name: "no origin: no fetch", args: map[string]string{"repo": "local"},
			real:    &v1.CleanupWorktreesResponse{RepoId: "r2"},
			wantSeq: []string{"CleanupWorktreesRequest", "ListReposRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Repo: "local"},
			wantMsg: "No worktrees to clean up",
		},
		{name: "repo is required", args: map[string]string{}, wantErr: "repo"},
		{name: "unknown repo: nothing fetched", args: map[string]string{"repo": "nope"}, wantErr: "not registered", wantSeq: []string{"CleanupWorktreesRequest"}},
		{name: "project without git", ctx: command.Context{ActiveRepoID: "plain"}, args: map[string]string{}, wantErr: "not a git repository"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, shared, _, _ := cleanupFixture(t, dry, tt.real)
			res, err := reg.Invoke(context.Background(), tt.ctx, "repo.worktree.cleanup", tt.args, command.Confirmed(true))
			if tt.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
					t.Fatalf("err = %v, want it to contain %q", err, tt.wantErr)
				}
			} else if err != nil {
				t.Fatal(err)
			}
			var seq []string
			var last *v1.CleanupWorktreesRequest
			for _, m := range shared.Requests() {
				seq = append(seq, string(m.ProtoReflect().Descriptor().Name()))
				if c, ok := m.(*v1.CleanupWorktreesRequest); ok {
					last = c
				}
			}
			if strings.Join(seq, ",") != strings.Join(tt.wantSeq, ",") {
				t.Errorf("calls = %v, want %v", seq, tt.wantSeq)
			}
			if tt.wantErr != "" {
				return
			}
			if last.GetDryRun() || last.GetRepo() != tt.wantReq.GetRepo() || last.GetPath() != tt.wantReq.GetPath() {
				t.Errorf("cleanup request = %v, want %v", last, tt.wantReq)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
		})
	}
}

func TestRepoCleanupFetchFailureRemovesNothing(t *testing.T) {
	reg, shared, _, ops := cleanupFixture(t, &v1.CleanupWorktreesResponse{RepoId: "r1"}, &v1.CleanupWorktreesResponse{RepoId: "r1"})
	ops.Op = &v1.GitOp{Title: "Fetch origin", State: v1.GitOpState_GIT_OP_STATE_FAILED, Summary: "could not read from remote"}
	_, err := reg.Invoke(context.Background(), command.Context{}, "repo.worktree.cleanup", map[string]string{"repo": "proj"}, command.Confirmed(true))
	if err == nil || !strings.Contains(err.Error(), "could not read from remote") {
		t.Fatalf("err = %v, want the fetch failure", err)
	}
	for _, m := range shared.Requests() {
		if c, ok := m.(*v1.CleanupWorktreesRequest); ok && !c.GetDryRun() {
			t.Fatalf("cleanup ran after a failed fetch: %v", c)
		}
	}
}

func TestRepoCleanupConfirmListsBranches(t *testing.T) {
	a, b := cleanWt("cf/a", "/wt/a"), cleanWt("cf/b", "/wt/b")
	tests := []struct {
		name string
		args map[string]string
		dry  *v1.CleanupWorktreesResponse
		want string
	}{
		{
			name: "every merged worktree", args: map[string]string{"repo": "proj"},
			dry:  &v1.CleanupWorktreesResponse{RepoId: "r1", Removed: []*v1.Worktree{a, b}},
			want: "Remove 2 worktrees whose work is in origin/main: cf/a, cf/b? Branches are kept; each is checked again after a fetch.",
		},
		{
			name: "one path", args: map[string]string{"repo": "proj", "path": "/wt/a"},
			dry:  &v1.CleanupWorktreesResponse{RepoId: "r1", Removed: []*v1.Worktree{a}},
			want: "Remove the worktree of cf/a (/wt/a)? Its work is in origin/main; the branch is kept. It is checked again after a fetch.",
		},
		{
			name: "nothing merged yet", args: map[string]string{"repo": "proj"},
			dry:  &v1.CleanupWorktreesResponse{RepoId: "r1"},
			want: "Fetch proj and remove its worktrees whose work is already in the default branch? Branches are kept.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, shared, _, _ := cleanupFixture(t, tt.dry, nil)
			_, err := reg.Invoke(context.Background(), command.Context{}, "repo.worktree.cleanup", tt.args)
			var ce *command.ConfirmError
			if !errors.As(err, &ce) {
				t.Fatalf("err = %v, want a confirmation", err)
			}
			if ce.Message != tt.want {
				t.Errorf("prompt = %q\nwant     %q", ce.Message, tt.want)
			}
			for _, m := range shared.Requests() {
				if c, ok := m.(*v1.CleanupWorktreesRequest); !ok || !c.GetDryRun() {
					t.Errorf("confirming made a call other than a dry run: %v", m)
				}
			}
		})
	}
}
