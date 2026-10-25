package api

import (
	"context"
	"slices"
	"testing"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

func TestThreadSetWorkspace(t *testing.T) {
	fake, c := newThreadServer(t)
	ctx := context.Background()
	fake.Put(thread.Thread{ID: "s-1", ProjectID: "r1", ProjectIDs: []string{"r1", "r2"}, State: thread.StateConnected, CreatedAt: time.Unix(1, 0)})
	// Runs in its workspace's folder: no project of its own as the primary.
	fake.Put(thread.Thread{ID: "s-2", WorkspaceID: "w-a", ProjectIDs: []string{"r1"}, State: thread.StateConnected, CreatedAt: time.Unix(2, 0)})

	res, err := c.SetWorkspace(ctx, connect.NewRequest(&v1.SetThreadWorkspaceRequest{Id: "s-1", Workspace: "w-a"}))
	if err != nil || res.Msg.GetThread().GetWorkspaceId() != "w-a" || len(res.Msg.GetThread().GetProjectIds()) != 2 {
		t.Fatalf("SetWorkspace = %v, %v", res, err)
	}
	res, err = c.SetWorkspace(ctx, connect.NewRequest(&v1.SetThreadWorkspaceRequest{Id: "s-1"}))
	if err != nil || res.Msg.GetThread().GetWorkspaceId() != "" {
		t.Fatalf("SetWorkspace(clear) = %v, %v", res, err)
	}
	if _, err := c.SetWorkspace(ctx, connect.NewRequest(&v1.SetThreadWorkspaceRequest{Id: "s-2"})); connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Errorf("clearing a thread in its workspace's folder: %v, want failed precondition", err)
	}
	if _, err := c.SetWorkspace(ctx, connect.NewRequest(&v1.SetThreadWorkspaceRequest{Id: "nope", Workspace: "w-a"})); connect.CodeOf(err) != connect.CodeNotFound {
		t.Errorf("SetWorkspace on an unknown thread: %v, want not found", err)
	}
	want := []string{"SetWorkspace s-1 w-a", "SetWorkspace s-1 ", "SetWorkspace s-2 ", "SetWorkspace nope w-a"}
	if calls := fake.Calls(); !slices.Equal(calls, want) {
		t.Errorf("calls = %q, want %q", calls, want)
	}
}
