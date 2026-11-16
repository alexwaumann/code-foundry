package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"strconv"
	"strings"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Notifications (permission notifications; docs/notes/notifications-2-plugins.md): a
// plugin posts notifications to the bell and withdraws them by key. The notification
// store keeps them (the daemon adapts it as NotificationSink) under source = the
// plugin's name, so a plugin only ever reaches its own keys. This side checks the
// permission and the rate, checks that a command action names one of the plugin's own
// manifest commands (with args that command declares), routes a notification attached to
// wake/fire (wakes.go), and withdraws a plugin's notifications when it is disabled or
// removed (release). A restart or an update keeps them.

// NotificationSink is the notification store as plugin notifications need it; source is
// the plugin's name. Errors wrap ErrNotFound (a thread that does not exist),
// ErrInvalidArgument (a bad notification) and ErrFailedPrecondition (too many active).
type NotificationSink interface {
	// Check reports whether Post would take n, without posting it.
	Check(source string, n pluginsdk.Notification) error
	// Post applies the key rules and says what they did.
	Post(ctx context.Context, source string, n pluginsdk.Notification) (pluginsdk.NotifyResult, error)
	// Withdraw withdraws source's notification with key and reports whether an active one
	// went (a key with none is not an error).
	Withdraw(ctx context.Context, source, key string) (bool, error)
	// WithdrawAll withdraws every active notification of source and says how many.
	WithdrawAll(ctx context.Context, source string) (int, error)
	// Sources names every plugin with an active notification.
	Sources() []string
}

// maxNotifyPerSecond bounds a plugin's notification/post calls (an unchanged re-post
// counts; withdrawing is never limited).
const maxNotifyPerSecond = 10

func notificationsGranted(p pluginsdk.Permissions) bool { return p.Notifications }

func init() {
	hostMethods[pluginsdk.MethodNotificationPost] = hostMethod{perm: notificationsGranted, permName: "notifications", handle: (*actor).notificationPost}
	hostMethods[pluginsdk.MethodNotificationWithdraw] = hostMethod{perm: notificationsGranted, permName: "notifications", handle: (*actor).notificationWithdraw}
	hostCapabilities = append(hostCapabilities, pluginsdk.NotificationsCapability)
}

// notificationPost serves notification/post.
func (a *actor) notificationPost(ctx context.Context, params json.RawMessage) (any, error) {
	sink := a.m.opts.Notifications
	if sink == nil {
		return nil, notServed(pluginsdk.MethodNotificationPost)
	}
	n, err := decodeParams[pluginsdk.Notification](pluginsdk.MethodNotificationPost, params)
	if err != nil {
		return nil, err
	}
	if err := a.checkNotification(pluginsdk.MethodNotificationPost, n); err != nil {
		return nil, err
	}
	if !a.notes.allow(a.m.opts.Now(), maxNotifyPerSecond) {
		return nil, pluginsdk.NewError(pluginsdk.CodeRateLimited, "%s: at most %d posts a second", pluginsdk.MethodNotificationPost, maxNotifyPerSecond)
	}
	return a.postNotification(ctx, pluginsdk.MethodNotificationPost, n)
}

// postNotification posts n (checked) and logs what it did.
func (a *actor) postNotification(ctx context.Context, method string, n pluginsdk.Notification) (pluginsdk.NotifyResult, error) {
	res, err := a.m.opts.Notifications.Post(ctx, a.name, n)
	if err != nil {
		a.hostLog("%s refused: %v", method, err)
		return pluginsdk.NotifyResult{}, notifyError(method, err)
	}
	if res.Outcome == pluginsdk.NotifyUnchanged {
		// A plugin re-asserting its notification on every poll is routine.
		a.hostDebug("notification %s unchanged (%s)", res.Key, res.Status)
	} else {
		a.hostLog("notification %s %s: %s", res.Key, res.Outcome, strings.TrimSpace(n.Title))
	}
	return res, nil
}

// notificationWithdraw serves notification/withdraw.
func (a *actor) notificationWithdraw(ctx context.Context, params json.RawMessage) (any, error) {
	sink := a.m.opts.Notifications
	if sink == nil {
		return nil, notServed(pluginsdk.MethodNotificationWithdraw)
	}
	p, err := decodeParams[pluginsdk.NotificationWithdraw](pluginsdk.MethodNotificationWithdraw, params)
	if err != nil {
		return nil, err
	}
	key := strings.TrimSpace(p.Key)
	if key == "" {
		return nil, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: key is required", pluginsdk.MethodNotificationWithdraw)
	}
	gone, err := sink.Withdraw(ctx, a.name, key)
	if err != nil {
		return nil, notifyError(pluginsdk.MethodNotificationWithdraw, err)
	}
	if gone {
		a.hostLog("notification %s withdrawn", key)
	} else {
		a.hostDebug("notification %s: nothing active to withdraw", key)
	}
	return pluginsdk.NotificationWithdrawResult{Withdrawn: gone}, nil
}

// checkNotification refuses n before anything happens: a command action must name one of
// the plugin's manifest commands, with args that command declares; the rest is the
// store's check (Check).
func (a *actor) checkNotification(method string, n pluginsdk.Notification) error {
	if strings.HasPrefix(strings.TrimSpace(n.Key), pluginsdk.FlagKeyPrefix) {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: key %q: keys starting with %q are the host's (thread flags)", method, n.Key, pluginsdk.FlagKeyPrefix)
	}
	pl, _ := a.m.Snapshot().Plugin(a.name)
	for i, act := range n.Actions {
		if act.Kind != pluginsdk.ActionCommand {
			continue
		}
		at := slices.IndexFunc(pl.Manifest.Commands, func(c pluginsdk.CommandSpec) bool { return c.Name == act.Command })
		if at < 0 {
			return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: action %d runs %q, which is not one of the commands in plugin.json (%s)",
				method, i+1, act.Command, commandNames(pl.Manifest))
		}
		spec := pl.Manifest.Commands[at]
		for k := range act.Args {
			if !slices.ContainsFunc(spec.Args, func(s pluginsdk.ArgSpec) bool { return s.Name == k }) {
				return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: action %d gives %s an arg %q it does not declare", method, i+1, act.Command, k)
			}
		}
	}
	if err := a.m.opts.Notifications.Check(a.name, n); err != nil {
		return notifyError(method, err)
	}
	return nil
}

func commandNames(mf pluginsdk.Manifest) string {
	if len(mf.Commands) == 0 {
		return "it declares none"
	}
	names := make([]string, len(mf.Commands))
	for i, c := range mf.Commands {
		names[i] = c.Name
	}
	return "it has " + strings.Join(names, ", ")
}

// notifyError maps a NotificationSink error to the protocol's codes.
func notifyError(method string, err error) error {
	switch {
	case errors.Is(err, ErrNotFound):
		return pluginsdk.NewError(pluginsdk.CodeNotFound, "%s: %v", method, err)
	case errors.Is(err, ErrInvalidArgument):
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, "%s: %v", method, err)
	case errors.Is(err, ErrFailedPrecondition):
		return pluginsdk.NewError(pluginsdk.CodeUnavailable, "%s: %v", method, err)
	}
	return pluginsdk.NewError(pluginsdk.CodeInternal, "%s: %v", method, err)
}

// routeNotification is a wake fire's attached notification after the fire reached
// delivered threads: a normal one is raised only when none got the wake, a
// time-sensitive one always.
func (a *actor) routeNotification(ctx context.Context, source string, delivered int, n pluginsdk.Notification) (pluginsdk.NotifyResult, error) {
	if delivered > 0 && !n.TimeSensitive {
		a.hostDebug("wake %s reached %d threads: its notification was not raised", source, delivered)
		return pluginsdk.NotifyResult{Key: strings.TrimSpace(n.Key), Outcome: pluginsdk.NotifyRouted}, nil
	}
	res, err := a.postNotification(ctx, pluginsdk.MethodWakeFire, n)
	if err != nil {
		return res, pluginsdk.NewError(pluginsdk.CodeUnavailable, "the wake reached %d threads, but its notification was not raised: %v", delivered, err)
	}
	return res, nil
}

// withdrawNotifications withdraws a plugin's notifications (it was disabled or removed).
func (m *Manager) withdrawNotifications(ctx context.Context, name string, logs *logBuffer) {
	if m.opts.Notifications == nil {
		return
	}
	n, err := m.opts.Notifications.WithdrawAll(ctx, name)
	switch {
	case err != nil:
		m.log.Warn("plugin: withdraw notifications", "plugin", name, "err", err)
	case n > 0 && logs != nil:
		logs.add("host", "", "withdrew its notifications: "+strconv.Itoa(n))
	}
}
