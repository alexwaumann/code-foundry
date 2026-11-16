package command_test

import (
	"context"
	"errors"
	"maps"
	"strings"
	"testing"
	"time"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
)

// call is one command the action dispatch ran.
type call struct {
	name string
	args map[string]string
	uctx command.Context
}

// newNotificationRegistry registers notification.* over a real store with the test's
// clock, and stand-ins for the verbs actions run (thread.send, thread.new, view.open.url)
// that record their calls; fail makes them fail.
func newNotificationRegistry(t *testing.T, fail error) (*command.Registry, *notificationtest.Store, *[]call) {
	t.Helper()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-7754a478e649"}})
	r := command.NewRegistry()
	if err := command.RegisterNotification(r, command.NotificationDeps{Store: s, Now: s.Clock.Now}); err != nil {
		t.Fatal(err)
	}
	var calls []call
	stand := func(name string, args ...string) command.Command {
		var specs []command.ArgSpec
		for _, a := range args {
			specs = append(specs, command.ArgSpec{Name: a, Type: command.String})
		}
		return command.Command{Name: name, Title: name, Category: "Test", Page: command.PageState, Args: specs,
			Run: func(_ context.Context, uctx command.Context, a command.Args) (command.Result, error) {
				got := map[string]string{}
				for _, n := range args {
					if a.Has(n) {
						got[n] = a.String(n)
					}
				}
				calls = append(calls, call{name: name, args: got, uctx: uctx})
				if fail != nil {
					return command.Result{}, fail
				}
				return command.Result{Message: name + " ran"}, nil
			}}
	}
	if err := r.RegisterAll(stand("thread.send", "id", "text"), stand("thread.new", "prompt", "project", "no-project"),
		stand("view.open.url", "url")); err != nil {
		t.Fatal(err)
	}
	return r, s, &calls
}

func TestNotificationCommands(t *testing.T) {
	r, s, _ := newNotificationRegistry(t, nil)
	ctx := context.Background()
	inv := func(name string, args map[string]string) (command.Result, error) {
		return r.Invoke(ctx, command.Context{}, name, args)
	}
	var id string
	// Steps run in order against one store.
	for _, tt := range []struct {
		name    string
		cmd     string
		args    map[string]string
		advance time.Duration
		tick    bool
		wantMsg string
		wantErr func(error) bool
		check   func(t *testing.T, res command.Result)
	}{
		{name: "list empty", cmd: "notification.list", wantMsg: "no notifications"},
		{name: "post", cmd: "notification.post", args: map[string]string{"title": "Build failed", "key": "ci", "level": "error", "time-sensitive": "true"},
			wantMsg: "posted notification n-", check: func(t *testing.T, res command.Result) {
				v := res.JSON.(command.NotificationPostView)
				id = v.Notification.ID
				if v.Outcome != "posted" || v.Notification.Source != "command" || v.Notification.Level != "error" || !v.Notification.TimeSensitive ||
					v.Notification.Status != "shown" || v.Notification.ArrivedAt != "2026-11-16T09:00:00.000Z" {
					t.Errorf("post view %+v", v)
				}
			}},
		{name: "post the same", cmd: "notification.post", args: map[string]string{"title": "Build failed", "key": "ci", "level": "error", "time-sensitive": "true"},
			wantMsg: "unchanged: notification n-"},
		{name: "post changed", cmd: "notification.post", args: map[string]string{"title": "Build failed", "key": "ci", "level": "error", "body": "3 tests"},
			wantMsg: "updated notification n-"},
		{name: "list", cmd: "notification.list", wantMsg: "shown", check: func(t *testing.T, res command.Result) {
			v := res.JSON.(command.NotificationListView)
			if len(v.Notifications) != 1 || v.Notifications[0].Body != "3 tests" || v.TimeSensitive != 0 {
				t.Errorf("list view %+v", v)
			}
		}},
		{name: "snooze needs until", cmd: "notification.snooze", args: map[string]string{"id": "n-x"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }},
		{name: "snooze a bad until", cmd: "notification.snooze", args: map[string]string{"id": "n-x", "until": "soonish"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }},
		{name: "snooze an unknown one", cmd: "notification.snooze", args: map[string]string{"id": "n-000000000000", "until": "1h"},
			wantErr: func(err error) bool { return connect.CodeOf(err) == connect.CodeNotFound }},
		{name: "dismiss", cmd: "notification.dismiss", args: map[string]string{"id": "<id>"}, wantMsg: "dismissed notification n-"},
		{name: "dismiss again", cmd: "notification.dismiss", args: map[string]string{"id": "<id>"}, wantMsg: "was dismissed already"},
		{name: "post the dismissed content", cmd: "notification.post", args: map[string]string{"title": "Build failed", "key": "ci", "level": "error", "body": "3 tests"},
			wantMsg: "unchanged: notification n-", check: func(t *testing.T, res command.Result) {
				if v := res.JSON.(command.NotificationPostView); v.Notification.Status != "dismissed" {
					t.Errorf("status %s, want dismissed", v.Notification.Status)
				}
			}},
		{name: "list all shows the dismissed one", cmd: "notification.list", args: map[string]string{"all": "true"}, wantMsg: "dismissed"},
		{name: "post it changed", cmd: "notification.post", args: map[string]string{"title": "Build failed", "key": "ci", "level": "error", "body": "4 tests"},
			wantMsg: "posted notification n-"},
		{name: "snooze", cmd: "notification.snooze", args: map[string]string{"id": "<id>", "until": "10m"}, wantMsg: "snoozed notification n-"},
		{name: "list snoozed", cmd: "notification.list", wantMsg: "snoozed until"},
		{name: "back after the snooze", cmd: "notification.list", advance: 10 * time.Minute, tick: true, check: func(t *testing.T, res command.Result) {
			if v := res.JSON.(command.NotificationListView); v.Notifications[0].Status != "shown" {
				t.Errorf("after the snooze: %s", v.Notifications[0].Status)
			}
		}},
		{name: "show-at", cmd: "notification.post", args: map[string]string{"title": "Standup", "key": "standup", "show-at": "5m"},
			wantMsg: "scheduled notification n-"},
		{name: "a past show-at", cmd: "notification.post", args: map[string]string{"title": "Standup", "show-at": "-5m"},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }},
		{name: "a thread that does not exist", cmd: "notification.post", args: map[string]string{"title": "Hi", "thread": "s-000000000000"},
			wantErr: func(err error) bool { return connect.CodeOf(err) == connect.CodeNotFound }},
		{name: "a thread by suffix", cmd: "notification.post", args: map[string]string{"title": "Thread note", "thread": "s-7754a478e649"},
			wantMsg: "posted notification n-", check: func(t *testing.T, res command.Result) {
				if v := res.JSON.(command.NotificationPostView); v.Notification.ThreadID != "s-7754a478e649" {
					t.Errorf("thread %q", v.Notification.ThreadID)
				}
			}},
		{name: "a long title", cmd: "notification.post", args: map[string]string{"title": strings.Repeat("x", 121)},
			wantErr: func(err error) bool { return errors.Is(err, command.ErrInvalidArgs) }},
		{name: "withdraw another's key", cmd: "notification.withdraw", args: map[string]string{"key": "nope"},
			wantErr: func(err error) bool { return connect.CodeOf(err) == connect.CodeNotFound }},
		{name: "withdraw", cmd: "notification.withdraw", args: map[string]string{"key": "standup"}, wantMsg: "withdrew notification n-"},
		{name: "clear", cmd: "notification.clear", wantMsg: "dismissed 2 notifications"},
		{name: "clear empty", cmd: "notification.clear", wantMsg: "no notifications to clear"},
	} {
		s.Clock.Advance(tt.advance)
		if tt.tick {
			s.Tick()
		}
		args := maps.Clone(tt.args)
		if args["id"] == "<id>" {
			args["id"] = id[len(id)-6:] // a suffix resolves
		}
		res, err := inv(tt.cmd, args)
		if tt.wantErr != nil {
			if err == nil || !tt.wantErr(err) {
				t.Errorf("%s: err %v", tt.name, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", tt.name, err)
		}
		if !strings.Contains(res.Message, tt.wantMsg) {
			t.Errorf("%s: message %q, want %q in it", tt.name, res.Message, tt.wantMsg)
		}
		if tt.check != nil {
			tt.check(t, res)
		}
	}
}

// notification.act runs each kind through the verb it maps to, with none of the caller's
// thread or project, and resolves the notification when the action does.
func TestNotificationAct(t *testing.T) {
	ctx := context.Background()
	gui := command.Context{ActiveView: "thread", ActiveThreadID: "s-7754a478e649", ActiveProjectID: "web", ActiveWorktreePath: "/w"}
	for _, tt := range []struct {
		name      string
		action    notification.ActionSpec
		source    string
		fail      error
		wantCall  call
		wantState string
		wantErr   func(error) bool
	}{
		{name: "send", action: notification.ActionSpec{Action: notification.Action{Label: "Tell", Kind: notification.KindSend, ThreadID: "s-7754a478e649", Text: "go on"}},
			wantCall: call{name: "thread.send", args: map[string]string{"id": "s-7754a478e649", "text": "go on"}}, wantState: "resolved"},
		{name: "start in a project", action: notification.ActionSpec{Action: notification.Action{Label: "Fix", Kind: notification.KindStart, Prompt: "fix it", ProjectID: "api"}},
			wantCall: call{name: "thread.new", args: map[string]string{"prompt": "fix it", "project": "api"}}, wantState: "resolved"},
		{name: "start without a project", action: notification.ActionSpec{Action: notification.Action{Label: "Ask", Kind: notification.KindStart, Prompt: "why"}},
			wantCall: call{name: "thread.new", args: map[string]string{"prompt": "why", "no-project": "true"}}, wantState: "resolved"},
		{name: "open does not resolve", action: notification.ActionSpec{Action: notification.Action{Label: "Logs", Kind: notification.KindOpen, URL: "https://ci.example.com/1"}},
			wantCall: call{name: "view.open.url", args: map[string]string{"url": "https://ci.example.com/1"}}, wantState: "shown"},
		{name: "a failed action leaves it", fail: errors.New("thread is gone"),
			action:   notification.ActionSpec{Action: notification.Action{Label: "Tell", Kind: notification.KindSend, ThreadID: "s-7754a478e649", Text: "go on"}},
			wantCall: call{name: "thread.send", args: map[string]string{"id": "s-7754a478e649", "text": "go on"}}, wantState: "shown",
			wantErr: func(err error) bool { return strings.Contains(err.Error(), "thread is gone") }},
		{name: "a command action waits for plugin notifications", source: "ci",
			action:    notification.ActionSpec{Action: notification.Action{Label: "Retry", Kind: notification.KindCommand, Command: "retry"}},
			wantState: "shown", wantErr: func(err error) bool { return connect.CodeOf(err) == connect.CodeUnimplemented }},
	} {
		t.Run(tt.name, func(t *testing.T) {
			r, s, calls := newNotificationRegistry(t, tt.fail)
			res, err := s.Post(ctx, notification.Post{Source: cmpOr(tt.source, notification.SourceCommand), Title: "Hi", Actions: []notification.ActionSpec{tt.action}})
			if err != nil {
				t.Fatal(err)
			}
			id := res.Notification.ID
			out, err := r.Invoke(ctx, gui, "notification.act", map[string]string{"id": id})
			switch {
			case tt.wantErr != nil:
				if err == nil || !tt.wantErr(err) {
					t.Fatalf("err %v", err)
				}
			case err != nil:
				t.Fatal(err)
			default:
				if v := out.JSON.(command.NotificationActView); v.Notification.Status != tt.wantState || v.Action.Label != tt.action.Label {
					t.Errorf("act view %+v", v)
				}
			}
			if tt.wantCall.name == "" {
				if len(*calls) != 0 {
					t.Errorf("ran %v", *calls)
				}
			} else if len(*calls) != 1 || (*calls)[0].name != tt.wantCall.name || !maps.Equal((*calls)[0].args, tt.wantCall.args) {
				t.Errorf("ran %+v, want %+v", *calls, tt.wantCall)
			} else if c := (*calls)[0].uctx; c.ActiveThreadID != "" || c.ActiveProjectID != "" || c.ActiveWorktreePath != "" || c.ActiveView != "thread" {
				t.Errorf("ran with context %+v, want only the view", c)
			}
			if n, _ := s.Get(id); string(n.Status()) != tt.wantState {
				t.Errorf("status %s, want %s", n.Status(), tt.wantState)
			}
		})
	}
	t.Run("no such action", func(t *testing.T) {
		r, s, _ := newNotificationRegistry(t, nil)
		res, _ := s.Post(ctx, notification.Post{Source: "command", Title: "Hi"})
		if _, err := r.Invoke(ctx, command.Context{}, "notification.act", map[string]string{"id": res.Notification.ID, "action": "2"}); !errors.Is(err, command.ErrInvalidArgs) {
			t.Errorf("err %v, want an args error", err)
		}
	})
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func TestNotificationCommandsWithoutStore(t *testing.T) {
	r := command.NewRegistry()
	if err := command.RegisterNotification(r, command.NotificationDeps{}); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Invoke(context.Background(), command.Context{}, "notification.post", map[string]string{"title": "Hi"}); connect.CodeOf(err) != connect.CodeUnimplemented {
		t.Errorf("post: %v, want Unimplemented", err)
	}
}
