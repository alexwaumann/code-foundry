package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
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
	ctx := context.Background()
	res, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{Name: "shop", Members: []string{"web", "api"}}))
	if err != nil {
		t.Fatal(err)
	}
	w := res.Msg.GetWorkspace()
	if w.GetId() != "w-1" || len(w.GetMembers()) != 2 || w.GetMembers()[0] != "api" || w.GetDefaultPrimary() != "web" ||
		w.GetManagedDir() != "/workspaces/w-1" || w.GetCreatedAt() == nil {
		t.Fatalf("Create = %v", w)
	}
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{Name: "SHOP", Members: []string{"x"}})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("Create duplicate: %v", err)
	}
	if _, err := c.AddProject(ctx, connect.NewRequest(&v1.AddWorkspaceProjectRequest{Workspace: "shop", Project: "lib"})); err != nil {
		t.Fatal(err)
	}
	if _, err := c.AddProject(ctx, connect.NewRequest(&v1.AddWorkspaceProjectRequest{Workspace: "nope", Project: "lib"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("AddProject to a missing workspace: %v", err)
	}
	rr, err := c.RemoveProject(ctx, connect.NewRequest(&v1.RemoveWorkspaceProjectRequest{Workspace: "shop", Project: "web"}))
	if err != nil || len(rr.Msg.GetWorkspace().GetMembers()) != 2 || rr.Msg.GetWorkspace().GetDefaultPrimary() != "workspace" {
		t.Fatalf("RemoveProject = %v, %v", rr, err)
	}
	rn, err := c.Rename(ctx, connect.NewRequest(&v1.RenameWorkspaceRequest{Workspace: "w-1", Name: "store"}))
	if err != nil || rn.Msg.GetWorkspace().GetName() != "store" {
		t.Fatalf("Rename = %v, %v", rn, err)
	}
	sp, err := c.SetDefaultPrimary(ctx, connect.NewRequest(&v1.SetWorkspaceDefaultPrimaryRequest{Workspace: "store", DefaultPrimary: "api"}))
	if err != nil || sp.Msg.GetWorkspace().GetDefaultPrimary() != "api" {
		t.Fatalf("SetDefaultPrimary = %v, %v", sp, err)
	}
	if _, err := c.Remove(ctx, connect.NewRequest(&v1.RemoveWorkspaceRequest{Workspace: "w-1"})); err != nil {
		t.Fatal(err)
	}
	list, err := c.List(ctx, connect.NewRequest(&v1.ListWorkspacesRequest{}))
	if err != nil || len(list.Msg.GetWorkspaces()) != 0 {
		t.Fatalf("List = %v, %v", list, err)
	}
	want := []string{"Create shop", "Create SHOP", "AddProject shop lib", "AddProject nope lib", "RemoveProject shop web",
		"Rename w-1 store", "SetDefaultPrimary store api", "Remove w-1"}
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
	if _, err := c.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{Name: "a", Members: []string{"r"}})); err != nil {
		t.Fatal(err)
	}
	stream, err := c.Watch(ctx, connect.NewRequest(&v1.WatchWorkspacesRequest{}))
	if err != nil {
		t.Fatal(err)
	}
	if !stream.Receive() || len(stream.Msg().GetSnapshot().GetWorkspaces()) != 1 {
		t.Fatalf("first event = %v (%v)", stream.Msg(), stream.Err())
	}
	// Subscribing read every workspace's folder again first (hand edits show).
	if !slices.Contains(fake.Calls(), "EnsureDirs") {
		t.Errorf("calls %v: want EnsureDirs of every workspace on subscribe", fake.Calls())
	}
	if _, err := fake.AddProject(ctx, "a", "s"); err != nil {
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
