package command

import (
	"context"
	"fmt"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// The ways out of a thread's setup (docs/notes/instant-threads-2-actions.md). The GUI
// offers them in the composer: Cancel while a setup runs; Try again and Edit after it
// failed or was cancelled, with thread.remove beside them. No chord and no palette
// entry: they fit one moment of one thread, and When cannot see its state.

// keptClause says which worktrees a cleanup left, "" when none.
func keptClause(kept []string) string {
	if len(kept) == 0 {
		return ""
	}
	return "; kept for the work in them: " + strings.Join(kept, ", ")
}

func threadSetupRetry(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:         "thread.setup.retry",
		Title:        "Try Setup Again",
		Description:  "Run a failed or cancelled setup again, in the background: from the step that failed, or from the start after a cancel.",
		Category:     "Thread",
		NoPalette:    true,
		NoKeybinding: true,
		Args:         []ArgSpec{positional(idArg)},
		When:         hasThread,
		PageDetail: func(context.Context, Context, Args) (string, error) {
			return "It runs the actions set to run when a thread's worktree is made.", nil
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.RetrySetup(ctx, connect.NewRequest(&v1.RetryThreadSetupRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			return Result{Message: "trying the setup of thread " + threadLabel(s) + " again; thread wait follows it", JSON: s}, nil
		},
	}
}

func threadSetupCancel(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:         "thread.setup.cancel",
		Page:         PageState,
		Title:        "Cancel Setup",
		Description:  "Stop a thread's running setup and remove what it made. Once Claude is starting it is too late: use thread.interrupt.",
		Category:     "Thread",
		NoPalette:    true,
		NoKeybinding: true,
		Args:         []ArgSpec{positional(idArg)},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.CancelSetup(ctx, connect.NewRequest(&v1.CancelThreadSetupRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			msg := "cancelled the setup of thread " + threadLabel(res.Msg.GetThread()) + keptClause(res.Msg.GetKeptWorktrees())
			return Result{Message: msg, JSON: res.Msg}, nil
		},
	}
}

func threadSetupDiscard(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:         "thread.setup.discard",
		Page:         PageState,
		Title:        "Discard Thread",
		Description:  "Forget a thread whose setup failed or was cancelled, and what it made, as if it had never been sent. Gives back its draft and messages.",
		Category:     "Thread",
		NoPalette:    true,
		NoKeybinding: true,
		Args:         []ArgSpec{positional(idArg)},
		When:         hasThread,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.DiscardSetup(ctx, connect.NewRequest(&v1.DiscardThreadSetupRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			msg := "discarded thread " + a.String("id")
			if n := len(res.Msg.GetQueued()); n > 0 {
				msg += fmt.Sprintf(", with %s behind its first", plural(n, "queued message"))
			}
			return Result{Message: msg + keptClause(res.Msg.GetKeptWorktrees()), JSON: res.Msg}, nil
		},
	}
}
