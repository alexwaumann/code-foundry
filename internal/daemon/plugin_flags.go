package daemon

//lint:file-ignore SA1019 the host serves the deprecated thread/setFlag (pluginsdk/removals.go)

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
	"github.com/alexwaumann/code-foundry/pluginsdk"
)

// Plugins' thread flags as notifications (docs/notes/plugin-flag-retirement.md):
// thread/setFlag keeps its shape and permission, and the daemon posts a notification
// naming the thread under the plugin's source with the key notification.FlagKey (one per
// plugin and thread, the until-seen mode in the key), warning for attention and error for
// error, the reason its title. The thread no longer carries flags.
//
//   - none withdraws it;
//   - until seen: withdrawn when the user sees the thread (the thread store's seen hook,
//     the moment it cleared such a flag before), and never shown when the thread is seen
//     as it is raised;
//   - archiving the thread withdraws its flags, as it cleared them before
//     (startFlagNotifications); removing the thread, the user dismissing it and disabling
//     the plugin are the notification store's and the plugin store's;
//   - Of reads a plugin's live flags back from its active flag notifications.

// pluginFlags adapts the thread and notification stores to plugin.ThreadFlags.
type pluginFlags struct {
	threads flagThreads
	notes   flagNotes
}

// flagThreads is the part of the thread store flags read. *thread.Manager implements it.
type flagThreads interface {
	Snapshot() *thread.Snapshot
	// Seen reports whether the user sees the thread now.
	Seen(id string) bool
}

// flagNotes is the part of the notification store flags write. *notification.Manager
// implements it.
type flagNotes interface {
	Snapshot() *notification.Snapshot
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
	Withdraw(ctx context.Context, source, key string) (notification.Notification, error)
	Active(source, key string) (notification.Notification, bool)
}

var _ plugin.ThreadFlags = pluginFlags{}

// flagLevels map a flag's level to its notification's.
var flagLevels = map[string]notification.Level{
	pluginsdk.FlagAttention: notification.LevelWarning,
	pluginsdk.FlagError:     notification.LevelError,
}

// flagPost is the notification of s on thread id.
func flagPost(id string, s plugin.FlagSpec) notification.Post {
	title := strings.TrimSpace(s.Reason)
	if title == "" {
		title = s.DisplayName + " flagged this thread"
	}
	return notification.Post{
		Source: s.Plugin, Key: notification.FlagKey(id, s.UntilSeen), Level: flagLevels[s.Level], Title: title, ThreadID: id,
	}
}

func (f pluginFlags) SetFlag(ctx context.Context, id string, s plugin.FlagSpec) (bool, error) {
	if s.Level != pluginsdk.FlagNone {
		if _, ok := flagLevels[s.Level]; !ok {
			return false, fmt.Errorf("%w: flag level %q", plugin.ErrInvalidArgument, s.Level)
		}
	}
	t, ok := f.threads.Snapshot().Thread(id)
	if !ok {
		return false, fmt.Errorf("%w: thread %s", plugin.ErrNotFound, id)
	}
	if s.Level == pluginsdk.FlagNone {
		sticky, err := f.withdraw(ctx, s.Plugin, notification.FlagKey(id, false))
		if err != nil {
			return false, err
		}
		seen, err := f.withdraw(ctx, s.Plugin, notification.FlagKey(id, true))
		return sticky || seen, err
	}
	if !t.ArchivedAt.IsZero() {
		return false, fmt.Errorf("%w: thread %s is archived", plugin.ErrFailedPrecondition, id)
	}
	// One flag per plugin and thread: the other mode's goes.
	replaced, err := f.withdraw(ctx, s.Plugin, notification.FlagKey(id, !s.UntilSeen))
	if err != nil {
		return false, err
	}
	if s.UntilSeen && f.threads.Seen(id) {
		// Seen as it is raised: nothing to show, and one shown before is seen now.
		went, err := f.withdraw(ctx, s.Plugin, notification.FlagKey(id, true))
		return replaced || went, err
	}
	res, err := f.notes.Post(ctx, flagPost(id, s))
	if err != nil {
		return replaced, mapNotificationErr(err)
	}
	return replaced || res.Outcome != notification.OutcomeUnchanged, nil
}

// withdraw withdraws source's notification with key and reports whether an active one
// went.
func (f pluginFlags) withdraw(ctx context.Context, source, key string) (bool, error) {
	if _, active := f.notes.Active(source, key); !active {
		return false, nil
	}
	n, err := f.notes.Withdraw(ctx, source, key)
	if err != nil {
		return false, mapNotificationErr(err)
	}
	return n.State == notification.StateWithdrawn, nil
}

// notificationFlagLevels map a flag notification's level back to the flag's.
var notificationFlagLevels = map[notification.Level]string{
	notification.LevelWarning: pluginsdk.FlagAttention,
	notification.LevelError:   pluginsdk.FlagError,
}

func (f pluginFlags) Of(name string) []pluginsdk.Flag {
	var out []pluginsdk.Flag
	for _, n := range f.notes.Snapshot().Notifications {
		id, untilSeen, ok := notification.ParseFlagKey(n.Key)
		if !ok || n.Source != name {
			continue
		}
		out = append(out, pluginsdk.Flag{ThreadID: id, Level: cmpOr(notificationFlagLevels[n.Level], pluginsdk.FlagAttention),
			Reason: n.Title, UntilSeen: untilSeen, SetAt: n.UpdatedAt})
	}
	slices.SortFunc(out, func(a, b pluginsdk.Flag) int { return a.SetAt.Compare(b.SetAt) })
	return out
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// seen withdraws thread id's until-seen flags: the user sees it. The thread store calls
// it with its lock held (SetSeenHook); the notification store never waits on the thread
// store.
func (f pluginFlags) seen(log *slog.Logger) func(id string) {
	return func(id string) {
		key := notification.FlagKey(id, true)
		for _, n := range f.notes.Snapshot().Notifications {
			if n.Key != key || !n.IsFlag() {
				continue
			}
			// Withdrawn, not dismissed: the plugin raising the same reason again (the next
			// failure) shows again, as the old flag did. A dismissal would hold it back.
			if _, err := f.notes.Withdraw(context.Background(), n.Source, n.Key); err != nil {
				log.Warn("an until-seen flag not withdrawn", "thread", id, "plugin", n.Source, "err", err)
			}
		}
	}
}

// withdrawArchived withdraws the flags on archived threads (or one thread's, with id)
// and says how many went.
func (f pluginFlags) withdrawArchived(ctx context.Context, only string) (int, error) {
	snap := f.threads.Snapshot()
	k := 0
	var errs []error
	for _, n := range f.notes.Snapshot().Notifications {
		id, _, ok := notification.ParseFlagKey(n.Key)
		if !ok || !n.IsFlag() || (only != "" && id != only) {
			continue
		}
		if t, found := snap.Thread(id); !found || t.ArchivedAt.IsZero() {
			continue
		}
		went, err := f.withdraw(ctx, n.Source, n.Key)
		if err != nil {
			errs = append(errs, err)
		} else if went {
			k++
		}
	}
	return k, errors.Join(errs...)
}

// flagArchiveSweep is how often the glue withdraws flags on archived threads, for an
// archive whose event the bus dropped.
const flagArchiveSweep = time.Minute

// seenHooks is where the thread store reports the user seeing a thread. *thread.Manager
// implements it.
type seenHooks interface{ SetSeenHook(func(threadID string)) }

// startFlagNotifications hooks flags into the thread store: its seen moments withdraw
// until-seen flags, and an archived thread's flags are withdrawn (on its Updated event,
// at start and every minute). The returned func stops it.
func startFlagNotifications(ctx context.Context, log *slog.Logger, threads seenHooks, flags pluginFlags, b *bus.Bus) func() {
	threads.SetSeenHook(flags.seen(log))
	ctx, cancel := context.WithCancel(ctx)
	events := bus.Subscribe[thread.Event](b, 256)
	sweep := func(only string) {
		if n, err := flags.withdrawArchived(ctx, only); err != nil {
			log.Warn("flags on archived threads not withdrawn", "err", err)
		} else if n > 0 {
			log.Info("flags withdrawn: their threads are archived", "count", n)
		}
	}
	var wg sync.WaitGroup
	wg.Go(func() {
		defer events.Close()
		tick := time.NewTicker(flagArchiveSweep)
		defer tick.Stop()
		sweep("")
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				sweep("")
			case ev := <-events.C():
				if e, ok := ev.(thread.Updated); ok && !e.Thread.ArchivedAt.IsZero() {
					sweep(e.Thread.ID)
				}
			}
		}
	})
	return func() {
		threads.SetSeenHook(nil)
		cancel()
		wg.Wait()
	}
}

// legacyFlags is the part of the thread store holding flags from before they were
// notifications. *thread.Manager implements it.
type legacyFlags interface {
	LegacyFlags(ctx context.Context) ([]thread.LegacyFlag, error)
	DropLegacyFlag(ctx context.Context, id, source string) error
}

// convertLegacyFlags posts the flags thread_flags still holds as notifications, through
// SetFlag, and drops each row once it is converted, or can never be (its thread is
// archived or gone): run once at start, before plugins start, so initialize reports them.
// A row whose post failed otherwise (the plugin has too many notifications, the database)
// stays for the next start. It says how many it converted.
func convertLegacyFlags(ctx context.Context, log *slog.Logger, legacy legacyFlags, flags pluginFlags) int {
	rows, err := legacy.LegacyFlags(ctx)
	if err != nil {
		log.Warn("flags from before notifications not read", "err", err)
		return 0
	}
	k := 0
	for _, r := range rows {
		spec := plugin.FlagSpec{Plugin: r.Source, DisplayName: cmpOr(r.SourceName, r.Source), Level: r.Level, Reason: r.Reason, UntilSeen: r.UntilSeen}
		_, err := flags.SetFlag(ctx, r.ThreadID, spec)
		switch {
		case err == nil:
			k++
		case errors.Is(err, plugin.ErrNotFound), errors.Is(err, plugin.ErrInvalidArgument),
			errors.Is(err, plugin.ErrFailedPrecondition) && !errors.Is(err, notification.ErrFull):
			log.Info("a flag from before notifications dropped", "thread", r.ThreadID, "plugin", r.Source, "why", err)
		default:
			log.Warn("a flag from before notifications not converted; next start tries again", "thread", r.ThreadID, "plugin", r.Source, "err", err)
			continue
		}
		if err := legacy.DropLegacyFlag(ctx, r.ThreadID, r.Source); err != nil {
			log.Warn("a converted flag's row not dropped", "thread", r.ThreadID, "plugin", r.Source, "err", err)
		}
	}
	if k > 0 {
		log.Info("flags from before notifications converted", "count", k)
	}
	return k
}
