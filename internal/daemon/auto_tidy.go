package daemon

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Auto-tidy (docs/notes/auto-tidy.md): on the wall clock, at the snooze wake check's
// interval and once at start, the daemon saves for later the user's threads idle longer than
// threads.auto_save_after and archives the threads saved for later longer than
// threads.auto_archive_after. Both are off by default and read on every tick, so a change
// applies at the next one. The thread rules are the thread store's (thread.AutoSaveDue,
// thread.AutoArchiveDue, checked again under its lock by AutoSave and AutoArchive); this glue
// adds the one it cannot see, a notification naming the thread, and tells the user in the
// bell: one card per kind under a fixed key (SourceThreads), replaced by each tick that put
// threads away, info level, not time-sensitive, so no Dock badge or bounce.

// Keys of auto-tidy's two cards (SourceThreads).
const (
	tidySavedKey    = "auto-saved"
	tidyArchivedKey = "auto-archived"
)

// tidyNamesShown is how many thread names a card's body lists before "and N more".
const tidyNamesShown = 3

// tidyThreads is the part of the thread store auto-tidy drives. *thread.Manager implements it.
type tidyThreads interface {
	Snapshot() *thread.Snapshot
	AutoSave(ctx context.Context, id string, after time.Duration, idleBefore time.Time) (thread.Thread, bool, error)
	AutoArchive(ctx context.Context, id string, savedBefore time.Time) (thread.Thread, bool, error)
}

// tidyNotes is the part of the notification store auto-tidy reads and posts to.
// *notification.Manager implements it.
type tidyNotes interface {
	Snapshot() *notification.Snapshot
	Active(source, key string) (notification.Notification, bool)
	Retire(ctx context.Context, source, key string) (bool, error)
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
}

// tidySettings are auto-tidy's two settings as their values (settings.TidyAfter reads them).
type tidySettings struct {
	SaveAfter, ArchiveAfter string
}

// autoTidyOptions configure startAutoTidy.
type autoTidyOptions struct {
	Log     *slog.Logger
	Threads tidyThreads
	Notes   tidyNotes
	// Settings reads the two settings, on every tick.
	Settings func() tidySettings
	// Now is the wall clock (time.Now when nil).
	Now func() time.Time
	// Interval is how often it checks (thread.SnoozeCheckInterval when 0).
	Interval time.Duration
	// Day is how long a day of the settings lasts, for trying it out on a dev daemon
	// (CODE_FOUNDRY_DEV_TIDY_DAY with --dev); 24h when 0. The marks and cards keep the
	// settings' own words.
	Day time.Duration
	// Ticked, when set, is called after each tick (tests).
	Ticked func()
}

// autoTidy is one tick's worth of auto-tidy over its options.
type autoTidy struct{ o autoTidyOptions }

func (a autoTidy) now() time.Time {
	if a.o.Now != nil {
		return a.o.Now().Round(0)
	}
	return time.Now().Round(0)
}

// scaled is d in this daemon's days (Options.Day).
func (a autoTidy) scaled(d time.Duration) time.Duration {
	if a.o.Day <= 0 || d <= 0 {
		return d
	}
	return time.Duration(float64(d) / float64(24*time.Hour) * float64(a.o.Day))
}

// tidyPlan is what one tick does to threads: the ones to save for later (idle since before
// idleBefore; never when idleBefore is zero, the step off) and the ones to archive (saved
// since before savedBefore; never when zero), each in the snapshot's order. A thread an
// active notification names (its thread, or an action's) stays where it is: the bell is
// still asking the user about it.
func tidyPlan(threads []thread.Thread, notes []notification.Notification, idleBefore, savedBefore time.Time) (save, archive []thread.Thread) {
	if idleBefore.IsZero() && savedBefore.IsZero() {
		return nil, nil
	}
	named := map[string]bool{}
	for _, n := range notes {
		named[n.ThreadID] = true
		for _, act := range n.Actions {
			named[act.ThreadID] = true
		}
	}
	exists := thread.Known(threads)
	for _, t := range threads {
		switch {
		case named[t.ID]:
		case !idleBefore.IsZero() && thread.AutoSaveDue(t, exists, idleBefore):
			save = append(save, t)
		case !savedBefore.IsZero() && thread.AutoArchiveDue(t, exists, savedBefore):
			archive = append(archive, t)
		}
	}
	return save, archive
}

// tick runs one pass: reads the settings and the stores, saves and archives what tidyPlan
// says (each checked again by the thread store), and posts a card for each kind it did.
func (a autoTidy) tick(ctx context.Context) {
	cfg := a.o.Settings()
	saveAfter, archiveAfter := settings.TidyAfter(cfg.SaveAfter), settings.TidyAfter(cfg.ArchiveAfter)
	if saveAfter == 0 && archiveAfter == 0 {
		return
	}
	now := a.now()
	var idleBefore, savedBefore time.Time
	if saveAfter > 0 {
		idleBefore = now.Add(-a.scaled(saveAfter))
	}
	if archiveAfter > 0 {
		savedBefore = now.Add(-a.scaled(archiveAfter))
	}
	snap := a.o.Threads.Snapshot()
	if snap == nil {
		return
	}
	var notes []notification.Notification
	if ns := a.o.Notes.Snapshot(); ns != nil {
		notes = ns.Notifications
	}
	save, archive := tidyPlan(snap.Threads, notes, idleBefore, savedBefore)
	var saved, archived []thread.Thread
	for _, t := range save {
		got, ok, err := a.o.Threads.AutoSave(ctx, t.ID, saveAfter, idleBefore)
		switch {
		case err != nil:
			a.o.Log.Warn("auto-tidy: save for later", "thread", t.ID, "err", err)
		case ok:
			saved = append(saved, got)
		}
	}
	for _, t := range archive {
		got, ok, err := a.o.Threads.AutoArchive(ctx, t.ID, savedBefore)
		var cascade *thread.CascadeError
		switch {
		case errors.As(err, &cascade) && !got.ArchivedAt.IsZero():
			// Archived; a thread below it was not (named in the log).
			a.o.Log.Warn("auto-tidy: archive", "thread", t.ID, "err", err)
			archived = append(archived, got)
		case err != nil:
			a.o.Log.Warn("auto-tidy: archive", "thread", t.ID, "err", err)
		case ok:
			archived = append(archived, got)
		}
	}
	if len(saved) > 0 {
		a.post(ctx, tidyCard(tidySavedKey, saved))
	}
	if len(archived) > 0 {
		a.post(ctx, tidyCard(tidyArchivedKey, archived))
	}
}

// post puts p in the bell in place of the card under its key. While that card is active,
// p replaces it in place (no new toast when it is shown). Once the user dismissed or acted on
// it, it is retired first, so that p arrives anew even with the same words (the store keeps a
// closed card closed for the same content).
func (a autoTidy) post(ctx context.Context, p notification.Post) {
	if _, ok := a.o.Notes.Active(p.Source, p.Key); !ok {
		if _, err := a.o.Notes.Retire(ctx, p.Source, p.Key); err != nil {
			a.o.Log.Warn("auto-tidy: retire the last card", "key", p.Key, "err", err)
		}
	}
	if _, err := a.o.Notes.Post(ctx, p); err != nil {
		a.o.Log.Warn("auto-tidy: post", "key", p.Key, "err", err)
	}
}

// openTidySettings opens Settings on General, where the two settings are (Threads).
var openTidySettings = notification.ActionSpec{Action: notification.Action{
	Label: "Open settings", Kind: notification.KindCommand, Command: "view.settings", Args: map[string]string{"page": "general"},
}}

// tidyCard is the card for threads auto-tidy just saved (key tidySavedKey) or archived
// (tidyArchivedKey): "3 idle threads were saved for later", their names in the body.
func tidyCard(key string, threads []thread.Thread) notification.Post {
	n := len(threads)
	var title, where string
	if key == tidySavedKey {
		title, where = plural(n, "idle thread was", "idle threads were")+" saved for later", "Under Snoozed"
	} else {
		title, where = plural(n, "saved thread was", "saved threads were")+" archived", "Under Archived"
	}
	return notification.Post{
		Source: notification.SourceThreads, Key: key, Level: notification.LevelInfo,
		Title: title, Body: where + ": " + tidyNames(threads) + ".", Actions: []notification.ActionSpec{openTidySettings},
	}
}

// plural is "1 <one>" or "<n> <many>".
func plural(n int, one, many string) string {
	if n == 1 {
		return "1 " + one
	}
	return fmt.Sprintf("%d %s", n, many)
}

// tidyNames lists the first tidyNamesShown threads' names (the id of one unnamed), then "and
// N more": "A, B and C", "A, B, C and 2 more".
func tidyNames(threads []thread.Thread) string {
	names := make([]string, 0, tidyNamesShown)
	for _, t := range threads[:min(len(threads), tidyNamesShown)] {
		name := strings.Join(strings.FieldsFunc(t.Name, unicode.IsControl), " ")
		if strings.TrimSpace(name) == "" {
			name = t.ID
		}
		names = append(names, clip(strings.TrimSpace(name), 80))
	}
	if rest := len(threads) - len(names); rest > 0 {
		return strings.Join(names, ", ") + fmt.Sprintf(" and %d more", rest)
	}
	if len(names) == 1 {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// startAutoTidy runs a tick at once (what fell due while the daemon was stopped or the Mac
// asleep) and then every Interval, until ctx ends or the returned func is called.
func startAutoTidy(ctx context.Context, o autoTidyOptions) func() {
	switch {
	case o.Interval > 0:
	case o.Day > 0:
		o.Interval = time.Second // a dev daemon's short days
	default:
		o.Interval = thread.SnoozeCheckInterval
	}
	a := autoTidy{o: o}
	ctx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Go(func() {
		tick := time.NewTicker(o.Interval)
		defer tick.Stop()
		for {
			a.tick(ctx)
			if o.Ticked != nil {
				o.Ticked()
			}
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
		}
	})
	return func() {
		cancel()
		wg.Wait()
	}
}

// devTidyDay is CODE_FOUNDRY_DEV_TIDY_DAY on a dev daemon (`daemon --dev`): how long one day
// of auto-tidy's settings lasts, to try it out in minutes; it also checks every second then.
// Ignored without --dev, so no build a user runs has it.
func devTidyDay(log *slog.Logger, dev bool) time.Duration {
	if !dev {
		return 0
	}
	return envDuration(log, "CODE_FOUNDRY_DEV_TIDY_DAY")
}
