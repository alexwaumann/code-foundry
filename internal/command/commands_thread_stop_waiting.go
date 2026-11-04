package command

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.stop-waiting (docs/notes/wait-list-daemon.md): the waiting strip's Stop waiting.
// It removes the thread's wakes and stops its background shells. It asks first only when
// there are shells, naming them, since a shell is the one thing it ends. Child threads
// are not stopped, only no longer listened to, so the words never say they are.

// StopWaitingBackend is the slice of ThreadService thread.stop-waiting needs.
type StopWaitingBackend interface {
	StopWaiting(context.Context, *connect.Request[v1.StopThreadWaitingRequest]) (*connect.Response[v1.StopThreadWaitingResponse], error)
}

// stopWaitingConfirm asks about shells, naming them.
func stopWaitingConfirm(shells []*v1.BackgroundShell) string {
	names := make([]string, len(shells))
	for i, sh := range shells {
		names[i] = shellName(sh)
	}
	return "This stops " + plural(len(shells), "background shell") + ": " + strings.Join(names, ", ") + ". Its other wakes go too; child threads keep working."
}

// StopWaitingMessage says what a stop did and what still runs.
func StopWaitingMessage(res *v1.StopThreadWaitingResponse) string {
	var did []string
	if n := len(res.GetRemoved()); n > 0 {
		did = append(did, "removed "+plural(n, "wake"))
	}
	if n := len(res.GetStoppedShells()); n > 0 {
		did = append(did, "stopping "+plural(n, "background shell"))
	}
	msg := "thread " + threadLabel(res.GetThread()) + " had nothing to stop"
	if len(did) > 0 {
		msg = "thread " + threadLabel(res.GetThread()) + ": " + strings.Join(did, ", ")
	}
	if n := int(res.GetThread().GetBackgroundAgentsRunning()); n > 0 {
		msg += "; " + plural(n, "subagent") + " still running"
	}
	return msg
}

func threadStopWaitingCmd(b ThreadBackend, idArg ArgSpec) Command {
	shells := func(ctx context.Context, a Args) []*v1.BackgroundShell {
		res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id")}))
		if err != nil {
			return nil // Run reports it
		}
		return res.Msg.GetThread().GetBackgroundShells()
	}
	return Command{
		Name:  "thread.stop-waiting",
		Title: "Stop Waiting",
		Description: "Remove everything that would wake a thread and stop its background shells. Child threads keep working " +
			"and subagents run to their end.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg},
		When:         hasThread,
		Confirm:      "Stop this thread's background shells?",
		ConfirmLabel: "Stop waiting",
		ConfirmIf:    func(ctx context.Context, _ Context, a Args) bool { return len(shells(ctx, a)) > 0 },
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return stopWaitingConfirm(shells(ctx, a))
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: StopWaitingMessage(res.Msg), JSON: res.Msg}, nil
		},
	}
}
