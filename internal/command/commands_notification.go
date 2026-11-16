package command

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"connectrpc.com/connect"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// NotificationDeps are what the notification.* commands use (docs/notes/notifications-1-store.md).
// A nil Store registers them failing with Unimplemented. Now is the clock --show-at and
// --until are read against (default time.Now).
type NotificationDeps struct {
	Store notification.Store
	Now   func() time.Time
}

// NotificationActionView is an action in the notification.* commands' JSON: only its
// kind's fields are set.
type NotificationActionView struct {
	Label     string            `json:"label"`
	Kind      string            `json:"kind"`
	Resolves  bool              `json:"resolves"`
	Command   string            `json:"command,omitempty"`
	Args      map[string]string `json:"args,omitempty"`
	ThreadID  string            `json:"thread_id,omitempty"`
	Text      string            `json:"text,omitempty"`
	Prompt    string            `json:"prompt,omitempty"`
	ProjectID string            `json:"project_id,omitempty"`
	URL       string            `json:"url,omitempty"`
}

// NotificationView is a notification in the notification.* commands' JSON. Times are
// RFC 3339 in UTC to the millisecond, "" for none.
type NotificationView struct {
	ID            string                   `json:"id"`
	Source        string                   `json:"source"`
	Key           string                   `json:"key"`
	Level         string                   `json:"level"`
	TimeSensitive bool                     `json:"time_sensitive"`
	Title         string                   `json:"title"`
	Body          string                   `json:"body"`
	ThreadID      string                   `json:"thread_id"`
	Actions       []NotificationActionView `json:"actions"`
	Status        string                   `json:"status"`
	ShowAt        string                   `json:"show_at"`
	CreatedAt     string                   `json:"created_at"`
	UpdatedAt     string                   `json:"updated_at"`
	ArrivedAt     string                   `json:"arrived_at"`
	SnoozedUntil  string                   `json:"snoozed_until"`
}

// NotificationListView is notification.list's JSON.
type NotificationListView struct {
	Notifications []NotificationView `json:"notifications"`
	// TimeSensitive counts the shown time-sensitive ones (the dock badge's share).
	TimeSensitive int `json:"time_sensitive"`
}

// NotificationPostView is notification.post's JSON: the notification and what the post
// did (posted, scheduled, updated or unchanged; notification.Outcome).
type NotificationPostView struct {
	Outcome      string           `json:"outcome"`
	Notification NotificationView `json:"notification"`
}

// NotificationActView is notification.act's JSON: the notification after the action, the
// action and the result of the command it ran.
type NotificationActView struct {
	Notification NotificationView       `json:"notification"`
	Action       NotificationActionView `json:"action"`
	Result       any                    `json:"result,omitempty"`
}

// NotificationClearView is notification.clear's JSON: how many were dismissed.
type NotificationClearView struct {
	Dismissed int `json:"dismissed"`
}

const notificationTimeLayout = "2006-01-02T15:04:05.000Z07:00"

func notificationTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(notificationTimeLayout)
}

func notificationActionView(a notification.Action) NotificationActionView {
	return NotificationActionView{Label: a.Label, Kind: string(a.Kind), Resolves: a.Resolves, Command: a.Command, Args: a.Args,
		ThreadID: a.ThreadID, Text: a.Text, Prompt: a.Prompt, ProjectID: a.ProjectID, URL: a.URL}
}

func notificationView(n notification.Notification) NotificationView {
	v := NotificationView{ID: n.ID, Source: n.Source, Key: n.Key, Level: string(n.Level), TimeSensitive: n.TimeSensitive,
		Title: n.Title, Body: n.Body, ThreadID: n.ThreadID, Actions: []NotificationActionView{}, Status: string(n.Status()),
		ShowAt: notificationTime(n.ShowAt), CreatedAt: notificationTime(n.CreatedAt), UpdatedAt: notificationTime(n.UpdatedAt),
		ArrivedAt: notificationTime(n.ArrivedAt), SnoozedUntil: notificationTime(n.SnoozedUntil)}
	for _, a := range n.Actions {
		v.Actions = append(v.Actions, notificationActionView(a))
	}
	return v
}

var notificationLevelNames = []string{string(notification.LevelInfo), string(notification.LevelWarning), string(notification.LevelError)}

// notificationIDArg is the notification an id-taking verb acts on.
var notificationIDArg = ArgSpec{Name: "id", Type: String, Required: true, Positional: true, ID: NotificationID,
	Description: "Notification id (notification list)" + IDHelp}

// RegisterNotification registers notification.post, .list, .dismiss, .snooze, .act,
// .clear and .withdraw: the bell's notifications. A notification posted here has the
// source "command"; a plugin's come through the plugin protocol.
func RegisterNotification(r *Registry, d NotificationDeps) error {
	s := d.Store
	if s == nil {
		s = noNotifications{}
	}
	now := d.Now
	if now == nil {
		now = time.Now
	}
	r.SetIDLister(NotificationID, func(context.Context) ([]string, error) {
		var ids []string
		for _, n := range s.List(true) {
			ids = append(ids, n.ID)
		}
		return ids, nil
	})
	return r.RegisterAll(
		Command{
			Name:      "notification.post",
			NoIndex:   true,
			Page:      PageState,
			NoPalette: true,
			Title:     "Notifications: Post",
			Description: "Post a notification to the bell. One per key: posting a key again with the same content changes nothing, " +
				"with new content updates it in place; a key the user dismissed stays dismissed until its content changes. " +
				"Without a key, the title, body and thread are the key.",
			Category:     "Notifications",
			NoKeybinding: true,
			Args: []ArgSpec{
				{Name: "title", Type: String, Required: true, Positional: true, Rest: true,
					Description: fmt.Sprintf("The title, one line of at most %d characters (several words need no quotes)", notification.MaxTitle)},
				{Name: "body", Type: String, Description: fmt.Sprintf("More detail, at most %d characters", notification.MaxBody)},
				{Name: "level", Type: Enum, Enum: notificationLevelNames, Default: string(notification.LevelInfo), Description: "How serious it is"},
				{Name: "key", Type: String, Description: "Identifies it: post the key again to update it, notification withdraw to take it back"},
				{Name: "thread", Type: String, ID: ThreadID, Description: "The thread it is about" + IDHelp},
				{Name: "time-sensitive", Type: Bool, Description: "Sort it first and count it in the Dock badge"},
				{Name: "show-at", Type: String, Description: "Keep it out of the bell until then: " + SnoozeUntilHelp},
			},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				p := notification.Post{Source: notification.SourceCommand, Key: a.String("key"), Level: notification.Level(a.String("level")),
					TimeSensitive: a.Bool("time-sensitive"), Title: a.String("title"), Body: a.String("body"), ThreadID: a.String("thread")}
				if a.Has("show-at") {
					t, err := parseSnoozeUntil(a.String("show-at"), now(), time.Local)
					if err != nil {
						return Result{}, InvalidArg("show-at", "%v", err)
					}
					p.ShowAt = t
				}
				res, err := s.Post(ctx, p)
				if err != nil {
					return Result{}, notificationErr(err, "title")
				}
				return Result{Message: postMessage(res, now()), JSON: NotificationPostView{Outcome: string(res.Outcome), Notification: notificationView(res.Notification)}}, nil
			},
		},
		Command{
			Name:         "notification.list",
			NoIndex:      true,
			NoPalette:    true,
			ReadOnly:     true,
			Title:        "Notifications: List",
			Description:  "List the bell's notifications, then the snoozed and scheduled ones; with all, also the dismissed, withdrawn and resolved ones the daemon keeps.",
			Category:     "Notifications",
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "all", Type: Bool, Description: "Also the dismissed, withdrawn and resolved ones"}},
			Run: func(_ context.Context, _ Context, a Args) (Result, error) {
				ns := s.List(a.Bool("all"))
				v := NotificationListView{Notifications: []NotificationView{}, TimeSensitive: s.Snapshot().TimeSensitive}
				for _, n := range ns {
					v.Notifications = append(v.Notifications, notificationView(n))
				}
				return Result{Message: formatNotifications(ns, now()), JSON: v}, nil
			},
		},
		Command{
			Name:         "notification.dismiss",
			Page:         PageState,
			NoPalette:    true,
			NoIndex:      true,
			Title:        "Notifications: Dismiss",
			Description:  "Dismiss a notification. Its source posting it again with the same content leaves it dismissed.",
			Category:     "Notifications",
			NoKeybinding: true,
			Args:         []ArgSpec{notificationIDArg},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				before, err := s.Get(a.String("id"))
				if err != nil {
					return Result{}, notificationErr(err, "id")
				}
				n, err := s.Dismiss(ctx, before.ID)
				if err != nil {
					return Result{}, notificationErr(err, "id")
				}
				msg := fmt.Sprintf("dismissed notification %s: %s", n.ID, n.Title)
				if before.State != notification.StateActive {
					msg = fmt.Sprintf("notification %s was %s already", n.ID, n.State)
				}
				return Result{Message: msg, JSON: notificationView(n)}, nil
			},
		},
		Command{
			Name:         "notification.snooze",
			Page:         PageState,
			NoPalette:    true,
			NoIndex:      true,
			Title:        "Notifications: Snooze",
			Description:  "Hide a notification until a time, when it comes back to the bell as if it had just arrived.",
			Category:     "Notifications",
			NoKeybinding: true,
			Args: []ArgSpec{notificationIDArg,
				{Name: "until", Type: String, Required: true, Description: "When it comes back: " + SnoozeUntilHelp}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				t := now()
				until, err := parseSnoozeUntil(a.String("until"), t, time.Local)
				if err != nil {
					return Result{}, InvalidArg("until", "%v", err)
				}
				n, err := s.Snooze(ctx, a.String("id"), until)
				if err != nil {
					return Result{}, notificationErr(err, "until")
				}
				return Result{Message: fmt.Sprintf("snoozed notification %s until %s", n.ID, formatSnoozeTime(n.SnoozedUntil, t, time.Local)),
					JSON: notificationView(n)}, nil
			},
		},
		notificationAct(r, s),
		Command{
			Name:         "notification.clear",
			NoIndex:      true,
			Page:         PageState,
			Title:        "Notifications: Clear All",
			Description:  "Dismiss every notification in the bell. Snoozed and scheduled ones stay.",
			Category:     "Notifications",
			NoKeybinding: true,
			Run: func(ctx context.Context, _ Context, _ Args) (Result, error) {
				n, err := s.Clear(ctx)
				if err != nil {
					return Result{}, notificationErr(err, "")
				}
				if n == 0 {
					return Result{Message: "no notifications to clear", JSON: NotificationClearView{}}, nil
				}
				return Result{Message: "dismissed " + plural(n, "notification"), JSON: NotificationClearView{Dismissed: n}}, nil
			},
		},
		Command{
			Name:         "notification.withdraw",
			NoIndex:      true,
			Page:         PageState,
			NoPalette:    true,
			Title:        "Notifications: Withdraw",
			Description:  "Take back a notification notification post put up with a key, once what it says no longer holds.",
			Category:     "Notifications",
			NoKeybinding: true,
			Args:         []ArgSpec{{Name: "key", Type: String, Required: true, Positional: true, Description: "The key it was posted with"}},
			Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
				n, err := s.Withdraw(ctx, notification.SourceCommand, strings.TrimSpace(a.String("key")))
				if err != nil {
					return Result{}, notificationErr(err, "key")
				}
				return Result{Message: fmt.Sprintf("withdrew notification %s: %s", n.ID, n.Title), JSON: notificationView(n)}, nil
			},
		},
	)
}

// postMessage is notification.post's text.
func postMessage(res notification.PostResult, now time.Time) string {
	n := res.Notification
	switch res.Outcome {
	case notification.OutcomePosted:
		return fmt.Sprintf("posted notification %s: %s", n.ID, n.Title)
	case notification.OutcomeScheduled:
		return fmt.Sprintf("scheduled notification %s for %s: %s", n.ID, formatSnoozeTime(n.ShowAt, now, time.Local), n.Title)
	case notification.OutcomeUpdated:
		return fmt.Sprintf("updated notification %s in place (%s): %s", n.ID, n.Status(), n.Title)
	}
	return fmt.Sprintf("unchanged: notification %s says this already (%s)", n.ID, n.Status())
}

// formatNotifications is notification.list's table.
func formatNotifications(ns []notification.Notification, now time.Time) string {
	if len(ns) == 0 {
		return "no notifications"
	}
	var b strings.Builder
	tw := tabwriter.NewWriter(&b, 0, 4, 2, ' ', 0)
	_, _ = fmt.Fprintln(tw, "ID\tSTATUS\tLEVEL\tSOURCE\tTITLE\tACTIONS")
	for _, n := range ns {
		status := string(n.Status())
		switch n.Status() {
		case notification.StatusSnoozed:
			status += " until " + formatSnoozeTime(n.SnoozedUntil, now, time.Local)
		case notification.StatusScheduled:
			status += " for " + formatSnoozeTime(n.ShowAt, now, time.Local)
		}
		level := string(n.Level)
		if n.TimeSensitive {
			level += " (time-sensitive)"
		}
		var labels []string
		for i, a := range n.Actions {
			labels = append(labels, fmt.Sprintf("%d %s", i+1, a.Label))
		}
		_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", n.ID, status, level, n.Source, n.Title, strings.Join(labels, ", "))
	}
	_ = tw.Flush()
	return strings.TrimRight(b.String(), "\n")
}

// notificationErr maps the store's errors: a bad argument to an argument error on arg
// (a connect InvalidArgument without one), an unknown notification or thread to NotFound,
// a closed or not yet shown one and a full source to the command's own failure.
func notificationErr(err error, arg string) error {
	switch {
	case connect.CodeOf(err) != connect.CodeUnknown:
		return err
	case errors.Is(err, notification.ErrInvalidArgument) && arg != "":
		return InvalidArg(arg, "%s", strings.TrimPrefix(err.Error(), notification.ErrInvalidArgument.Error()+": "))
	case errors.Is(err, notification.ErrInvalidArgument):
		return connect.NewError(connect.CodeInvalidArgument, err)
	case errors.Is(err, notification.ErrNotFound):
		return connect.NewError(connect.CodeNotFound, err)
	}
	return Failed(err)
}

type noNotifications struct{}

var errNoNotifications = connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no notifications"))

func (noNotifications) Snapshot() *notification.Snapshot      { return &notification.Snapshot{} }
func (noNotifications) List(bool) []notification.Notification { return nil }
func (noNotifications) Get(string) (notification.Notification, error) {
	return notification.Notification{}, errNoNotifications
}
func (noNotifications) Post(context.Context, notification.Post) (notification.PostResult, error) {
	return notification.PostResult{}, errNoNotifications
}
func (noNotifications) Withdraw(context.Context, string, string) (notification.Notification, error) {
	return notification.Notification{}, errNoNotifications
}
func (noNotifications) Dismiss(context.Context, string) (notification.Notification, error) {
	return notification.Notification{}, errNoNotifications
}
func (noNotifications) Snooze(context.Context, string, time.Time) (notification.Notification, error) {
	return notification.Notification{}, errNoNotifications
}
func (noNotifications) Clear(context.Context) (int, error) { return 0, errNoNotifications }
func (noNotifications) Act(context.Context, string, int, func(context.Context, notification.Notification, notification.Action) error) (notification.Notification, notification.Action, error) {
	return notification.Notification{}, notification.Action{}, errNoNotifications
}
func (noNotifications) ThreadGone(context.Context, string) (int, error) { return 0, errNoNotifications }
