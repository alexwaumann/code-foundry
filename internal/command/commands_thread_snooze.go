package command

import (
	"context"
	"strings"
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
			"Or until an event: until-pr with on (checks_done when left out) ends it when the pull request's checks finish, it is reviewed, merged, …; " +
			"until-plugin with arg ends it when a plugin's wake source fires (thread snooze events lists both for a thread). " +
			"An event that already happened is refused; one that can no longer happen (the pull request closed, the plugin removed) ends the snooze too. " +
			"A thread may snooze itself: thread snooze --until-pr '#812' --on checks_passed. " +
			"clear unsnoozes, as do pinning, archiving and the user's message; another thread's message is delivered and leaves it snoozed. " +
			"From a thread, clear and pin work only on a thread it created.",
		Category: "Thread",
		Args: []ArgSpec{
			positional(optionalID(idArg)),
			threadIDsArg,
			// The forms only here: the guide has no room for them twice.
			{Name: "until", Type: String, Description: "When the thread wakes: " + SnoozeUntilHelp},
			{Name: "save", Type: Bool, Description: "Save it for later: it never wakes"},
			{Name: "until-pr", Type: String, Description: "Snooze until an event on this pull request: owner/name#123, its URL, or #123 (one of the thread's)"},
			{Name: "on", Type: Enum, Enum: snoozeConditions, Description: "With until-pr, the event: checks_done (default; whatever the result), " +
				"checks_passed, checks_failed, review, comment, review_requested, head_pushed, merged or closed"},
			{Name: "until-plugin", Type: String, Description: "Snooze until a plugin's wake source fires: <plugin>/<source>"},
			{Name: "arg", Type: String, Repeatable: true, Description: "With until-plugin, a source arg as name=value; " +
				"the rest default from the source and this thread (its id, pull request, project)"},
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
			if ev := s.GetSnoozeEvent(); ev != nil {
				return Result{Message: "snoozed thread " + threadLabel(s) + " until " + ev.GetWaitingFor(), JSON: s}, nil
			}
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

// snoozeConditions are thread.snooze's on values (thread.SnoozeConditions).
var snoozeConditions = []string{"checks_done", "checks_passed", "checks_failed", "review", "comment", "review_requested", "head_pushed", "merged", "closed"}

// snoozeRequest is the request thread.snooze's args ask for: until parsed for now in the
// local zone, or save, or an event (until-pr or until-plugin), or neither with clear.
// Exactly one must be given.
func snoozeRequest(a Args, now time.Time) (*v1.SnoozeThreadRequest, error) {
	req := &v1.SnoozeThreadRequest{Id: a.String("id")}
	unsnooze, save, hasUntil := a.Bool("clear"), a.Bool("save"), a.Has("until")
	ev, err := snoozeEvent(a)
	if err != nil {
		return nil, err
	}
	if ev != nil {
		if unsnooze || save || hasUntil {
			return nil, InvalidArg("until-pr", "give one of until, save, clear, until-pr or until-plugin")
		}
		req.Event = ev
		return req, nil
	}
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
		return nil, InvalidArg("until", "give until (%s), save, until-pr, until-plugin or clear", SnoozeUntilHelp)
	}
	t, err := parseSnoozeUntil(a.String("until"), now, time.Local)
	if err != nil {
		return nil, InvalidArg("until", "%v", err)
	}
	req.Until = timestamppb.New(t)
	return req, nil
}

// snoozeEvent is the event thread.snooze's until-pr (with on) or until-plugin (with arg)
// ask for; nil when neither is given.
func snoozeEvent(a Args) (*v1.SnoozeEvent, error) {
	pr, plugin := strings.TrimSpace(a.String("until-pr")), strings.TrimSpace(a.String("until-plugin"))
	args, err := parseWakeArgs(a.String("arg"))
	switch {
	case err != nil:
		return nil, err
	case pr != "" && plugin != "":
		return nil, InvalidArg("until-plugin", "give until-pr or until-plugin, not both")
	case a.Has("on") && pr == "":
		return nil, InvalidArg("on", "on goes with until-pr")
	case len(args) > 0 && plugin == "":
		return nil, InvalidArg("arg", "arg goes with until-plugin")
	case pr != "":
		return &v1.SnoozeEvent{PullRequest: pr, Condition: a.String("on")}, nil
	case plugin != "":
		return &v1.SnoozeEvent{Plugin: plugin, Args: args}, nil
	}
	return nil, nil
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
	case req.GetEvent() != nil:
		verb, tail = "snoozed", " until the event"
	}
	res := eachThread(ctx, ids, verb, func(ctx context.Context, id string) error {
		one := &v1.SnoozeThreadRequest{Id: id, Until: req.GetUntil(), Save: req.GetSave(), Event: req.GetEvent(), ByThreadId: askingThread(c)}
		_, err := b.Snooze(ctx, connect.NewRequest(one))
		return err
	})
	return afterCount(res, verb, tail)
}
