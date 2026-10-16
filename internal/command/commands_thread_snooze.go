package command

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// sessionSnooze is session.snooze: snooze a thread until a time (Claude closed, its
// shells removed, unpinned and unarchived, listed apart until the daemon wakes it into
// needs-attention "snooze ended") or unsnooze it with clear. until is parsed here
// (parseSnoozeUntil, the daemon's local zone) and the API gets an absolute time; the
// GUI computes its presets itself. Snoozing asks for confirmation only while Claude is
// mid-turn or waiting on the user, or background agents or shells run, like
// session.archive; unsnoozing never asks. See
// docs/notes/snooze-threads-1-daemon.md.
func threadSnooze(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.snooze",
		Title: "Snooze or Unsnooze Thread",
		Description: "Snooze a thread until a time: Claude is closed, its terminals are removed and it is unpinned and " +
			"listed apart; when the time comes it returns needing attention (\"snooze ended\"). " +
			"until takes " + SnoozeUntilHelp + ". clear unsnoozes. " +
			"Pinning, archiving or sending a message unsnoozes a thread too.",
		Category: "Thread",
		Args: []ArgSpec{
			idArg,
			{Name: "until", Type: String, Description: "When the thread wakes: 1h, 90m, tomorrow, next-week, mon..sun, 2026-10-20, 2026-10-20 14:00 or RFC 3339"},
			{Name: "clear", Type: Bool, Description: "Unsnooze the thread instead"},
		},
		When:    hasThread,
		Confirm: "Snooze thread {id}? Claude is still working; snoozing ends the turn.",
		ConfirmIf: func(ctx context.Context, _ Context, a Args) bool {
			return snoozeConfirm(ctx, b, a) != ""
		},
		DynamicConfirm: func(ctx context.Context, _ Context, a Args) string {
			return snoozeConfirm(ctx, b, a)
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			now := time.Now()
			until, err := snoozeArgs(a, now)
			if err != nil {
				return Result{}, err
			}
			req := &v1.SnoozeThreadRequest{Id: a.String("id")}
			if !until.IsZero() {
				req.Until = timestamppb.New(until)
			}
			res, err := b.Snooze(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			if su := s.GetSnoozedUntil(); su != nil {
				return Result{Message: "snoozed thread " + threadLabel(s) + " until " + formatSnoozeTime(su.AsTime(), now, time.Local), JSON: s}, nil
			}
			return Result{Message: "unsnoozed thread " + threadLabel(s), JSON: s}, nil
		},
	}
}

// snoozeArgs is the snooze time session.snooze's args ask for: zero with clear, else
// until parsed for now in the local zone. Exactly one of them must be given.
func snoozeArgs(a Args, now time.Time) (time.Time, error) {
	unsnooze, hasUntil := a.Bool("clear"), a.Has("until")
	switch {
	case unsnooze && hasUntil:
		return time.Time{}, InvalidArg("until", "give until or clear, not both")
	case unsnooze:
		return time.Time{}, nil
	case !hasUntil:
		return time.Time{}, InvalidArg("until", "give until (%s) or clear", SnoozeUntilHelp)
	}
	t, err := parseSnoozeUntil(a.String("until"), now, time.Local)
	if err != nil {
		return time.Time{}, InvalidArg("until", "%v", err)
	}
	return t, nil
}

// snoozeConfirm is session.snooze's confirmation for this call, or "" when it needs
// none: unsnoozing, args Run will refuse anyway, an unknown thread (Run reports it), or
// snoozing a thread that is not mid-turn and runs no background work (archiveInterrupts).
func snoozeConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	if until, err := snoozeArgs(a, time.Now()); err != nil || until.IsZero() {
		return ""
	}
	res, err := b.Get(ctx, connect.NewRequest(&v1.GetThreadRequest{Id: a.String("id")}))
	if err != nil {
		return ""
	}
	s := res.Msg.GetThread()
	why, ends := archiveInterrupts(s)
	if why == "" {
		return ""
	}
	name := s.GetName()
	if name == "" {
		name = s.GetId()
	}
	return "Snooze thread " + name + "? " + why + "; snoozing " + ends + "."
}
