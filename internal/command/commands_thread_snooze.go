package command

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadSnooze is thread.snooze: snooze a thread until a time (Claude closed, its
// shells removed, unpinned and unarchived, listed apart until the daemon wakes it into
// needs-attention "snooze ended"), save it for later with save (the same with no wake
// time, docs/notes/save-for-later-1-daemon.md) or unsnooze it with clear. until is parsed here
// (parseSnoozeUntil, the daemon's local zone) and the API gets an absolute time; the
// GUI computes its presets itself. Snoozing asks for confirmation only while Claude is
// mid-turn or waiting on the user, or background agents or shells run, like
// thread.archive; unsnoozing never asks. See
// docs/notes/snooze-threads-1-daemon.md.
func threadSnooze(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.snooze",
		Title: "Snooze or Unsnooze Thread",
		Description: "Snooze a thread until a time: Claude is closed, its terminals removed, it is unpinned and " +
			"listed apart; then it returns needing attention (\"snooze ended\"). " +
			"clear unsnoozes, as do pinning, archiving and a message.",
		Category: "Thread",
		Args: []ArgSpec{
			positional(idArg),
			// The forms only here: the guide has no room for them twice.
			{Name: "until", Type: String, Description: "When the thread wakes: " + SnoozeUntilHelp},
			{Name: "save", Type: Bool, Description: "Save it for later: it never wakes"},
			{Name: "clear", Type: Bool, Description: "Unsnooze instead"},
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
			req, err := snoozeRequest(a, now)
			if err != nil {
				return Result{}, err
			}
			res, err := b.Snooze(ctx, connect.NewRequest(req))
			if err != nil {
				return Result{}, err
			}
			s := res.Msg.GetThread()
			if s.GetSavedAt() != nil {
				return Result{Message: "saved thread " + threadLabel(s) + " for later", JSON: s}, nil
			}
			if su := s.GetSnoozedUntil(); su != nil {
				return Result{Message: "snoozed thread " + threadLabel(s) + " until " + formatSnoozeTime(su.AsTime(), now, time.Local), JSON: s}, nil
			}
			return Result{Message: "unsnoozed thread " + threadLabel(s), JSON: s}, nil
		},
	}
}

// snoozeRequest is the request thread.snooze's args ask for: until parsed for now in the
// local zone, or save, or neither with clear. Exactly one of the three must be given.
func snoozeRequest(a Args, now time.Time) (*v1.SnoozeThreadRequest, error) {
	req := &v1.SnoozeThreadRequest{Id: a.String("id")}
	unsnooze, save, hasUntil := a.Bool("clear"), a.Bool("save"), a.Has("until")
	switch {
	case unsnooze && save:
		return nil, InvalidArg("save", "give save or clear, not both")
	case unsnooze && hasUntil:
		return nil, InvalidArg("until", "give until or clear, not both")
	case save && hasUntil:
		return nil, InvalidArg("until", "give until or save, not both")
	case unsnooze:
		return req, nil
	case save:
		req.Save = true
		return req, nil
	case !hasUntil:
		return nil, InvalidArg("until", "give until (%s), save or clear", SnoozeUntilHelp)
	}
	t, err := parseSnoozeUntil(a.String("until"), now, time.Local)
	if err != nil {
		return nil, InvalidArg("until", "%v", err)
	}
	req.Until = timestamppb.New(t)
	return req, nil
}

// snoozeConfirm is thread.snooze's confirmation for this call, or "" when it needs
// none: unsnoozing, args Run will refuse anyway, an unknown thread (Run reports it), or
// snoozing a thread that is not mid-turn and runs no background work (archiveInterrupts).
func snoozeConfirm(ctx context.Context, b ThreadBackend, a Args) string {
	req, err := snoozeRequest(a, time.Now())
	if err != nil || (req.GetUntil() == nil && !req.GetSave()) {
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
	if req.GetSave() {
		return "Save thread " + name + " for later? " + why + "; saving " + ends + "."
	}
	return "Snooze thread " + name + "? " + why + "; snoozing " + ends + "."
}
