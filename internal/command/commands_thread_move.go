package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadMove is thread.move: take a thread without a project into a project or a
// workspace (docs/notes/move-no-project-1-daemon.md). The placement flags are
// thread.new's: new-worktree (a new branch, or branch for an existing one, from base),
// new-worktree=false (the project's folder), worktree (an existing checkout); none of
// them leaves it to threads.default_worktree. NoPalette: it needs a place; the GUI
// opens a picker.
func threadMove(r *Registry, b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:      "thread.move",
		NoPalette: true,
		Title:     "Move Thread to Project…",
		Description: "Move a thread without a project into a project or workspace, placed as thread new would place it; " +
			"it is renamed from its conversation and keeps it (mid-turn: once the turn ends).",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "to", Type: String, Positional: true, Description: "Project (id, name or path) or workspace (id or name)"},
			{Name: "project", Type: String, Description: "With workspace: the project it runs in, or workspace for its folder"},
			{Name: "workspace", Type: String, Description: "Workspace id or name"},
			{Name: "worktree", Type: Path, Description: "An existing checkout of the project to run in"},
			{Name: "new-worktree", Type: Bool, Description: "A new worktree (branch named from the conversation); =false: the project's folder (default: settings threads.default_worktree)"},
			{Name: "base", Type: String, Description: "Ref the new branch starts from; needs new-worktree"},
			baseFromOriginArg,
			{Name: "branch", Type: String, Description: "The new worktree's branch, as thread new's; an existing one is checked out; needs new-worktree"},
		},
		When: hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			req, err := r.moveRequest(ctx, a)
			if err != nil {
				return Result{}, err
			}
			res, err := b.Move(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: movedMessage(res.Msg, r.projectNamer(ctx)), JSON: res.Msg.GetThread(), Warnings: res.Msg.GetHints()}, nil
		},
	}
}

// moveRequest is thread.move's request: to is a project unless no project answers to
// it (then a workspace), or with workspace the primary.
func (r *Registry) moveRequest(ctx context.Context, a Args) (*v1.MoveThreadRequest, error) {
	req := &v1.MoveThreadRequest{Id: a.String("id"), ProjectId: a.String("project"), WorkspaceId: a.String("workspace"), WorktreePath: a.Path("worktree")}
	if to := strings.TrimSpace(a.String("to")); to != "" {
		switch {
		case req.ProjectId != "":
			return nil, InvalidArg("project", "give the project once: as the positional place or as project")
		case req.WorkspaceId != "":
			req.ProjectId = to // the workspace's primary
		default:
			req.ProjectId = to
			if res := r.refResolver(ProjectID); res != nil {
				if id, err := res(ctx, "to", to); err == nil {
					req.ProjectId = id
				} else if connect.CodeOf(err) == connect.CodeNotFound {
					req.ProjectId, req.WorkspaceId = "", to // not a project: a workspace (the daemon says when it is neither)
				} else {
					return nil, err
				}
			}
		}
	}
	if req.ProjectId == "" && req.WorkspaceId == "" && req.WorktreePath == "" {
		return nil, InvalidArg("to", "name the project or workspace to move the thread to")
	}
	fromOrigin, err := baseFromOrigin(a)
	if err != nil {
		return nil, err
	}
	switch {
	case a.Bool("new-worktree"):
		req.NewWorktree = &v1.NewWorktree{BaseRef: a.String("base"), Branch: a.String("branch"), BaseFromOrigin: fromOrigin}
	case a.String("base") != "":
		return nil, InvalidArg("base", "only applies with new-worktree")
	case fromOrigin != nil:
		return nil, InvalidArg("base-from-origin", "only applies with new-worktree")
	case a.String("branch") != "":
		return nil, InvalidArg("branch", "only applies with new-worktree")
	case a.Given("new-worktree"):
		req.CheckoutMode = true // =false: the project's folder
	}
	return req, nil
}

// movedMessage is what thread.move says: where the thread runs now and in what
// checkout, or where it goes once its turn ends.
func movedMessage(res *v1.MoveThreadResponse, name func(string) string) string {
	s := res.GetThread()
	if mv := s.GetPendingMove(); mv != nil {
		return "thread " + threadLabel(s) + " moves to " + mv.GetWorktreePath() + " once its turn ends"
	}
	msg := "moved thread " + threadLabel(s) + " to "
	if s.GetWorkspaceId() != "" {
		msg += "workspace " + s.GetWorkspaceId() + ", "
	} else if s.GetProjectId() != "" {
		msg += name(s.GetProjectId()) + ", "
	}
	msg += "in " + s.GetWorktreePath()
	switch {
	case res.GetMadeWorktree() && res.GetMadeBranch() && s.GetBaseRef() != "":
		msg += " (new worktree on " + s.GetBranch() + " from " + s.GetBaseRef() + ")"
	case res.GetMadeWorktree():
		msg += " (new worktree on existing branch " + s.GetBranch() + ")"
	case res.GetExistingWorktree() && res.GetSharedWith() != "":
		msg += " (worktree on " + s.GetBranch() + ", shared with " + res.GetSharedWith() + ")"
	case res.GetExistingWorktree():
		msg += " (existing worktree on " + s.GetBranch() + ")"
	}
	return msg
}
