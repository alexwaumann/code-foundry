package command

import (
	"context"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// createdFocusArg is the focus of a verb that starts a thread (thread.new, thread.fork,
// the pr.* threads, theme.ask): every window moves to the new thread, as it always has.
// A page's bridge sends focus=false unless the page passes it, so a page that starts a
// thread keeps the user's view and its own handler runs (docs/notes/bridge-fix-c-gui.md).
var createdFocusArg = ArgSpec{Name: "focus", Type: Bool, Default: "true",
	Description: "Select the new thread in every window (--focus=false: no window moves)"}

// focusCreated emits the FocusThread a thread-starting verb sends for its new thread,
// unless focus is false.
func focusCreated(e Emitter, a Args, id string) {
	if !a.Bool("focus") {
		return
	}
	e.Emit(&v1.UiIntent{Intent: &v1.UiIntent_FocusThread_{FocusThread: &v1.UiIntent_FocusThread{ThreadId: id}}})
}

// callerPlacement places a thread.new that names no project, worktree, workspace or
// no-project and runs in a thread (its CLI, or a page that thread shows): where that
// thread runs. Its worktree and project, its workspace too for a workspace thread, and
// no-project for a thread without a project. False when the call runs in no thread (the
// CLI outside one; the app always names a placement).
func callerPlacement(ctx context.Context, b ThreadBackend, c Context, req *v1.CreateThreadRequest) (bool, error) {
	if c.ActiveView != "" || c.CallerThreadID == "" {
		return false, nil
	}
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: c.CallerThreadID}))
	if err != nil {
		return false, fmt.Errorf("the thread this runs in (%s): %w", c.CallerThreadID, err)
	}
	t := res.Msg.GetThread()
	if t.GetProjectId() == "" && t.GetWorkspaceId() == "" {
		req.NoProject = true
		return true, nil
	}
	req.ProjectId, req.WorktreePath, req.WorkspaceId = t.GetProjectId(), t.GetWorktreePath(), t.GetWorkspaceId()
	return true, nil
}
