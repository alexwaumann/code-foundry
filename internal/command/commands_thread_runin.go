package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// hasWorkspaceThread is thread.run-in's availability: a thread is active and, in the
// GUI, it belongs to a workspace (the GUI passes the thread's workspace as
// ActiveWorkspaceID). A CLI caller (no active view) names the thread with --id, which
// When cannot look up, so the daemon refuses a project thread instead.
func hasWorkspaceThread(c Context) bool {
	return hasThread(c) && (c.ActiveWorkspaceID != "" || c.ActiveView == "")
}

// threadRunIn is thread.run-in: move a workspace thread to another member worktree
// ("Run in…"). The daemon moves a live thread (set_cwd) once it is idle at its prompt.
func threadRunIn(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.run-in",
		Title: "Run Thread In…",
		Description: "Move a workspace thread to another member worktree of its workspace. " +
			"A thread moves once it is idle at its prompt (at once when Claude is not running for it).",
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
			res, err := b.RunIn(ctx, connect.NewRequest(&v1.RunInThreadRequest{
				Id: a.String("id"), RepoId: a.String("repo"), WorktreePath: a.Path("worktree"),
			}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			msg := "thread " + threadLabel(s) + " runs in " + s.GetWorktreePath()
			if p := s.GetPendingWorktreePath(); p != "" {
				msg = "thread " + threadLabel(s) + " moves to " + p + " once it is idle"
			}
			return Result{Message: msg, JSON: s}, nil
		},
	}
}
