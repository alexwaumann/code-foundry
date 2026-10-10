package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
	"github.com/alexwaumann/code-foundry/internal/store/workspace"
	"github.com/alexwaumann/code-foundry/internal/store/workspace/workspacetest"
)

func newWorkspaceServer(t *testing.T) (*workspacetest.Fake, codefoundryv1connect.WorkspaceServiceClient) {
	t.Helper()
	b := bus.New()
	fake := workspacetest.New(b)
	route := NewWorkspace(fake, b).Route()
	mux := http.NewServeMux()
	mux.Handle(route.Path, route.Handler)
	srv := httptest.NewUnstartedServer(mux)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	t.Cleanup(srv.Close)
	return fake, codefoundryv1connect.NewWorkspaceServiceClient(srv.Client(), srv.URL)
}

func TestWorkspaceUnaryAndErrorCodes(t *testing.T) {
	fake, c := newWorkspaceServer(t)
	fake.Repos = func() *repo.Snapshot {
		return &repo.Snapshot{Repos: []repo.Repo{{ID: "web", Name: "web-ui", Worktrees: []repo.Worktree{
			{RepoID: "web", Path: "/worktrees/web/cf-login", Branch: "cf/login"},
		}}}}
	}
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{
		Name: "login", Members: []*v1.WorkspaceMemberSpec{{Repo: "web"}, {Repo: "api", BaseRef: "origin/dev"}}, Fetch: true,
	}))
	if err != nil {
		t.Fatal(err)
	}
	w := res.Msg.GetWorkspace()
	if w.GetId() != "w-1" || w.GetBranch() != "cf/login" || len(w.GetMembers()) != 2 || w.GetCreatedAt() == nil ||
		w.GetMembers()[1].GetWorktreePath() != "/worktrees/api/cf-login" {
		t.Fatalf("Create = %v", w)
	}
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{Name: "login", Members: []*v1.WorkspaceMemberSpec{{Repo: "x"}}})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Create duplicate: %v", err)
	}
	if _, err := c.AddRepo(ctx, connect.NewRequest(&v1.AddWorkspaceRepoRequest{Cwd: "/worktrees/web/cf-login/src", Repo: "lib"})); err != nil {
		t.Fatal(err)
	}
	mem, err := c.Members(ctx, connect.NewRequest(&v1.WorkspaceMembersRequest{Cwd: "/worktrees/web/cf-login"}))
	if err != nil {
		t.Fatal(err)
	}
	ms := mem.Msg.GetMembers()
	if mem.Msg.GetWorkspace().GetName() != "login" || len(ms) != 3 || ms[0].GetRepoName() != "web-ui" || !ms[0].GetCurrent() ||
		ms[0].GetMissing() || !ms[1].GetMissing() || ms[1].GetBranch() != "cf/login" {
		t.Fatalf("Members = %v", mem.Msg)
	}
	if _, err := c.Members(ctx, connect.NewRequest(&v1.WorkspaceMembersRequest{Cwd: "/elsewhere"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("Members outside: %v", err)
	}
	if _, err := c.Members(ctx, connect.NewRequest(&v1.WorkspaceMembersRequest{})); connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Errorf("Members without a ref: %v", err)
	}
	rr, err := c.RemoveRepo(ctx, connect.NewRequest(&v1.RemoveWorkspaceRepoRequest{Workspace: "login", Repo: "api", Force: true}))
	if err != nil || len(rr.Msg.GetWorkspace().GetMembers()) != 2 {
		t.Fatalf("RemoveRepo = %v, %v", rr, err)
	}
	if _, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveWorkspaceRequest{Workspace: "w-1", DeleteBranch: true})); err != nil {
		t.Fatal(err)
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListWorkspacesRequest{}))
	if err != nil || len(list.Msg.GetWorkspaces()) != 0 {
		t.Fatalf("List = %v, %v", list, err)
	}
	want := []string{"Create login web,api:origin/dev", "Create login x", "AddRepo /worktrees/web/cf-login/src lib",
		"Members /worktrees/web/cf-login", "Members /elsewhere", "Members ", "RemoveRepo login api force", "Remove w-1 delete-branch"}
	if got := fake.Calls(); len(got) != len(want) {
		t.Fatalf("calls = %q", got)
	} else {
		for i := range want {
			if got[i] != want[i] {
				t.Errorf("call %d = %q, want %q", i, got[i], want[i])
			}
		}
	}
}

func TestWorkspaceWatchSendsSnapshotThenEvents(t *testing.T) {
	fake, c := newWorkspaceServer(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{Name: "a", Members: []*v1.WorkspaceMemberSpec{{Repo: "r"}}})); err != nil {
		t.Fatal(err)
	}
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchWorkspacesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || len(stream.Msg().GetSnapshot().GetWorkspaces()) != 1 {
		t.Fatalf("first event = %v (%v)", stream.Msg(), stream.Err())
	}
	if _, err := fake.AddRepo(ctx, workspaceAddRepo("a", "s")); err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || len(stream.Msg().GetUpdated().GetMembers()) != 2 {
		t.Fatalf("second event = %v (%v)", stream.Msg(), stream.Err())
	}
	if _, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveWorkspaceRequest{Workspace: "a"})); err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || stream.Msg().GetRemovedId() != "w-1" {
		t.Fatalf("third event = %v (%v)", stream.Msg(), stream.Err())
	}
}

func workspaceAddRepo(ws, repoID string) workspace.AddRepoOptions {
	return workspace.AddRepoOptions{Ref: workspace.Ref{Workspace: ws}, Member: workspace.MemberSpec{Repo: repoID}}
}
