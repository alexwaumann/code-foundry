package plugintest_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// notifier posts, withdraws and fires with a notification from its commands; "open"
// records the item a button asked for.
func notifier(opened *[]string) pluginsdk.Plugin {
	note := func(req pluginsdk.CommandRequest) pluginsdk.Notification {
		return pluginsdk.Notification{Key: req.Arg("key"), Title: req.Arg("title"), TimeSensitive: req.Arg("urgent") == "true",
			Actions: []pluginsdk.NotificationAction{pluginsdk.CommandAction("Open", req.Arg("command"), map[string]string{"item": "7"})}}
	}
	return pluginsdk.Plugin{Commands: map[string]pluginsdk.CommandFunc{
		"post": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			r, err := h.Notify(ctx, note(req))
			js, _ := json.Marshal(r)
			return pluginsdk.CommandResult{JSON: js}, err
		},
		"withdraw": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			gone, err := h.WithdrawNotification(ctx, req.Arg("key"))
			if gone {
				return pluginsdk.CommandResult{Message: "gone"}, err
			}
			return pluginsdk.CommandResult{Message: "none"}, err
		},
		"fire": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			r, err := h.FireWakeNotify(ctx, "done", nil, "done", nil, note(req))
			js, _ := json.Marshal(r)
			return pluginsdk.CommandResult{JSON: js}, err
		},
		"open": func(_ context.Context, _ *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			*opened = append(*opened, req.Arg("item"))
			return pluginsdk.CommandResult{Message: "opened " + req.Arg("item")}, nil
		},
	}}
}

var notifierCommands = []pluginsdk.CommandSpec{
	{Name: "post"}, {Name: "withdraw"}, {Name: "fire"}, {Name: "open", Args: []pluginsdk.ArgSpec{{Name: "item"}}},
}

func TestNotifications(t *testing.T) {
	ctx := context.Background()
	var opened []string
	h := plugintest.Start(t, notifier(&opened), plugintest.Options{Name: "ci", Commands: notifierCommands,
		Granted: pluginsdk.Permissions{Notifications: true}, Wakes: []pluginsdk.WakeSpec{{Name: "done", Title: "Done"}}})
	post := func(cmd string, args map[string]string) (pluginsdk.NotifyResult, error) {
		if args["command"] == "" {
			args["command"] = "open"
		}
		res, err := h.Command(ctx, cmd, args, pluginsdk.UiContext{})
		var r pluginsdk.NotifyResult
		if cmd == "fire" {
			var w pluginsdk.WakeFireResult
			_ = json.Unmarshal(res.JSON, &w)
			if w.Notification != nil {
				r = *w.Notification
			}
		} else {
			_ = json.Unmarshal(res.JSON, &r)
		}
		return r, err
	}

	// The key rules.
	for _, step := range []struct {
		name, title string
		dismiss     bool
		want        string
		wantStatus  string
	}{
		{"first post", "Build failed", false, pluginsdk.NotifyPosted, plugintest.StatusShown},
		{"same content", "Build failed", false, pluginsdk.NotifyUnchanged, plugintest.StatusShown},
		{"changed content", "Build failed again", false, pluginsdk.NotifyUpdated, plugintest.StatusShown},
		{"dismissed, same content", "Build failed again", true, pluginsdk.NotifyUnchanged, plugintest.StatusDismissed},
		{"dismissed, changed content", "Build failed thrice", false, pluginsdk.NotifyPosted, plugintest.StatusShown},
	} {
		if step.dismiss {
			if err := h.DismissNotification("build"); err != nil {
				t.Fatal(err)
			}
		}
		r, err := post("post", map[string]string{"key": "build", "title": step.title})
		if err != nil || r.Outcome != step.want || r.Status != step.wantStatus || r.Key != "build" {
			t.Errorf("%s: %+v, %v; want %s %s", step.name, r, err, step.want, step.wantStatus)
		}
	}

	// Pressing the command action runs the plugin's command with its args and resolves it.
	if res, err := h.PressAction(ctx, "build", 0); err != nil || res.Message != "opened 7" {
		t.Fatalf("press = %q, %v", res.Message, err)
	}
	if _, status, _ := h.Notification("build"); status != plugintest.StatusResolved || len(opened) != 1 {
		t.Errorf("after press: %s, opened %v", status, opened)
	}

	// Refusals: an undeclared command; withdraw is by key and idempotent.
	if _, err := post("post", map[string]string{"key": "x", "title": "x", "command": "deploy"}); !isCode(err, pluginsdk.CodeInvalidParams) {
		t.Errorf("undeclared command: %v", err)
	}
	if _, err := post("post", map[string]string{"key": "w", "title": "W"}); err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"gone", "none"} {
		if res, err := h.Command(ctx, "withdraw", map[string]string{"key": "w"}, pluginsdk.UiContext{}); err != nil || res.Message != want {
			t.Errorf("withdraw = %q, %v; want %s", res.Message, err, want)
		}
	}

	// Routing: a normal notification on a fire nobody gets is raised; one a thread gets
	// is not; a time-sensitive one is raised either way.
	if r, _ := post("fire", map[string]string{"key": "done", "title": "Done"}); r.Outcome != pluginsdk.NotifyPosted {
		t.Errorf("no subscriber: %+v", r)
	}
	if _, err := h.SubscribeWake("done", nil, pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	if r, _ := post("fire", map[string]string{"key": "done", "title": "Done again"}); r.Outcome != pluginsdk.NotifyRouted {
		t.Errorf("subscribed: %+v", r)
	}
	if n, _, _ := h.Notification("done"); n.Title != "Done" {
		t.Errorf("a routed fire changed the notification: %+v", n)
	}
	if r, _ := post("fire", map[string]string{"key": "urgent", "title": "Down", "urgent": "true"}); r.Outcome != pluginsdk.NotifyPosted {
		t.Errorf("time-sensitive, subscribed: %+v", r)
	}
	if d := h.WakeDelivered(); len(d) != 3 || d[0] != 0 || d[1] != 1 || d[2] != 1 {
		t.Errorf("delivered %v", d)
	}
	if got := len(h.ActiveNotifications()); got != 2 { // done, urgent
		t.Errorf("%d active", got)
	}
}

// Without permissions.notifications every call is refused, and a fire carrying a
// notification does not go.
func TestNotificationsPermission(t *testing.T) {
	ctx := context.Background()
	var opened []string
	h := plugintest.Start(t, notifier(&opened), plugintest.Options{Name: "ci", Wakes: []pluginsdk.WakeSpec{{Name: "done", Title: "Done"}}})
	if _, err := h.SubscribeWake("done", nil, pluginsdk.UiContext{ThreadID: "s-1"}); err != nil {
		t.Fatal(err)
	}
	for _, cmd := range []string{"post", "withdraw", "fire"} {
		_, err := h.Command(ctx, cmd, map[string]string{"key": "k", "title": "T", "command": "open"}, pluginsdk.UiContext{})
		if !isCode(err, pluginsdk.CodePermissionDenied) {
			t.Errorf("%s: %v, want permission denied", cmd, err)
		}
	}
	if d := h.WakeDelivered(); len(d) != 1 || d[0] != 0 {
		t.Errorf("the refused fire was delivered: %v", d)
	}
}

func isCode(err error, code int) bool {
	var e *pluginsdk.Error
	return errors.As(err, &e) && e.Code == code
}
