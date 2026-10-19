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
	return &v1.Worktree{ProjectId: "r1", Branch: branch, Path: path, MergedClean: true, Status: &v1.GitStatus{BaseRef: "origin/main"}}
}

// cleanupFixture is a registry with project.worktree.cleanup over fakes sharing one call
// log. Project r1 ("proj", origin) has main at /p and the worktrees a (merged) and b
// (unmerged); r2 ("local") has no remote.
func cleanupFixture(t *testing.T, dry, real *v1.CleanupWorktreesResponse) (*command.Registry, *commandtest.Calls, *commandtest.Project, *commandtest.GitOps) {
	t.Helper()
	shared := &commandtest.Calls{}
	project := &commandtest.Project{
		Calls: commandtest.Calls{Shared: shared},
		Projects: []*v1.Project{
			{Id: "r1", Name: "proj", Path: "/p", Remotes: []string{"origin"}, Git: true, Worktrees: []*v1.Worktree{{Path: "/p", IsMain: true}}},
			{Id: "r2", Name: "local", Path: "/l", Git: true},
		},
		OnCleanup: func(req *v1.CleanupWorktreesRequest) (*v1.CleanupWorktreesResponse, error) {
			id := map[string]string{"proj": "r1", "r1": "r1", "local": "r2", "r2": "r2"}[req.GetProject()]
			if id == "" {
				return nil, connect.NewError(connect.CodeNotFound, errors.New("repository not registered"))
			}
			res := real
			if req.GetDryRun() {
				res = dry
			}
			res = proto.CloneOf(res)
			res.ProjectId = id
			return res, nil
		},
	}
	ops := &commandtest.GitOps{Calls: commandtest.Calls{Shared: shared}}
	reg := command.NewRegistry()
	if err := command.RegisterProjectCleanup(reg, command.ProjectCleanupDeps{
		Project: project, GitOps: ops,
		NotGit: func(c command.Context) bool { return c.ActiveProjectID == "plain" },
	}); err != nil {
		t.Fatal(err)
	}
	return reg, shared, project, ops
}

const inMain = "branch is in origin/main"

func TestProjectCleanupArgsAndFlow(t *testing.T) {
	merged := cleanWt("cf/a", "/wt/a")
	unmerged := &v1.Worktree{ProjectId: "r1", Branch: "cf/b", Path: "/wt/b"}
	dry := &v1.CleanupWorktreesResponse{ProjectId: "r1", Removed: []*v1.RemovedWorktree{{Worktree: merged, Reason: inMain}}, Skipped: []*v1.SkippedWorktree{{Worktree: unmerged, Reason: "1 commit not in origin/main"}}}
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
			name: "project by name, every worktree", args: map[string]string{"project": "proj"},
			real:    &v1.CleanupWorktreesResponse{ProjectId: "r1", Removed: dry.Removed, Skipped: dry.Skipped},
			wantSeq: []string{"CleanupWorktreesRequest", "ListProjectsRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Project: "proj"},
			wantMsg: "Removed 1 worktree: cf/a (branch is in origin/main); kept 1 worktree: cf/b (1 commit not in origin/main)",
		},
		{
			name: "repo from the context, one path", ctx: command.Context{ActiveProjectID: "r1"}, args: map[string]string{"path": "/wt/a"},
			real:    &v1.CleanupWorktreesResponse{ProjectId: "r1", Removed: dry.Removed},
			wantSeq: []string{"CleanupWorktreesRequest", "ListProjectsRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Project: "r1", Path: "/wt/a"},
			wantMsg: "Removed 1 worktree: cf/a (branch is in origin/main)",
		},
		{
			name: "after the fetch it is no longer merged", args: map[string]string{"project": "r1", "path": "/wt/a"},
			real:    &v1.CleanupWorktreesResponse{ProjectId: "r1", Skipped: []*v1.SkippedWorktree{{Worktree: merged, Reason: "2 commits not in origin/main"}}},
			wantSeq: []string{"CleanupWorktreesRequest", "ListProjectsRequest", "GitFetchRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Project: "r1", Path: "/wt/a"},
			wantMsg: "Nothing removed; kept 1 worktree: cf/a (2 commits not in origin/main)",
		},
		{
			name: "no origin: no fetch", args: map[string]string{"project": "local"},
			real:    &v1.CleanupWorktreesResponse{ProjectId: "r2"},
			wantSeq: []string{"CleanupWorktreesRequest", "ListProjectsRequest", "CleanupWorktreesRequest"},
			wantReq: &v1.CleanupWorktreesRequest{Project: "local"},
			wantMsg: "No worktrees to clean up",
		},
		{name: "project is required", args: map[string]string{}, wantErr: "project"},
		{name: "unknown project: nothing fetched", args: map[string]string{"project": "nope"}, wantErr: "not registered", wantSeq: []string{"CleanupWorktreesRequest"}},
		{name: "project without git", ctx: command.Context{ActiveProjectID: "plain"}, args: map[string]string{}, wantErr: "not a git repository"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, shared, _, _ := cleanupFixture(t, dry, tt.real)
			res, err := reg.Invoke(context.Background(), tt.ctx, "project.worktree.cleanup", tt.args, command.Confirmed(true))
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
			if last.GetDryRun() || last.GetProject() != tt.wantReq.GetProject() || last.GetPath() != tt.wantReq.GetPath() {
				t.Errorf("cleanup request = %v, want %v", last, tt.wantReq)
			}
			if res.Message != tt.wantMsg {
				t.Errorf("message = %q, want %q", res.Message, tt.wantMsg)
			}
		})
	}
}

func TestProjectCleanupFetchFailureRemovesNothing(t *testing.T) {
	reg, shared, _, ops := cleanupFixture(t, &v1.CleanupWorktreesResponse{ProjectId: "r1"}, &v1.CleanupWorktreesResponse{ProjectId: "r1"})
	ops.Op = &v1.GitOp{Title: "Fetch origin", State: v1.GitOpState_GIT_OP_STATE_FAILED, Summary: "could not read from remote"}
	_, err := reg.Invoke(context.Background(), command.Context{}, "project.worktree.cleanup", map[string]string{"project": "proj"}, command.Confirmed(true))
	if err == nil || !strings.Contains(err.Error(), "could not read from remote") {
		t.Fatalf("err = %v, want the fetch failure", err)
	}
	for _, m := range shared.Requests() {
		if c, ok := m.(*v1.CleanupWorktreesRequest); ok && !c.GetDryRun() {
			t.Fatalf("cleanup ran after a failed fetch: %v", c)
		}
	}
}

// The prompt without --yes is the dry run in full: every worktree that would go and
// every one kept, with branch, path and why.
func TestProjectCleanupConfirmListsWhatGoesAndStays(t *testing.T) {
	a, b, c := cleanWt("cf/a", "/wt/a"), cleanWt("cf/b", "/wt/b"), cleanWt("cf/c", "/wt/c")
	hand := &v1.Worktree{ProjectId: "r1", Branch: "by-hand", Path: "/wt/by-hand"}
	removed := []*v1.RemovedWorktree{
		{Worktree: a, Reason: inMain},
		{Worktree: b, Reason: "its changes are in origin/main (rebased or squash-merged)"},
	}
	kept := []*v1.SkippedWorktree{
		{Worktree: c, Reason: "just made, no commits yet (kept for 10m0s)"},
		{Worktree: hand, Reason: "not a Code Foundry worktree"},
	}
	tests := []struct {
		name string
		args map[string]string
		dry  *v1.CleanupWorktreesResponse
		want string
	}{
		{
			name: "every worktree", args: map[string]string{"project": "proj"},
			dry: &v1.CleanupWorktreesResponse{ProjectId: "r1", Removed: removed, Skipped: kept},
			want: "Fetch, then remove 2 worktrees (branches are kept; each is checked again after the fetch):\n" +
				"- cf/a at /wt/a: branch is in origin/main\n" +
				"- cf/b at /wt/b: its changes are in origin/main (rebased or squash-merged)\n" +
				"Keep 2:\n" +
				"- cf/c at /wt/c: just made, no commits yet (kept for 10m0s)\n" +
				"- by-hand at /wt/by-hand: not a Code Foundry worktree",
		},
		{
			name: "nothing removable yet", args: map[string]string{"project": "proj"},
			dry: &v1.CleanupWorktreesResponse{ProjectId: "r1", Skipped: kept[1:]},
			want: "Fetch and remove the worktrees Code Foundry made whose work is in the default branch? None would be removed now; each is checked again after the fetch.\n" +
				"Keep 1:\n" +
				"- by-hand at /wt/by-hand: not a Code Foundry worktree",
		},
		{
			name: "one path that goes", args: map[string]string{"project": "proj", "path": "/wt/a"},
			dry:  &v1.CleanupWorktreesResponse{ProjectId: "r1", Removed: removed[:1]},
			want: "Remove the worktree of cf/a at /wt/a (branch is in origin/main)? The branch is kept. It is checked again after a fetch.",
		},
		{
			name: "one path that stays", args: map[string]string{"project": "proj", "path": "/wt/c"},
			dry:  &v1.CleanupWorktreesResponse{ProjectId: "r1", Skipped: kept[:1]},
			want: "Fetch and check the worktree of cf/c at /wt/c again? Right now it is kept: just made, no commits yet (kept for 10m0s).",
		},
		{
			name: "no worktrees at all", args: map[string]string{"project": "proj"},
			dry:  &v1.CleanupWorktreesResponse{ProjectId: "r1"},
			want: "Fetch proj and remove the worktrees Code Foundry made whose work is already in the default branch? Branches are kept.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reg, shared, _, _ := cleanupFixture(t, tt.dry, nil)
			_, err := reg.Invoke(context.Background(), command.Context{}, "project.worktree.cleanup", tt.args)
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
