package command

import (
	"context"
	"errors"
	"fmt"
	"maps"
	"slices"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// notificationActionCall is the command an action runs and its raw args.
type notificationActionCall func(n notification.Notification, a notification.Action) (name string, args map[string]string)

// notificationActionCalls maps each action kind to the registry command that runs it, so
// pressing an action is the same verb the user or the CLI would run. A kind without an
// entry fails notification.act with Unimplemented.
var notificationActionCalls = map[notification.ActionKind]notificationActionCall{
	notification.KindSend: func(_ notification.Notification, a notification.Action) (string, map[string]string) {
		return "thread.send", map[string]string{"id": a.ThreadID, "text": a.Text}
	},
	notification.KindStart: func(_ notification.Notification, a notification.Action) (string, map[string]string) {
		if a.ProjectID == "" {
			return "thread.new", map[string]string{"prompt": a.Prompt, "no-project": "true"}
		}
		return "thread.new", map[string]string{"prompt": a.Prompt, "project": a.ProjectID}
	},
	notification.KindOpen: func(_ notification.Notification, a notification.Action) (string, map[string]string) {
		return "view.open.url", map[string]string{"url": a.URL}
	},
	// A plugin's own manifest command (the source is the plugin's name), as the palette
	// runs it: its confirm asks first, and its when clause is checked without a thread or
	// project (the args say what it is about). From a host source in verbSources, the
	// registry verb the action names.
	notification.KindCommand: func(n notification.Notification, a notification.Action) (string, map[string]string) {
		if slices.Contains(verbSources, n.Source) {
			return a.Command, maps.Clone(a.Args)
		}
		return "plugin." + n.Source + "." + a.Command, maps.Clone(a.Args)
	},
}

// verbSources are the host sources whose command actions name a registry verb themselves
// rather than a plugin's manifest command: the daemon's plugin health notifications
// (Restart is plugin.restart, Open plugins is view.settings --page plugins), its GitHub
// ones (Open PR is view.open.pr --repo-slug --number --focus, the pull request's tab of no
// thread), its notices about the app (Open settings is view.settings --setting) and its
// auto-tidy ones (Open settings is view.settings --page general). No plugin can post as one
// (the daemon refuses a plugin by that name), and notification.post posts as SourceCommand,
// which may not carry command actions at all.
var verbSources = []string{notification.SourcePlugins, notification.SourceGitHub, notification.SourceApp, notification.SourceThreads}

// notificationAct is notification.act: run one of a notification's actions through the
// command its kind maps to (notificationActionCalls), then resolve the notification when
// the action resolves it. The command runs with none of the caller's thread, project or
// worktree: the action says all it means.
func notificationAct(r *Registry, s notification.Store) Command {
	return Command{
		Name:         "notification.act",
		NoPalette:    true,
		NoIndex:      true,
		Title:        "Notifications: Run Action",
		Description:  "Run one of a notification's actions, as its button does; an action that resolves the notification closes it.",
		Category:     "Notifications",
		NoKeybinding: true,
		Args: []ArgSpec{notificationIDArg,
			{Name: "action", Type: Int, Default: "1", Description: "The action's number in notification list (1, the primary, by default)"}},
		Run: func(ctx context.Context, uctx Context, a Args) (Result, error) {
			index := a.Int("action") - 1
			if index < 0 {
				return Result{}, InvalidArg("action", "action %d: actions are numbered from 1", index+1)
			}
			var res Result
			n, act, err := s.Act(ctx, a.String("id"), index, func(ctx context.Context, n notification.Notification, act notification.Action) error {
				call := notificationActionCalls[act.Kind]
				if call == nil {
					return connect.NewError(connect.CodeUnimplemented, fmt.Errorf("a %s action cannot run in this version", act.Kind))
				}
				name, raw := call(n, act)
				var err error
				res, err = r.Invoke(ctx, Context{ActiveView: uctx.ActiveView, Origin: uctx.Origin}, name, raw, Confirmed(ConfirmedIn(ctx)))
				return err
			})
			if err != nil {
				var ce *ConfirmError
				if errors.As(err, &ce) {
					return Result{}, err
				}
				return Result{}, notificationErr(err, "action")
			}
			msg := fmt.Sprintf("ran %q on notification %s", act.Label, n.ID)
			if n.State == notification.StateResolved {
				msg += ", which is resolved"
			}
			if res.Message != "" {
				msg += ": " + res.Message
			}
			return Result{Message: msg, JSON: NotificationActView{Notification: notificationView(n), Action: notificationActionView(act), Result: res.JSON}}, nil
		},
	}
}
