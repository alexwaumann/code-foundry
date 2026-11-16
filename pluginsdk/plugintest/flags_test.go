package plugintest_test

//lint:file-ignore SA1019 tests of the deprecated thread/setFlag in the fake host (pluginsdk/removals.go)

import (
	"context"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/pluginsdk"
	"github.com/alexwaumann/code-foundry/pluginsdk/plugintest"
)

// flagger sets the flag its args describe.
func flagger() pluginsdk.Plugin {
	return pluginsdk.Plugin{Commands: map[string]pluginsdk.CommandFunc{
		"flag": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			err := h.SetFlag(ctx, pluginsdk.Flag{ThreadID: req.Arg("thread"), Level: req.Arg("level"), Reason: req.Arg("reason"), UntilSeen: req.Arg("seen") == "true"})
			return pluginsdk.CommandResult{}, err
		},
		"post": func(ctx context.Context, h *pluginsdk.Host, req pluginsdk.CommandRequest) (pluginsdk.CommandResult, error) {
			_, err := h.Notify(ctx, pluginsdk.Notification{Key: req.Arg("key"), Title: "mine"})
			return pluginsdk.CommandResult{}, err
		},
	}}
}

// As on the host, a flag is a notification naming its thread: warning or error, titled
// with the reason (or the plugin's name), one per thread; none withdraws it; SeeThread
// dismisses an until-seen one; Options.Flags start active.
func TestSetFlagIsANotification(t *testing.T) {
	ctx := context.Background()
	h := plugintest.Start(t, flagger(), plugintest.Options{Name: "ci", Granted: pluginsdk.Permissions{ThreadStatus: true, Notifications: true},
		Flags: []pluginsdk.Flag{{ThreadID: "s-0", Level: pluginsdk.FlagError, Reason: "old"}}})
	flag := func(args map[string]string) {
		t.Helper()
		if _, err := h.Command(ctx, "flag", args, pluginsdk.UiContext{}); err != nil {
			t.Fatal(err)
		}
	}
	state := func() []string {
		var out []string
		for _, n := range h.ActiveNotifications() {
			out = append(out, n.Key+" "+n.Level+" "+n.Title+" "+n.ThreadID)
		}
		return out
	}
	if got := state(); !slices.Equal(got, []string{"flag:s-0 error old s-0"}) {
		t.Fatalf("seeded: %q", got)
	}
	flag(map[string]string{"thread": "s-1", "level": "attention", "reason": "deploy failed"})
	flag(map[string]string{"thread": "s-2", "level": "error"})
	flag(map[string]string{"thread": "s-3", "level": "attention", "reason": "look", "seen": "true"})
	want := []string{"flag:s-0 error old s-0", "flag:s-1 warning deploy failed s-1", "flag:s-2 error ci flagged this thread s-2", "flag:s-3:until-seen warning look s-3"}
	if got := state(); !slices.Equal(got, want) {
		t.Fatalf("after three flags: %q, want %q", got, want)
	}
	h.SeeThread("s-3")
	flag(map[string]string{"thread": "s-1", "level": "none"})
	if got := state(); !slices.Equal(got, []string{want[0], want[2]}) {
		t.Fatalf("after seeing s-3 and clearing s-1: %q", got)
	}
	if _, status, _ := h.Notification("flag:s-3:until-seen"); status != plugintest.StatusWithdrawn {
		t.Errorf("until-seen after SeeThread: %s", status)
	}
	if len(h.Flags()) != 4 {
		t.Errorf("Flags() recorded %d calls, want 4", len(h.Flags()))
	}
	// A plugin's own key may not use the flags' prefix; no threadStatus, no flag.
	if _, err := h.Command(ctx, "flag", map[string]string{"thread": "s-1", "level": "loud"}, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Errorf("bad level: %v", err)
	}
	if _, err := h.Command(ctx, "post", map[string]string{"key": "flag:s-1"}, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodeInvalidParams {
		t.Errorf("a plugin's own flag: key: %v", err)
	}
	mute := plugintest.Start(t, flagger(), plugintest.Options{})
	if _, err := mute.Command(ctx, "flag", map[string]string{"thread": "s-1", "level": "attention", "reason": "x"}, pluginsdk.UiContext{}); pluginsdk.ErrorCode(err) != pluginsdk.CodePermissionDenied {
		t.Errorf("no threadStatus: %v", err)
	}
}
