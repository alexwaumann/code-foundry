package command

import (
	"context"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// threadSnooze is thread.snooze: snooze a thread until a time (unarchived and listed apart
// until the daemon wakes it into needs-attention "snooze ended"; nothing else changes: its
// process, its turn, its terminals and its pin stay as they are), save it for later with
// save (the same with no wake time, docs/notes/save-for-later-1-daemon.md) or unsnooze it
// with clear. until is parsed here (parseSnoozeUntil, the daemon's local zone) and the API
// gets an absolute time; the GUI computes its presets itself. It never asks for
// confirmation: nothing is cut off (docs/notes/snooze-without-teardown.md). See
// docs/notes/snooze-threads-1-daemon.md.
// With ids it acts on several threads (commands_thread_bulk.go): the sidebar's bulk
// menu and its Snoozed header as a drop target (docs/notes/sidebar-bulk-select.md).
func threadSnooze(b ThreadBackend, idArg ArgSpec) Command {
	return Command{
		Name:  "thread.snooze",
		Page:  PageState,
		Title: "Snooze or Unsnooze Thread",
		Description: "Snooze a thread until a time: it is listed apart and its tabs close, while Claude, its terminals and its pin " +
			"are left as they are; then it returns needing attention (\"snooze ended\"). " +
			"clear unsnoozes, as do pinning, archiving and the user's message; another thread's message is delivered and leaves it snoozed. " +
			"From a thread, clear and pin work only on a thread it created.",
		Category: "Thread",
		Args: []ArgSpec{
			positional(optionalID(idArg)),
			threadIDsArg,
			// The forms only here: the guide has no room for them twice.
			{Name: "until", Type: String, Description: "When the thread wakes: " + SnoozeUntilHelp},
			{Name: "save", Type: Bool, Description: "Save it for later: it never wakes"},
			{Name: "clear", Type: Bool, Description: "Unsnooze instead"},
		},
		When: hasThreadOrCLI,
		Run: func(ctx context.Context, c Context, a Args) (Result, error) {
			now := time.Now()
			ids, err := targetThreads(a)
			if err != nil {
				return Result{}, err
			}
			req, err := snoozeRequest(a, now)
			if err != nil {
				return Result{}, err
			}
			if a.Has("ids") {
				return snoozeThreads(ctx, b, c, ids, req), nil
			}
			req.Id = ids[0]
			req.ByThreadId = askingThread(c)
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

// snoozeThreads is thread.snooze given ids: each is snoozed until the same time, saved
// for later, or unsnoozed, as req says, past one that fails (eachThread).
func snoozeThreads(ctx context.Context, b ThreadBackend, c Context, ids []string, req *v1.SnoozeThreadRequest) Result {
	verb, tail := "unsnoozed", ""
	switch {
	case req.GetSave():
		verb, tail = "saved", " for later"
	case req.GetUntil() != nil:
		verb, tail = "snoozed", " until "+formatSnoozeTime(req.GetUntil().AsTime(), time.Now(), time.Local)
	}
	res := eachThread(ctx, ids, verb, func(ctx context.Context, id string) error {
		one := &v1.SnoozeThreadRequest{Id: id, Until: req.GetUntil(), Save: req.GetSave(), ByThreadId: askingThread(c)}
		_, err := b.Snooze(ctx, connect.NewRequest(one))
		return err
	})
	return afterCount(res, verb, tail)
}
