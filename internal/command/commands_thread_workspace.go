package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// WorkspaceRefBackend backs thread.workspace.
type WorkspaceRefBackend interface {
	SetWorkspace(context.Context, *connect.Request[v1.SetThreadWorkspaceRequest]) (*connect.Response[v1.SetThreadWorkspaceResponse], error)
}

// threadWorkspaceCmd is thread.workspace: set or clear a thread's workspace reference
// (Thread.workspace_id; the GUI's "Save as workspace" sets it after workspace.new). The
// project set stays; the workspace's instructions and skills reach the thread from its
// next start (docs/notes/workspaces-v2-3-composer.md).
func threadWorkspaceCmd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.workspace",
		Title: "Set Thread Workspace",
		Description: "Make a thread reference a workspace (its instructions and skills reach the thread), or no workspace. " +
			"Its projects do not change; it applies from the thread's next start.",
		Category: "Thread",
		Args: []ArgSpec{
			positional(idArg),
			{Name: "workspace", Type: String, Description: "Workspace id or name; empty clears the reference"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.SetWorkspace(ctx, connect.NewRequest(&v1.SetThreadWorkspaceRequest{Id: a.String("id"), Workspace: a.String("workspace")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := "thread " + threadLabel(s) + " references no workspace"
			if s.GetWorkspaceId() != "" {
				msg = "thread " + threadLabel(s) + " now references workspace " + s.GetWorkspaceId()
			}
			return Result{Message: msg + "; it applies from the thread's next start", JSON: s}, nil
		},
	}
}
