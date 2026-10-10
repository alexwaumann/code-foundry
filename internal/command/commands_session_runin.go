package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// hasWorkspaceThread is session.run-in's availability: a thread is active and, in the
// GUI, it belongs to a workspace (the GUI passes the thread's workspace as
// ActiveWorkspaceID). A CLI caller (no active view) names the thread with --id, which
// When cannot look up, so the daemon refuses a project thread instead.
func hasWorkspaceThread(c Context) bool {
	return hasSession(c) && (c.ActiveWorkspaceID != "" || c.ActiveView == "")
}

// sessionRunIn is session.run-in: move a workspace thread to another member worktree
// ("Run in…"). The daemon types `/cd <path>` once the thread is idle at its prompt.
func sessionRunIn(b SessionBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "session.run-in",
		Title: "Run Thread In…",
		Description: "Move a workspace thread to another member worktree of its workspace. " +
			"A running thread gets /cd typed once it is idle at its prompt; a disconnected one moves at once.",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "repo", Type: String, Positional: true, Description: "Member repository (id or name)"},
			{Name: "worktree", Type: Path, Description: "Member worktree path"},
		},
		When: hasWorkspaceThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.String("repo") == "" && a.Path("worktree") == "" {
				return Result{}, InvalidArg("repo", "name the member: a repository or a worktree path")
			}
			res, err := b.RunIn(ctx, connect.NewRequest(&v1.RunInSessionRequest{
				Id: a.String("id"), RepoId: a.String("repo"), WorktreePath: a.Path("worktree"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetSession()
			msg := "thread " + sessionLabel(s) + " runs in " + s.GetWorktreePath()
			if p := s.GetPendingWorktreePath(); p != "" {
				msg = "thread " + sessionLabel(s) + " moves to " + p + " once it is idle (/cd)"
			}
			return Result{Message: msg, JSON: s}, nil
		},
	}
}
