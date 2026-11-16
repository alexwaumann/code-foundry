package pluginsdk

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Notifications (permission notifications): a plugin posts a notification to the bell
// in the app's top bar, and withdraws it by its key when what it reported is over. The
// host keeps one notification per plugin and key:
//
//   - the same key with the same content is dropped (no new card, no toast);
//   - the same key with changed content updates the card in place (no new toast);
//   - a key the user dismissed stays dismissed while its content is unchanged, and
//     comes back only when the content changes;
//   - no key: the host derives one from the title, body and thread.
//
// The host raises the arrival toast itself: a plugin never toasts for a notification.
//
// An event a thread may be waiting for is reported once, with the notification attached
// to the wake fire (FireWakeNotify): the host delivers the wake, then raises a normal
// notification only when no subscribed thread got the wake; a time-sensitive one is
// raised either way.

const (
	// MethodNotificationPost (plugin → host request): Notification → NotifyResult.
	MethodNotificationPost = "notification/post"
	// MethodNotificationWithdraw (plugin → host request): NotificationWithdraw →
	// NotificationWithdrawResult.
	MethodNotificationWithdraw = "notification/withdraw"
)

// NotificationsCapability is announced by a host that serves notification/post,
// notification/withdraw and a notification attached to wake/fire. An older host ignores
// an attached notification, so FireWakeNotify refuses to fire without it.
const NotificationsCapability = "notifications"

// Notification levels. There is no success level.
const (
	NotifyInfo    = "info"
	NotifyWarning = "warning"
	NotifyError   = "error"
)

// Notification action kinds.
const (
	// ActionCommand runs one of this plugin's manifest commands with Args, as the palette
	// would (its confirm, if any, asks the user first).
	ActionCommand = "command"
	// ActionSend sends Text to the thread ThreadID.
	ActionSend = "send"
	// ActionStart starts a thread with Prompt, in ProjectID or without a project.
	ActionStart = "start"
	// ActionOpen opens URL (http or https) in the browser.
	ActionOpen = "open"
)

// Notification limits (characters), as the host enforces them.
const (
	MaxNotificationKey     = 200
	MaxNotificationTitle   = 120
	MaxNotificationBody    = 1000
	MaxNotificationActions = 3
	MaxActionLabel         = 32
)

// Notification is notification/post's params, and the notification attached to a wake
// fire (WakeFire.Notification).
type Notification struct {
	// Key identifies it among this plugin's notifications (at most 200 characters, not
	// starting with "auto:"); "" lets the host derive one from title, body and thread.
	Key string `json:"key,omitempty"`
	// Level is NotifyInfo (default), NotifyWarning or NotifyError.
	Level string `json:"level,omitempty"`
	// TimeSensitive sorts it first, tints it, bounces the Dock icon and counts it in the
	// Dock badge. Separate from Level: keep it for what cannot wait.
	TimeSensitive bool `json:"timeSensitive,omitempty"`
	// Title is required: one short line (at most 120 characters).
	Title string `json:"title"`
	// Body is optional detail (at most 1000 characters).
	Body string `json:"body,omitempty"`
	// ThreadID names the thread it is about (it must exist); the card links to it.
	ThreadID string `json:"threadId,omitempty"`
	// ShowAt keeps it out of the bell until then (the host holds the timer).
	ShowAt time.Time `json:"showAt,omitzero"`
	// Actions are at most three buttons, the primary first. Dismiss and Snooze are the
	// host's, on every card: never add them.
	Actions []NotificationAction `json:"actions,omitempty"`
}

// NotificationAction is a button on a notification. Only the fields of its Kind are set.
type NotificationAction struct {
	// Label is the button's text (at most 32 characters).
	Label string `json:"label"`
	// Kind is ActionCommand, ActionSend, ActionStart or ActionOpen.
	Kind string `json:"kind"`
	// ActionCommand: one of this plugin's manifest command names, and its args (names
	// the command declares).
	Command string            `json:"command,omitempty"`
	Args    map[string]string `json:"args,omitempty"`
	// ActionSend: the thread and the text.
	ThreadID string `json:"threadId,omitempty"`
	Text     string `json:"text,omitempty"`
	// ActionStart: the first prompt, and the project ("" for a thread without one).
	Prompt    string `json:"prompt,omitempty"`
	ProjectID string `json:"projectId,omitempty"`
	// ActionOpen: the URL.
	URL string `json:"url,omitempty"`
	// Resolves says whether pressing it closes the notification. Nil takes the kind's
	// default: true for command, send and start, false for open.
	Resolves *bool `json:"resolves,omitempty"`
}

// CommandAction is an ActionCommand button running command with args.
func CommandAction(label, command string, args map[string]string) NotificationAction {
	return NotificationAction{Label: label, Kind: ActionCommand, Command: command, Args: args}
}

// SendAction is an ActionSend button sending text to a thread.
func SendAction(label, threadID, text string) NotificationAction {
	return NotificationAction{Label: label, Kind: ActionSend, ThreadID: threadID, Text: text}
}

// StartAction is an ActionStart button starting a thread with prompt in project ("" for
// none).
func StartAction(label, prompt, projectID string) NotificationAction {
	return NotificationAction{Label: label, Kind: ActionStart, Prompt: prompt, ProjectID: projectID}
}

// OpenAction is an ActionOpen button opening url.
func OpenAction(label, url string) NotificationAction {
	return NotificationAction{Label: label, Kind: ActionOpen, URL: url}
}

// What a post did (NotifyResult.Outcome).
const (
	// NotifyPosted: it arrived in the bell (the host toasts it).
	NotifyPosted = "posted"
	// NotifyScheduled: it waits for its ShowAt.
	NotifyScheduled = "scheduled"
	// NotifyUpdated: the key's notification took the new content in place, no toast.
	NotifyUpdated = "updated"
	// NotifyUnchanged: the key has this content already (Status says whether it is
	// shown, snoozed, scheduled, or the user dismissed or resolved it): nothing changed.
	NotifyUnchanged = "unchanged"
	// NotifyRouted: the notification was attached to a wake fire that a subscribed
	// thread got, so it was not raised (a normal one only; WakeFireResult).
	NotifyRouted = "routed"
)

// NotifyResult is what a post did.
type NotifyResult struct {
	// ID is the notification's id ("n-…"); empty when Outcome is NotifyRouted.
	ID string `json:"id,omitempty"`
	// Key is the notification's key (the derived one when the post gave none).
	Key string `json:"key,omitempty"`
	// Outcome is NotifyPosted, NotifyScheduled, NotifyUpdated, NotifyUnchanged or
	// NotifyRouted.
	Outcome string `json:"outcome"`
	// Status is the notification as the bell has it after the post: shown, snoozed,
	// scheduled, dismissed or resolved. Empty when routed.
	Status string `json:"status,omitempty"`
}

// NotificationWithdraw is notification/withdraw's params.
type NotificationWithdraw struct {
	Key string `json:"key"`
}

// NotificationWithdrawResult is notification/withdraw's answer: whether an active
// notification went (false when the key has none, or the user already closed it).
type NotificationWithdrawResult struct {
	Withdrawn bool `json:"withdrawn"`
}

// Notify posts a notification to the bell (permission notifications) and says what the
// host did with it (the key rules above). For an event a thread may be waiting on, use
// FireWakeNotify instead.
func (h *Host) Notify(ctx context.Context, n Notification) (NotifyResult, error) {
	var res NotifyResult
	err := h.conn.Call(ctx, MethodNotificationPost, n, &res)
	return res, err
}

// WithdrawNotification withdraws the plugin's notification with key (what it reported is
// over) and reports whether an active one went. A key with none is not an error.
func (h *Host) WithdrawNotification(ctx context.Context, key string) (bool, error) {
	var res NotificationWithdrawResult
	err := h.conn.Call(ctx, MethodNotificationWithdraw, NotificationWithdraw{Key: key}, &res)
	return res.Withdrawn, err
}

// ErrNoNotifications is FireWakeNotify's refusal on a host without
// NotificationsCapability, which would fire the wake and drop the notification.
var ErrNoNotifications = errors.New("pluginsdk: the host does not take notifications (no " + NotificationsCapability + " capability)")

// FireWakeNotify fires a wake source as FireWake does, with a notification attached
// (permission notifications): the host delivers the wake, then raises the notification
// only when no subscribed thread got the wake, unless it is time-sensitive, which is
// raised either way. The result's Notification says which happened (NotifyRouted when a
// thread took it). Report an event this way, once: a separate Notify for an event that
// also wakes a thread puts it in front of the user twice.
func (h *Host) FireWakeNotify(ctx context.Context, source string, match map[string]string, title string, payload any, n Notification) (WakeFireResult, error) {
	if !h.HasCapability(NotificationsCapability) {
		return WakeFireResult{}, ErrNoNotifications
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return WakeFireResult{}, fmt.Errorf("pluginsdk: encode wake payload: %w", err)
	}
	if len(raw) > MaxWakePayload {
		return WakeFireResult{}, fmt.Errorf("pluginsdk: wake payload of %d bytes (at most %d)", len(raw), MaxWakePayload)
	}
	var res WakeFireResult
	err = h.conn.Call(ctx, MethodWakeFire, WakeFire{Source: source, Match: match, Title: title, Payload: raw, Notification: &n}, &res)
	return res, err
}
