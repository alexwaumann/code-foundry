package command

import (
	"cmp"
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ProjectSetBackend backs thread.project.add and thread.project.remove.
type ProjectSetBackend interface {
	AddProject(context.Context, *connect.Request[v1.AddThreadProjectRequest]) (*connect.Response[v1.AddThreadProjectResponse], error)
	RemoveProject(context.Context, *connect.Request[v1.RemoveThreadProjectRequest]) (*connect.Response[v1.RemoveThreadProjectResponse], error)
}

// setChangeNote is how both commands end: what a live Claude does, and the workspace a
// thread left (docs/notes/thread-project-set.md).
func setChangeNote(before string, s *v1.Thread) string {
	msg := ""
	if before != "" && s.GetWorkspaceId() == "" {
		msg = "; it no longer follows workspace " + before + " (thread workspace saves the set as one)"
	}
	if s.GetState() == v1.ThreadState_THREAD_STATE_CONNECTED {
		msg += "; Claude restarts for it once idle, resuming the conversation"
	}
	return msg
}

// threadWorkspaceOf is thread id's workspace reference before a change, "" when it has
// none or cannot be read (the message then leaves the workspace out).
func threadWorkspaceOf(ctx context.Context, b ThreadBackend, id string) string {
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: id}))
	if err != nil {
		return ""
	}
	return res.Msg.GetThread().GetWorkspaceId()
}

// threadProjectAdd is thread.project.add: a project joins a thread's set, with a
// checkout placed as thread new places one.
func threadProjectAdd(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:        "thread.project.add",
		NoPalette:   true,
		Title:       "Add Project to Thread",
		Description: "Add a project to a thread (in worktree mode a worktree on its branch). It leaves its workspace; Claude restarts when idle.",
		Category:    "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "project", Type: String, Required: true, Positional: true, Description: "Project id or name"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			before := threadWorkspaceOf(ctx, b, a.String("id"))
			res, err := b.AddProject(ctx, connect.NewRequest(&v1.AddThreadProjectRequest{Id: a.String("id"), Project: a.String("project")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := fmt.Sprintf("added %s to thread %s (%d projects)", a.String("project"), threadLabel(s), len(s.GetProjectIds()))
			return Result{Message: msg + setChangeNote(before, s), JSON: s}, nil
		},
	}
}

// threadProjectRemove is thread.project.remove: a member that is not the cwd's leaves
// the set; its checkout stays on disk. A checkout with uncommitted changes asks first:
// the thread no longer sees that work.
func threadProjectRemove(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:        "thread.project.remove",
		NoPalette:   true,
		Title:       "Remove Project from Thread",
		Description: "Remove a project (not the cwd's) from a thread; its checkout stays. As add, it leaves its workspace.",
		Category:    "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "project", Type: String, Required: true, Positional: true, Description: "Project id or name"},
		},
		When:    hasThread,
		Confirm: "Remove {project} from the thread?",
		ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
			return dirtyMember(ctx, b, a.String("id"), a.String("project")) != nil
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			c := dirtyMember(ctx, b, a.String("id"), a.String("project"))
			if c == nil {
				return ""
			}
			name := cmp.Or(c.GetProjectName(), c.GetProjectId())
			return fmt.Sprintf("%s's checkout at %s has uncommitted work: %s.\n\nIt stays on disk with the work, but this thread no longer sees it. Remove %s from the thread?",
				name, c.GetPath(), changeCounts(c.GetStatus()), name)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			before := threadWorkspaceOf(ctx, b, a.String("id"))
			res, err := b.RemoveProject(ctx, connect.NewRequest(&v1.RemoveThreadProjectRequest{Id: a.String("id"), Project: a.String("project")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := fmt.Sprintf("removed %s from thread %s (%d projects); its checkout stays on disk", a.String("project"), threadLabel(s), len(s.GetProjectIds()))
			return Result{Message: msg + setChangeNote(before, s), JSON: s}, nil
		},
	}
}

// dirtyMember is thread id's checkout of member ref (an id or a name) when it has
// uncommitted changes; nil otherwise, and when the checkouts cannot be read (the daemon
// then answers the removal itself).
func dirtyMember(ctx context.Context, b CheckoutsBackend, id, ref string) *v1.ThreadCheckout {
	ref = strings.TrimSpace(ref)
	if id == "" || ref == "" {
		return nil
	}
	res, err := b.Checkouts(ctx, connect.NewRequest(&v1.ThreadCheckoutsRequest{Id: id}))
	if err != nil {
		return nil
	}
	for _, c := range res.Msg.GetCheckouts() {
		if (c.GetProjectId() == ref || c.GetProjectName() == ref) && !c.GetPrimary() && c.GetStatus().GetDirty() {
			return c
		}
	}
	return nil
}
