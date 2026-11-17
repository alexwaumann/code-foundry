package daemon

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/notification/notificationtest"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// The adapter posts under source = the plugin's name with the store's key rules, maps the
// store's errors to the plugin store's, withdraws only that source's keys, and never
// treats the app's own source ("command") as a plugin's.
func TestPluginNotifications(t *testing.T) {
	ctx := context.Background()
	s := notificationtest.New(t, notificationtest.Options{Threads: []string{"s-1"}})
	sink := pluginNotifications{store: s}
	yes := true

	for _, tt := range []struct {
		name, source string
		n            pluginsdk.Notification
		want         string
		wantStatus   string
		err          error
	}{
		{name: "posted", source: "ci", n: pluginsdk.Notification{Key: "build", Title: "Build failed", ThreadID: "s-1", Level: pluginsdk.NotifyError,
			Actions: []pluginsdk.NotificationAction{pluginsdk.CommandAction("Open", "open", map[string]string{"item": "7"}),
				{Label: "Logs", Kind: pluginsdk.ActionOpen, URL: "https://example.com", Resolves: &yes}}},
			want: pluginsdk.NotifyPosted, wantStatus: "shown"},
		{name: "same content", source: "ci", n: pluginsdk.Notification{Key: "build", Title: "Build failed", ThreadID: "s-1", Level: pluginsdk.NotifyError,
			Actions: []pluginsdk.NotificationAction{pluginsdk.CommandAction("Open", "open", map[string]string{"item": "7"}),
				{Label: "Logs", Kind: pluginsdk.ActionOpen, URL: "https://example.com", Resolves: &yes}}},
			want: pluginsdk.NotifyUnchanged, wantStatus: "shown"},
		{name: "the same key from another plugin", source: "deploy", n: pluginsdk.Notification{Key: "build", Title: "Deployed"},
			want: pluginsdk.NotifyPosted, wantStatus: "shown"},
		{name: "no thread", source: "ci", n: pluginsdk.Notification{Title: "x", ThreadID: "s-2"}, err: plugin.ErrNotFound},
		{name: "bad level", source: "ci", n: pluginsdk.Notification{Title: "x", Level: "success"}, err: plugin.ErrInvalidArgument},
		{name: "a plugin named command", source: notification.SourceCommand, n: pluginsdk.Notification{Title: "x"}, err: plugin.ErrInvalidArgument},
		{name: "a plugin named github", source: githubSource, n: pluginsdk.Notification{Title: "x"}, err: plugin.ErrInvalidArgument},
	} {
		if err := sink.Check(tt.source, tt.n); !errors.Is(err, tt.err) || (tt.err == nil && err != nil) {
			t.Errorf("%s: Check = %v, want %v", tt.name, err, tt.err)
		}
		r, err := sink.Post(ctx, tt.source, tt.n)
		if tt.err != nil {
			if !errors.Is(err, tt.err) {
				t.Errorf("%s: Post = %v, want %v", tt.name, err, tt.err)
			}
			continue
		}
		if err != nil || r.Outcome != tt.want || r.Status != tt.wantStatus || r.Key != tt.n.Key || r.ID == "" {
			t.Errorf("%s: %+v, %v", tt.name, r, err)
		}
	}
	n, ok := s.Active("ci", "build")
	if !ok || n.Level != notification.LevelError || len(n.Actions) != 2 || n.Actions[0].Kind != notification.KindCommand ||
		n.Actions[0].Args["item"] != "7" || !n.Actions[0].Resolves || !n.Actions[1].Resolves {
		t.Errorf("stored %+v", n)
	}

	// The app's own notifications are no plugin's: not listed, never withdrawn with one.
	for _, src := range hostSources {
		if _, err := s.Post(ctx, notification.Post{Source: src, Title: "Mine"}); err != nil {
			t.Fatal(err)
		}
	}
	if got := sink.Sources(); !slices.Equal(got, []string{"ci", "deploy"}) {
		t.Errorf("Sources = %v", got)
	}
	for _, src := range hostSources {
		if n, err := sink.WithdrawAll(ctx, src); n != 0 || err != nil {
			t.Errorf("WithdrawAll(%s) = %d, %v", src, n, err)
		}
	}

	// Withdraw: by source and key, idempotent.
	for _, tt := range []struct {
		source, key string
		want        bool
	}{{"deploy", "nope", false}, {"ci", "build", true}, {"ci", "build", false}} {
		if got, err := sink.Withdraw(ctx, tt.source, tt.key); got != tt.want || err != nil {
			t.Errorf("Withdraw(%s, %s) = %v, %v", tt.source, tt.key, got, err)
		}
	}
	if _, ok := s.Active("deploy", "build"); !ok {
		t.Error("another plugin's key went")
	}
	if n, err := sink.WithdrawAll(ctx, "deploy"); n != 1 || err != nil {
		t.Errorf("WithdrawAll(deploy) = %d, %v", n, err)
	}
	if got := s.Sources(); !slices.Equal(got, slices.Sorted(slices.Values(hostSources))) {
		t.Errorf("left %v", got)
	}
}
