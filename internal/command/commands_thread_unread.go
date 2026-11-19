package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.unread (docs/notes/thread-mark-unread.md): "Mark as Unread". An idle thread
// goes back to the Done a turn that ended unseen leaves (needs attention "finished"),
// so the user comes back to it.
//
// Available wherever a thread is, like thread.pin and thread.interrupt: the window's
// command list is fetched when the context changes, not when the thread's status does,
// so a status rule here would leave the chord bound or unbound by a stale reading. The
// daemon refuses anything but an idle thread at its prompt (FAILED_PRECONDITION, saying
// why), and the GUI's menus and palette offer it by their own fresh copy of the rule
// (gui/frontend/src/lib/markUnread.ts).
//
// With ids it marks several (commands_thread_bulk.go), past one the daemon refuses: the
// sidebar's bulk menu, which offers it only when every selected thread can be marked
// (docs/notes/put-away-chords.md).

// UnreadBackend is the slice of ThreadService thread.unread needs.
type UnreadBackend interface {
	MarkUnread(context.Context, *connect.Request[v1.MarkUnreadRequest]) (*connect.Response[v1.MarkUnreadResponse], error)
}

func threadUnread(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name: "thread.unread",
		Page: PageState,
		// The user's own attention, like thread.snooze.clear: no agent needs it.
		NoIndex: true,
		Title:   "Mark as Unread",
		Description: "Mark an idle thread unread: it shows Done again, as after a turn you have not seen, until you open or focus it, " +
			"or a message or a new turn clears it. Only for a thread idle at its prompt (not working, asking, in error, archived, snoozed or saved).",
		Category:    "Thread",
		Keybindings: []string{"cmd+shift+u"},
		Args:        []ArgSpec{positional(optionalID(idArg)), threadIDsArg},
		When:        hasThreadOrCLI,
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			ids, err := targetThreads(a)
			if err != nil {
				return Result{}, err
			}
			if a.Has("ids") {
				return unreadThreads(ctx, b, ids), nil
			}
			res, err := b.MarkUnread(ctx, connect.NewRequest(&v1.MarkUnreadRequest{Id: ids[0]}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			return Result{Message: "marked thread " + threadLabel(s) + " unread", JSON: s}, nil
		},
	}
}

// unreadThreads is thread.unread given ids: "marked 2 threads unread: a, b", and the ones the
// daemon refused with why (eachThread).
func unreadThreads(ctx context.Context, b ThreadBackend, ids []string) Result {
	res := eachThread(ctx, ids, "marked", func(ctx context.Context, id string) error {
		_, err := b.MarkUnread(ctx, connect.NewRequest(&v1.MarkUnreadRequest{Id: id}))
		return err
	})
	return afterCount(res, "marked", " unread")
}
