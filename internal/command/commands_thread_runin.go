package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadRunIn is thread.run-in: move a thread to another of its checkouts ("Run in…").
// In the GUI it is offered only for a thread with somewhere else to run (runElsewhere);
// from the CLI for any thread (the daemon refuses one with no other). The daemon moves a
// live thread (set_cwd) once it is idle at its prompt.
func threadRunIn(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.run-in",
		Title: "Run Thread In…",
		Description: "Move a thread to another of its checkouts (thread checkouts). " +
			"A thread moves once it is idle at its prompt (at once when Claude is not running for it).",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "project", Type: String, Positional: true, Description: "One of the thread's projects (id or name)"},
			{Name: "worktree", Type: Path, Description: "One of the thread's checkout paths"},
		},
		When: runElsewhere(b),
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			if a.String("project") == "" && a.Path("worktree") == "" {
				return Result{}, InvalidArg("project", "name the checkout: a project or a checkout path")
			}
			res, err := b.RunIn(ctx, connect.NewRequest(&v1.RunInThreadRequest{
				Id: a.String("id"), ProjectId: a.String("project"), WorktreePath: a.Path("worktree"),
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

// runElsewhere is thread.run-in's availability: a thread, and in the GUI (an active
// view) one with two or more places to run among its projects and its workspace's
// folder, the rule the GUI's menus apply too (gui/frontend/src/lib/threadRow.ts
// canRunElsewhere). A thread the backend does not know is not offered.
func runElsewhere(b ThreadBackend) func(Context) bool {
	return func(c Context) bool {
		if !hasThread(c) {
			return false
		}
		if c.ActiveView == "" {
			return true
		}
		res, err := b.Get(context.Background(), connect.NewRequest(&v1.GetThreadRequest{Id: c.ActiveThreadID}))
		if err != nil {
			return false
		}
		t := res.Msg.GetThread()
		places := len(t.GetProjectIds())
		if t.GetWorkspaceId() != "" {
			places++
		}
		return places > 1
	}
}
