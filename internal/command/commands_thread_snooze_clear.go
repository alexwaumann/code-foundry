package command

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// thread.snooze.clear (docs/notes/clear-woken-thread.md): the woken row's and strip's
// Clear. A thread whose snooze ended needs attention "snooze ended" until the user sends,
// snoozes again or archives; this ends it without putting the thread away: it is idle at
// its prompt, as after a re-snooze's clear.

// SnoozeEndedReason is the status reason of a woken thread (the store's
// thread.ReasonSnoozeEnded), with THREAD_STATUS_NEEDS_ATTENTION.
const SnoozeEndedReason = "snooze ended"

// SnoozeClearBackend is the slice of ThreadService thread.snooze.clear needs.
type SnoozeClearBackend interface {
	ClearSnoozeEnded(context.Context, *connect.Request[v1.ClearSnoozeEndedRequest]) (*connect.Response[v1.ClearSnoozeEndedResponse], error)
}

// woken reports whether t's snooze ended and nothing has cleared it.
func woken(t *v1.Thread) bool {
	return t.GetStatus() == v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION && t.GetStatusReason() == SnoozeEndedReason
}

// activeWoken is thread.snooze.clear's When: in a window, only while the active thread
// is woken; from the CLI whenever a thread is named (Run says when it was not woken).
func activeWoken(b ThreadBackend) func(Context) bool {
	return func(c Context) bool {
		if !hasThread(c) {
			return false
		}
		if c.ActiveView == "" {
			return true
		}
		res, err := b.Get(context.Background(), connect.NewRequest(&v1.GetThreadRequest{Id: c.ActiveThreadID}))
		return err == nil && woken(res.Msg.GetThread())
	}
}

func threadSnoozeClear(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:    "thread.snooze.clear",
		Page:    PageState,
		NoIndex: true,
		Title:   "Clear Snooze Ended",
		Description: "Clear a woken thread's \"snooze ended\": it stays where it is, idle at its prompt. " +
			"A message, another snooze or archiving clear it too. (thread snooze --clear unsnoozes a thread still snoozed.)",
		Category:     "Thread",
		NoKeybinding: true,
		Args:         []ArgSpec{positional(idArg)},
		When:         activeWoken(b),
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			res, err := b.ClearSnoozeEnded(ctx, connect.NewRequest(&v1.ClearSnoozeEndedRequest{Id: a.String("id")}))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			if !res.Msg.GetCleared() {
				return Result{Message: "thread " + threadLabel(s) + " was not woken from a snooze; nothing to clear", JSON: res.Msg}, nil
			}
			return Result{Message: "cleared snooze ended on thread " + threadLabel(s), JSON: res.Msg}, nil
		},
	}
}
