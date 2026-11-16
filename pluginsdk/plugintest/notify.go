package plugintest

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Notifications (pluginsdk/notify.go): the fake keeps the plugin's notifications by key
// with the host's key rules (the same content is unchanged, changed content updates in
// place, a dismissed key stays dismissed until its content changes, a withdrawn key
// comes back with any post) and refuses what the host would: no permissions.notifications,
// a bad level or title, more than three actions, and with Options.Commands a command
// action naming another command or an arg it does not declare. A notification attached
// to wake/fire is routed as the host routes it: a normal one is raised only when the fire
// reached no subscription (SubscribeWake), a time-sensitive one always. The test reads
// what the plugin posted (Notifications, Notification, ActiveNotifications) and withdrew
// (NotificationWithdrawals), and acts as the user would (DismissNotification,
// PressAction).

func init() { HostCapabilities = append(HostCapabilities, pluginsdk.NotificationsCapability) }

// Notification statuses as the fake reports them (NotifyResult.Status).
const (
	StatusShown     = "shown"
	StatusScheduled = "scheduled"
	StatusDismissed = "dismissed"
	StatusResolved  = "resolved"
	StatusWithdrawn = "withdrawn"
)

// PostedNotification is one post the plugin made: by notification/post, or attached to a
// wake fire (Fire true), with what the fake did with it (Err set when it was refused).
type PostedNotification struct {
	Notification pluginsdk.Notification
	Fire         bool
	Result       pluginsdk.NotifyResult
	Err          error
}

// PressedAction is an action PressAction pressed that the fake cannot run itself (send,
// start, open): the test checks it was the right one.
type PressedAction struct {
	Key    string
	Action pluginsdk.NotificationAction
}

// noteState is the fake's notifications. Guarded by Host.mu.
type noteState struct {
	next      int
	posts     []PostedNotification
	withdrawn []string
	pressed   []PressedAction
	byKey     map[string]*noteRec
}

type noteRec struct {
	id     string
	n      pluginsdk.Notification
	status string
}

func (r *noteRec) active() bool { return r.status == StatusShown || r.status == StatusScheduled }

// Notifications returns every post the plugin made, refused ones too, in order.
func (h *Host) Notifications() []PostedNotification {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.notes.posts)
}

// Notification returns the plugin's notification with key as the bell has it now, and
// its status (StatusShown, StatusScheduled, StatusDismissed, StatusResolved or
// StatusWithdrawn).
func (h *Host) Notification(key string) (pluginsdk.Notification, string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	r, ok := h.notes.byKey[key]
	if !ok {
		return pluginsdk.Notification{}, "", false
	}
	return r.n, r.status, true
}

// ActiveNotifications returns the plugin's shown and scheduled notifications, by key.
func (h *Host) ActiveNotifications() []pluginsdk.Notification {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []pluginsdk.Notification
	for _, k := range slices.Sorted(maps.Keys(h.notes.byKey)) {
		if r := h.notes.byKey[k]; r.active() {
			out = append(out, r.n)
		}
	}
	return out
}

// NotificationWithdrawals returns the keys of the plugin's notification/withdraw calls.
func (h *Host) NotificationWithdrawals() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.notes.withdrawn)
}

// PressedActions returns the send, start and open actions PressAction pressed.
func (h *Host) PressedActions() []PressedAction {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.notes.pressed)
}

// DismissNotification dismisses the notification with key, as the user would: a post of
// the same content stays dismissed.
func (h *Host) DismissNotification(key string) error {
	var err error
	h.record(func() {
		r, ok := h.notes.byKey[key]
		switch {
		case !ok:
			err = fmt.Errorf("plugintest: no notification with key %q", key)
		case !r.active():
			err = fmt.Errorf("plugintest: notification %q is %s", key, r.status)
		default:
			r.status = StatusDismissed
		}
	})
	return err
}

// PressAction presses action index (0, the primary) of the active notification with
// key, as the user would. A command action runs the plugin's command with its args and
// no context (command/invoke), as notification.act does; a send, start or open action is
// recorded (PressedActions). A pressed action that resolves (Resolves, else true for
// command, send and start) resolves the notification once it ran.
func (h *Host) PressAction(ctx context.Context, key string, index int) (pluginsdk.CommandResult, error) {
	h.mu.Lock()
	r, ok := h.notes.byKey[key]
	var n pluginsdk.Notification
	if ok {
		n = r.n
	}
	active := ok && r.active()
	h.mu.Unlock()
	switch {
	case !ok:
		return pluginsdk.CommandResult{}, fmt.Errorf("plugintest: no notification with key %q", key)
	case !active:
		return pluginsdk.CommandResult{}, fmt.Errorf("plugintest: notification %q is not active", key)
	case index < 0 || index >= len(n.Actions):
		return pluginsdk.CommandResult{}, fmt.Errorf("plugintest: notification %q has %d actions; no action %d", key, len(n.Actions), index)
	}
	a := n.Actions[index]
	var res pluginsdk.CommandResult
	if a.Kind == pluginsdk.ActionCommand {
		var err error
		if res, err = h.Command(ctx, a.Command, a.Args, pluginsdk.UiContext{}); err != nil {
			return res, err
		}
	} else {
		h.record(func() { h.notes.pressed = append(h.notes.pressed, PressedAction{Key: key, Action: a}) })
	}
	resolves := a.Kind != pluginsdk.ActionOpen
	if a.Resolves != nil {
		resolves = *a.Resolves
	}
	if resolves {
		h.record(func() {
			// Resolve what was pressed, not content the plugin posted meanwhile.
			if cur := h.notes.byKey[key]; cur != nil && cur.active() && sameNote(cur.n, n) {
				cur.status = StatusResolved
			}
		})
	}
	return res, nil
}

func (h *Host) handleNotifications(_ context.Context, method string, params json.RawMessage) (any, bool, error) {
	switch method {
	case pluginsdk.MethodNotificationPost:
		if !h.opts.Granted.Notifications {
			return nil, true, denied("notifications")
		}
		n, err := decode[pluginsdk.Notification](params)
		if err != nil {
			return nil, true, err
		}
		res, err := h.postNote(n, false)
		return res, true, err
	case pluginsdk.MethodNotificationWithdraw:
		if !h.opts.Granted.Notifications {
			return nil, true, denied("notifications")
		}
		p, err := decode[pluginsdk.NotificationWithdraw](params)
		if err != nil {
			return nil, true, err
		}
		if strings.TrimSpace(p.Key) == "" {
			return nil, true, pluginsdk.NewError(pluginsdk.CodeInvalidParams, "notification/withdraw: key is required")
		}
		var gone bool
		h.record(func() {
			h.notes.withdrawn = append(h.notes.withdrawn, p.Key)
			if r := h.notes.byKey[p.Key]; r != nil && r.active() {
				r.status, gone = StatusWithdrawn, true
			}
		})
		return pluginsdk.NotificationWithdrawResult{Withdrawn: gone}, true, nil
	}
	return nil, false, nil
}

// checkFireNote refuses a fire's notification the host would, before the wake goes.
func (h *Host) checkFireNote(n *pluginsdk.Notification) error {
	if n == nil {
		return nil
	}
	if !h.opts.Granted.Notifications {
		return denied("notifications (a notification on wake/fire)")
	}
	return h.checkNote(pluginsdk.MethodWakeFire, *n)
}

// routeFireNote routes a fire's notification after the fire reached delivered
// subscriptions.
func (h *Host) routeFireNote(n *pluginsdk.Notification, delivered int) *pluginsdk.NotifyResult {
	if n == nil {
		return nil
	}
	if delivered > 0 && !n.TimeSensitive {
		res := pluginsdk.NotifyResult{Key: strings.TrimSpace(n.Key), Outcome: pluginsdk.NotifyRouted}
		h.record(func() {
			h.notes.posts = append(h.notes.posts, PostedNotification{Notification: *n, Fire: true, Result: res})
		})
		return &res
	}
	res, _ := h.postNote(*n, true) // checked before the fire
	return &res
}

// postNote applies the key rules to n.
func (h *Host) postNote(n pluginsdk.Notification, fire bool) (pluginsdk.NotifyResult, error) {
	if err := h.checkNote(pluginsdk.MethodNotificationPost, n); err != nil {
		h.record(func() {
			h.notes.posts = append(h.notes.posts, PostedNotification{Notification: n, Fire: fire, Err: err})
		})
		return pluginsdk.NotifyResult{}, err
	}
	key := strings.TrimSpace(n.Key)
	if key == "" {
		sum := sha256.Sum256([]byte(n.Title + "\x00" + n.Body + "\x00" + n.ThreadID))
		key = "auto:" + hex.EncodeToString(sum[:8])
	}
	n.Key = key
	due := n.ShowAt.IsZero() || !n.ShowAt.After(time.Now())
	arrive := StatusShown
	if !due {
		arrive = StatusScheduled
	}
	var res pluginsdk.NotifyResult
	h.record(func() {
		if h.notes.byKey == nil {
			h.notes.byKey = map[string]*noteRec{}
		}
		r, ok := h.notes.byKey[key]
		switch {
		case !ok:
			h.notes.next++
			r = &noteRec{id: fmt.Sprintf("n-%012d", h.notes.next), n: n, status: arrive}
			h.notes.byKey[key] = r
			res.Outcome = outcomeOf(arrive)
		case sameNote(r.n, n) && r.status != StatusWithdrawn:
			res.Outcome = pluginsdk.NotifyUnchanged
		case r.active():
			r.n = n
			res.Outcome = pluginsdk.NotifyUpdated
			if !due {
				r.status, res.Outcome = StatusScheduled, pluginsdk.NotifyScheduled
			}
		default: // closed: back as a new arrival
			r.n, r.status = n, arrive
			res.Outcome = outcomeOf(arrive)
		}
		res.ID, res.Key, res.Status = r.id, key, r.status
		h.notes.posts = append(h.notes.posts, PostedNotification{Notification: n, Fire: fire, Result: res})
	})
	return res, nil
}

func outcomeOf(status string) string {
	if status == StatusScheduled {
		return pluginsdk.NotifyScheduled
	}
	return pluginsdk.NotifyPosted
}

// sameNote reports whether a and b say the same thing (everything but the key).
func sameNote(a, b pluginsdk.Notification) bool {
	a.Key, b.Key = "", ""
	ja, _ := json.Marshal(a)
	jb, _ := json.Marshal(b)
	return string(ja) == string(jb)
}

// checkNote refuses n as the host would.
func (h *Host) checkNote(method string, n pluginsdk.Notification) error {
	invalid := func(format string, a ...any) error {
		return pluginsdk.NewError(pluginsdk.CodeInvalidParams, method+": "+format, a...)
	}
	title := strings.TrimSpace(n.Title)
	switch {
	case title == "" || strings.ContainsAny(title, "\r\n"):
		return invalid("a notification needs a one-line title")
	case utf8.RuneCountInString(title) > pluginsdk.MaxNotificationTitle:
		return invalid("title longer than %d characters", pluginsdk.MaxNotificationTitle)
	case utf8.RuneCountInString(n.Body) > pluginsdk.MaxNotificationBody:
		return invalid("body longer than %d characters", pluginsdk.MaxNotificationBody)
	case !slices.Contains([]string{"", pluginsdk.NotifyInfo, pluginsdk.NotifyWarning, pluginsdk.NotifyError}, n.Level):
		return invalid("level %q is not one of info, warning, error", n.Level)
	case utf8.RuneCountInString(n.Key) > pluginsdk.MaxNotificationKey:
		return invalid("key longer than %d characters", pluginsdk.MaxNotificationKey)
	case strings.HasPrefix(strings.TrimSpace(n.Key), "auto:"):
		return invalid("keys starting with auto: are the host's")
	case len(n.Actions) > pluginsdk.MaxNotificationActions:
		return invalid("%d actions; at most %d", len(n.Actions), pluginsdk.MaxNotificationActions)
	}
	for i, a := range n.Actions {
		label := strings.TrimSpace(a.Label)
		switch {
		case label == "" || utf8.RuneCountInString(label) > pluginsdk.MaxActionLabel:
			return invalid("action %d: a label of 1 to %d characters", i+1, pluginsdk.MaxActionLabel)
		case a.Kind == pluginsdk.ActionCommand:
			if err := h.checkCommandAction(a); err != nil {
				return invalid("action %d: %v", i+1, err)
			}
		case a.Kind == pluginsdk.ActionSend && (a.ThreadID == "" || strings.TrimSpace(a.Text) == ""):
			return invalid("action %d: a send action needs a thread and text", i+1)
		case a.Kind == pluginsdk.ActionStart && strings.TrimSpace(a.Prompt) == "":
			return invalid("action %d: a start action needs a prompt", i+1)
		case a.Kind == pluginsdk.ActionOpen && !strings.HasPrefix(a.URL, "https://") && !strings.HasPrefix(a.URL, "http://"):
			return invalid("action %d: url %q must be http or https", i+1, a.URL)
		case !slices.Contains([]string{pluginsdk.ActionCommand, pluginsdk.ActionSend, pluginsdk.ActionStart, pluginsdk.ActionOpen}, a.Kind):
			return invalid("action %d: kind %q is not one of command, send, start, open", i+1, a.Kind)
		}
	}
	return nil
}

// checkCommandAction refuses a command action naming a command or an arg Options.Commands
// does not declare (nil accepts any named command).
func (h *Host) checkCommandAction(a pluginsdk.NotificationAction) error {
	if a.Command == "" {
		return fmt.Errorf("a command action names one of the plugin's commands")
	}
	if h.opts.Commands == nil {
		return nil
	}
	i := slices.IndexFunc(h.opts.Commands, func(c pluginsdk.CommandSpec) bool { return c.Name == a.Command })
	if i < 0 {
		return fmt.Errorf("%q is not one of the commands in plugin.json", a.Command)
	}
	for k := range a.Args {
		if !slices.ContainsFunc(h.opts.Commands[i].Args, func(s pluginsdk.ArgSpec) bool { return s.Name == k }) {
			return fmt.Errorf("%s does not declare an arg %q", a.Command, k)
		}
	}
	return nil
}
