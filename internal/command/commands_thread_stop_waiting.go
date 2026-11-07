package command

import (
	"context"
	"errors"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.stop-waiting (docs/notes/wait-list-daemon.md): the waiting strip's Stop waiting.
// It removes the thread's wakes and stops its background shells. It asks first only when
// there are shells, naming them, since a shell is the one thing it ends. Child threads
// are not stopped, only no longer listened to, so the words never say they are. Ember's
// thread refuses it (the store): its wakes run its board.

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

// shownArg binds the yes to the shells the question named (Command.BindConfirm). The
// CLI's --yes leaves it empty: it asked for no list.
var shownArg = ArgSpec{Name: "shown-digest", Type: String, Description: "Set by the confirmation: the digest of the shells you were shown; " +
	"it refuses if another one runs by then (--yes alone stops what runs)"}

// errShellsChanged refuses a yes given to another list of shells. Nothing was stopped.
var errShellsChanged = errors.New("the thread's background shells changed since you were asked; nothing was stopped, so ask again")

func threadStopWaitingCmd(b ThreadBackend, idArg ArgSpec) Command {
	// A resident thread refuses in Run (the store's rule), so it is not asked first.
	shells := func(ctx context.Context, a Args) []*v1.BackgroundShell {
		res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id")}))
		if err != nil || res.Msg.GetThread().GetKind() == v1.ThreadKind_THREAD_KIND_RESIDENT {
			return nil // Run reports it
		}
		return res.Msg.GetThread().GetBackgroundShells()
	}
	return Command{
		Name:    "thread.stop-waiting",
		Page:    PageDrives,
		NoIndex: true,
		Title:   "Stop Waiting",
		Description: "Remove everything that would wake a thread and stop its background shells. Child threads keep working " +
			"and subagents run to their end.",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{idArg, shownArg},
		When:         hasThread,
		Confirm:      "Stop this thread's background shells?",
		ConfirmLabel: "Stop waiting",
		BindConfirm:  shownArg.Name,
		ConfirmIf:    func(ctx context.Context, _ Context, a Args) bool { return len(shells(ctx, a)) > 0 },
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return stopWaitingConfirm(shells(ctx, a))
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			// A yes covers the shells it named. One that ended is fine; none is killed unnamed.
			if d := a.String(shownArg.Name); d != "" {
				if now := shells(ctx, a); len(now) > 0 && ConfirmDigest(stopWaitingConfirm(now)) != d {
					return Result{}, connect.NewError(connect.CodeFailedPrecondition, errShellsChanged)
				}
			}
			res, err := b.StopWaiting(ctx, connect.NewRequest(&v1.StopThreadWaitingRequest{ThreadId: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			return Result{Message: StopWaitingMessage(res.Msg), JSON: res.Msg}, nil
		},
	}
}
