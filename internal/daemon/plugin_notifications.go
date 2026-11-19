package daemon

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// pluginNotifications adapts the notification store to plugin.NotificationSink: a plugin's
// notifications are the store's with source = the plugin's name
// (docs/notes/notifications-2-plugins.md). Neither store imports the other.
type pluginNotifications struct{ store pluginNotificationStore }

// pluginNotificationStore is the part of the notification store plugins reach.
// *notification.Manager implements it.
type pluginNotificationStore interface {
	Check(p notification.Post) error
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
	Withdraw(ctx context.Context, source, key string) (notification.Notification, error)
	WithdrawSource(ctx context.Context, source string) (int, error)
	Sources() []string
	Active(source, key string) (notification.Notification, bool)
}

var _ plugin.NotificationSink = pluginNotifications{}

// hostSources are notification sources that are not plugins: never a plugin's, never
// swept as a removed plugin's at start (plugin.Manager.sweep) nor withdrawn by a plugin's
// release. SourcePlugins' cards are the daemon's about a plugin (plugin_health.go): they
// stay exactly as long as their condition holds, whatever release does to the plugin's own.
// githubSource's are the daemon's from the GitHub poll (github_notifications.go), and
// SourceApp's its notices about the app itself (default_change.go).
var hostSources = []string{notification.SourceCommand, notification.SourcePlugins, githubSource, notification.SourceApp}

// notificationErrors map the notification store's errors to the plugin store's.
var notificationErrors = map[error]error{
	notification.ErrNotFound:           plugin.ErrNotFound,
	notification.ErrInvalidArgument:    plugin.ErrInvalidArgument,
	notification.ErrFailedPrecondition: plugin.ErrFailedPrecondition,
	notification.ErrFull:               plugin.ErrFailedPrecondition,
}

func mapNotificationErr(err error) error {
	for from, to := range notificationErrors {
		if errors.Is(err, from) {
			return kindError{kind: to, err: err}
		}
	}
	return err
}

// postOf is a plugin's notification as the store takes it.
func postOf(source string, n pluginsdk.Notification) (notification.Post, error) {
	if slices.Contains(hostSources, source) {
		return notification.Post{}, fmt.Errorf("%w: a plugin named %q cannot post notifications (the name is the app's own source)", plugin.ErrInvalidArgument, source)
	}
	p := notification.Post{
		Source: source, Key: n.Key, Level: notification.Level(n.Level), TimeSensitive: n.TimeSensitive,
		Title: n.Title, Body: n.Body, ThreadID: n.ThreadID, ShowAt: n.ShowAt,
	}
	for _, a := range n.Actions {
		p.Actions = append(p.Actions, notification.ActionSpec{Action: notification.Action{
			Label: a.Label, Kind: notification.ActionKind(a.Kind), Command: a.Command, Args: a.Args,
			ThreadID: a.ThreadID, Text: a.Text, Prompt: a.Prompt, ProjectID: a.ProjectID, URL: a.URL,
		}, Resolves: a.Resolves})
	}
	return p, nil
}

func (s pluginNotifications) Check(source string, n pluginsdk.Notification) error {
	p, err := postOf(source, n)
	if err != nil {
		return err
	}
	return mapNotificationErr(s.store.Check(p))
}

func (s pluginNotifications) Post(ctx context.Context, source string, n pluginsdk.Notification) (pluginsdk.NotifyResult, error) {
	p, err := postOf(source, n)
	if err != nil {
		return pluginsdk.NotifyResult{}, err
	}
	r, err := s.store.Post(ctx, p)
	if err != nil {
		return pluginsdk.NotifyResult{}, mapNotificationErr(err)
	}
	return pluginsdk.NotifyResult{ID: r.Notification.ID, Key: r.Notification.Key, Outcome: string(r.Outcome), Status: string(r.Notification.Status())}, nil
}

func (s pluginNotifications) Withdraw(ctx context.Context, source, key string) (bool, error) {
	if _, active := s.store.Active(source, key); !active {
		return false, nil
	}
	n, err := s.store.Withdraw(ctx, source, key)
	switch {
	case errors.Is(err, notification.ErrNotFound):
		return false, nil
	case err != nil:
		return false, mapNotificationErr(err)
	}
	return n.State == notification.StateWithdrawn, nil
}

func (s pluginNotifications) WithdrawAll(ctx context.Context, source string) (int, error) {
	if slices.Contains(hostSources, source) {
		return 0, nil
	}
	n, err := s.store.WithdrawSource(ctx, source)
	return n, mapNotificationErr(err)
}

func (s pluginNotifications) Sources() []string {
	return slices.DeleteFunc(s.store.Sources(), func(src string) bool { return slices.Contains(hostSources, src) })
}
