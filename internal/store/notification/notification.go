// Package notification is the notification store: what plugins and the notification.post
// command put in the bell (docs/notes/notifications-1-store.md). A notification is one
// per source and key; the store applies the key rules (a re-post with the same content is
// dropped, a changed one updates in place, a dismissed key stays dismissed until its
// content changes), holds show_at and snooze on the wall clock, and records what the
// user did with each (dismissed, acted on) or what the source did (withdrew it).
//
// It persists notifications in SQLite, publishes an immutable Snapshot behind an atomic
// pointer and a Changed event per change on the bus. Changed says which notifications
// arrived (were shown for the first time, reached their show_at or came back from a
// snooze) apart from those that were only updated, since only an arrival toasts. The
// store never looks at threads: the daemon tells it which exist (Options.ThreadExists)
// and when one is removed (ThreadGone). Running an action is the caller's: Act hands it
// the action and marks the notification resolved once it ran.
package notification

import (
	"context"
	"errors"
	"time"
)

// Errors returned by Store methods. They are wrapped with detail; test with errors.Is.
var (
	ErrNotFound           = errors.New("not found")
	ErrInvalidArgument    = errors.New("invalid argument")
	ErrFailedPrecondition = errors.New("failed precondition")
	// ErrFull refuses a post past MaxActivePerSource.
	ErrFull = errors.New("too many notifications")
)

// SourceCommand is the source of a notification posted with the notification.post
// command (the CLI, a page, the palette). A plugin's source is its name.
const SourceCommand = "command"

// SourcePlugins is the source of the daemon's own notifications about plugins that stopped
// (one per plugin, keyed by its name; docs/notes/notifications-plugin-health.md). Its
// command actions name a registry verb itself (plugin.restart, view.settings), not a
// plugin's manifest command.
const SourcePlugins = "plugins"

// SourceGitHub is the source of the daemon's own notifications from the GitHub poll (one
// per pull request and kind; docs/notes/notifications-github.md). Like SourcePlugins, its
// command actions name a registry verb itself (Open PR is view.open.pr).
const SourceGitHub = "github"

// SourceApp is the source of the daemon's own notices about the app itself (shown as
// "Code Foundry"): the one-time notice that a default changed
// (docs/notes/threads-open-as-3-default.md). Like SourcePlugins, its command actions name a
// registry verb itself (Open settings is view.settings --setting).
const SourceApp = "app"

// Level is how serious a notification is. There is no success level.
type Level string

const (
	LevelInfo    Level = "info"
	LevelWarning Level = "warning"
	LevelError   Level = "error"
)

// Levels lists the levels, least serious first.
var Levels = []Level{LevelInfo, LevelWarning, LevelError}

// State is what became of a notification. Snoozed and scheduled ones are active: Status
// tells them apart.
type State string

const (
	// StateActive: in the bell, snoozed, or waiting for its show_at.
	StateActive State = "active"
	// StateDismissed: the user dismissed it (or cleared the bell). A re-post with the
	// same content stays dismissed.
	StateDismissed State = "dismissed"
	// StateWithdrawn: its source withdrew it, or the thread it names was removed.
	StateWithdrawn State = "withdrawn"
	// StateResolved: the user ran an action that resolves it. A re-post with the same
	// content stays resolved.
	StateResolved State = "resolved"
)

// Status is a notification's state as a list shows it: an active one is shown, snoozed
// or scheduled.
type Status string

const (
	StatusShown     Status = "shown"
	StatusSnoozed   Status = "snoozed"
	StatusScheduled Status = "scheduled"
	StatusDismissed Status = "dismissed"
	StatusWithdrawn Status = "withdrawn"
	StatusResolved  Status = "resolved"
)

// ActionKind is what an action does when the user presses it.
type ActionKind string

const (
	// KindCommand runs one of the source plugin's manifest commands with args
	// (plugin.<source>.<command>); from SourcePlugins and SourceGitHub, the registry verb it names. Not for
	// SourceCommand.
	KindCommand ActionKind = "command"
	// KindSend sends text to a thread.
	KindSend ActionKind = "send"
	// KindStart starts a thread with a prompt, in a project or none.
	KindStart ActionKind = "start"
	// KindOpen opens an http(s) URL in the browser.
	KindOpen ActionKind = "open"
)

// Action is a button on a notification. The first is the primary. Only the fields of
// its Kind are set.
type Action struct {
	Label string     `json:"label"`
	Kind  ActionKind `json:"kind"`
	// KindCommand: the plugin's manifest command name and its args.
	Command string            `json:"command,omitempty"`
	Args    map[string]string `json:"args,omitempty"`
	// KindSend: the thread and the text.
	ThreadID string `json:"thread_id,omitempty"`
	Text     string `json:"text,omitempty"`
	// KindStart: the first prompt and the project (empty: a thread without a project).
	Prompt    string `json:"prompt,omitempty"`
	ProjectID string `json:"project_id,omitempty"`
	// KindOpen: the URL.
	URL string `json:"url,omitempty"`
	// Resolves: running it resolves the notification. ActionSpec defaults it.
	Resolves bool `json:"resolves"`
}

// ActionSpec is an action as a source posts it: Resolves nil takes the kind's default
// (true for command, send and start; false for open).
type ActionSpec struct {
	Action
	Resolves *bool
}

// Notification is an immutable snapshot of one notification.
type Notification struct {
	ID string // "n-" + 12 hex digits
	// Source is the plugin that posted it, SourceCommand or SourcePlugins.
	Source string
	// Key is the source's key, or one derived from the title, body and thread
	// (DerivedKey) when it gave none.
	Key           string
	Level         Level
	TimeSensitive bool
	Title         string
	Body          string
	// ThreadID is the thread it is about, "" for none.
	ThreadID string
	// Actions are its buttons, the primary first. Copy on write.
	Actions []Action
	// ShowAt is when the source asked it to be shown; zero for at once.
	ShowAt time.Time
	State  State
	// CreatedAt is the first post of the key; UpdatedAt the last change of any kind.
	CreatedAt time.Time
	UpdatedAt time.Time
	// ArrivedAt is when it was last shown (its first post, its show_at, the end of a
	// snooze); zero while it waits for its show_at.
	ArrivedAt time.Time
	// SnoozedUntil is when a snoozed one comes back; zero when it is not snoozed.
	SnoozedUntil time.Time
	// Seen: the user has seen it since it last arrived (the bell's panel showed it, or they
	// acted on it). Every arrival makes it unseen; an in-place update does not. The bell's
	// corner badge shows while a shown one is unseen (docs/notes/notification-seen.md).
	Seen bool
}

// Status says how a list shows n.
func (n Notification) Status() Status {
	switch {
	case n.State == StateDismissed:
		return StatusDismissed
	case n.State == StateWithdrawn:
		return StatusWithdrawn
	case n.State == StateResolved:
		return StatusResolved
	case !n.SnoozedUntil.IsZero():
		return StatusSnoozed
	case n.ArrivedAt.IsZero():
		return StatusScheduled
	}
	return StatusShown
}

// Shown reports whether n is in the bell: active, arrived and not snoozed.
func (n Notification) Shown() bool { return n.Status() == StatusShown }

// Snapshot is every active notification: the shown ones first (time-sensitive first,
// then the newest arrival first), then the snoozed and scheduled ones by when they come
// back. Never mutate it.
type Snapshot struct {
	Notifications []Notification
	// TimeSensitive counts the shown time-sensitive notifications: the dock badge's share.
	TimeSensitive int
	// Unseen counts the shown notifications the user has not seen: the bell's badge.
	Unseen int
	// Version grows by one per change in this daemon's lifetime.
	Version uint64
}

// Notification returns the active notification with id.
func (s *Snapshot) Notification(id string) (Notification, bool) {
	if s == nil {
		return Notification{}, false
	}
	for _, n := range s.Notifications {
		if n.ID == id {
			return n, true
		}
	}
	return Notification{}, false
}

// Event is published on the bus as bus.Publish[notification.Event]. The store publishes
// Changed; *Snapshot also implements Event so a consumer can merge a resync into the same
// stream.
type Event interface{ isNotificationEvent() }

// Changed carries the snapshot after a change, and which notifications arrived or were
// updated by it. Arrived: shown now and not shown before (a first post, a show_at
// reached, a snooze ended, a dismissed key whose content changed): what a toast is for.
// Updated: shown before and after, with new content: no toast. A notification leaving the
// bell is only missing from the snapshot.
type Changed struct {
	Snapshot *Snapshot
	Arrived  []string
	Updated  []string
}

func (Changed) isNotificationEvent()   {}
func (*Snapshot) isNotificationEvent() {}

// Post is a notification as a source posts it.
type Post struct {
	// Source is the plugin's name, SourceCommand or SourcePlugins. Required.
	Source string
	// Key identifies the notification within its source; "" derives one (DerivedKey).
	Key   string
	Level Level // "": LevelInfo
	// TimeSensitive sorts it first, tints it and counts it in the dock badge.
	TimeSensitive bool
	// Title is required, one line, at most MaxTitle characters.
	Title string
	// Body is optional, at most MaxBody characters.
	Body string
	// ThreadID, when set, must name a thread that exists.
	ThreadID string
	// Actions are at most MaxActions buttons, the primary first.
	Actions []ActionSpec
	// ShowAt, when after now, keeps it out of the bell until then.
	ShowAt time.Time
}

// Outcome is what a post did.
type Outcome string

const (
	// OutcomePosted: it arrived (shown now).
	OutcomePosted Outcome = "posted"
	// OutcomeScheduled: it waits for its show_at.
	OutcomeScheduled Outcome = "scheduled"
	// OutcomeUpdated: the key's notification took the new content in place, without
	// arriving again (shown, snoozed or still scheduled).
	OutcomeUpdated Outcome = "updated"
	// OutcomeUnchanged: the key has this content already (shown, snoozed, scheduled,
	// dismissed or resolved): nothing changed.
	OutcomeUnchanged Outcome = "unchanged"
)

// PostResult is a post's notification after it, and what the post did.
type PostResult struct {
	Notification Notification
	Outcome      Outcome
}

// Store is the notification store API. *Manager implements it.
type Store interface {
	// Snapshot returns the current immutable snapshot. It never returns nil.
	Snapshot() *Snapshot
	// List returns the active notifications as Snapshot orders them, and with closed
	// the dismissed, withdrawn and resolved ones kept, newest change first, after them.
	List(closed bool) []Notification
	// Get returns a notification by id, whatever its state.
	Get(id string) (Notification, error)
	// Post applies the key rules (see Outcome).
	Post(ctx context.Context, p Post) (PostResult, error)
	// Withdraw withdraws source's notification with key. ErrNotFound when source has
	// none with that key; one already closed is returned as it is.
	Withdraw(ctx context.Context, source, key string) (Notification, error)
	// Dismiss dismisses an active notification; one already closed is returned as it is.
	Dismiss(ctx context.Context, id string) (Notification, error)
	// Snooze hides a shown or snoozed notification until until (after now), when it
	// arrives again.
	Snooze(ctx context.Context, id string, until time.Time) (Notification, error)
	// Clear dismisses every shown notification and returns how many. Snoozed and
	// scheduled ones stay.
	Clear(ctx context.Context) (int, error)
	// Act runs the action at index (0 is the primary) of an active notification through
	// run (marking it seen first: the user acted on it), and when run succeeds and the action resolves the notification, marks it
	// resolved. run is called without the store's lock.
	Act(ctx context.Context, id string, index int, run func(context.Context, Notification, Action) error) (Notification, Action, error)
	// ThreadGone withdraws every active notification naming thread id (the thread was
	// removed) and returns how many.
	ThreadGone(ctx context.Context, id string) (int, error)
	// See marks notifications seen and returns how many were unseen: with id "" every
	// shown one (the bell's panel opened), else that one (ErrNotFound when there is none).
	See(ctx context.Context, id string) (int, error)
}
