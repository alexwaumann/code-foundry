package daemon

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"os"

	"github.com/alexwaumann/code-foundry/internal/store/notification"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// A changed default keeps the old value on a home from before the change, and tells the
// user once that the new one exists (docs/notes/threads-open-as-3-default.md). The settings
// store owns the step and its markers (internal/store/settings defaultchange.go); this is
// the glue: whether the home is new, and the notice.

// homeExisted reports whether the home has data from before this start: its database. Every
// daemon start opens (and so creates) it, so a home without one has never run a daemon.
// Checked before the database is opened. An error other than "not there" counts as existing:
// keeping the old default is the safe side.
func homeExisted(log *slog.Logger, dbPath string) bool {
	_, err := os.Stat(dbPath)
	switch {
	case err == nil:
		return true
	case errors.Is(err, fs.ErrNotExist):
		return false
	default:
		log.Warn("settings: could not tell whether the home is new; treating it as existing", "path", dbPath, "err", err)
		return true
	}
}

// keepOldDefaults runs the settings store's default changes before anything reads the
// settings (the layout loads after it, so a home from before Panes became the default is
// never converted).
func keepOldDefaults(ctx context.Context, log *slog.Logger, st *settings.Store, dbPath string) {
	st.KeepOldDefaults(ctx, homeExisted(log, dbPath))
}

// defaultNoticeStore is the part of the notification store the notices need.
// *notification.Manager implements it.
type defaultNoticeStore interface {
	Post(ctx context.Context, p notification.Post) (notification.PostResult, error)
}

// defaultNotices are the notices of the default changes, by the change's id: posted once
// ever per home under a fixed key (SourceApp), so they never stack or repeat.
var defaultNotices = map[string]notification.Post{
	settings.ThreadsOpenAsPanesDefault: {
		Source: notification.SourceApp,
		Key:    ThreadsOpenAsNoticeKey,
		Level:  notification.LevelInfo,
		Title:  "Threads can now open as panes",
		Body: "A thread pane shows one thread with its diff, files and terminals beside it. Clicking another thread swaps them, " +
			"so there are no thread tabs to manage. You are still on tabs: switch in Settings › Layout › Threads open as.",
		Actions: []notification.ActionSpec{{Action: notification.Action{
			Label: "Open settings", Kind: notification.KindCommand, Command: "view.settings",
			Args: map[string]string{"setting": settings.KeyThreadsOpenAs},
		}, Resolves: noResolve}},
	},
}

// ThreadsOpenAsNoticeKey is the key of the notice that Panes became the default.
const ThreadsOpenAsNoticeKey = "threads-open-as-panes"

// postDefaultNotices posts the notices the settings store says are owed, and records each
// one posted. A failed post is logged and owed again at the next start.
func postDefaultNotices(ctx context.Context, log *slog.Logger, st *settings.Store, notes defaultNoticeStore) {
	for _, id := range st.DueNotices() {
		p, ok := defaultNotices[id]
		if !ok {
			continue
		}
		if _, err := notes.Post(ctx, p); err != nil {
			log.Warn("could not post the notice of a changed default; trying again at the next start", "change", id, "err", err)
			continue
		}
		st.MarkNoticed(id)
		log.Info("posted the notice of a changed default", "change", id)
	}
}
