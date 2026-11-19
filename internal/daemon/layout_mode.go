package daemon

import (
	"context"
	"log/slog"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
	"github.com/alexwaumann/code-foundry/internal/store/settings"
)

// convertLayoutOnModeChange converts the layout when the setting layout.threads_open_as
// changes to panes or single (internal/layout modes.go, core.Conform): by settings.set, the
// settings page, or an edit of the settings file. The hook runs before the change is
// published, so `settings.set layout.threads_open_as panes` returns with the layout converted.
// Toward tabs nothing changes. A layout stored under another mode is converted when it loads
// (the layout store's New), so the first call, with the mode the daemon started with, does
// nothing.
func convertLayoutOnModeChange(st *settings.Store, l layoutstore.Store, log *slog.Logger) {
	last := st.Settings().Layout.ThreadsOpenAs
	st.OnChange(func(snap *settings.Snapshot) {
		mode := snap.Settings.Layout.ThreadsOpenAs
		if mode == last {
			return
		}
		last = mode
		if m, err := core.ParseMode(mode); err != nil || !m.Panes() {
			return
		}
		c, err := l.Apply(context.Background(), &core.Conform{}, layoutstore.ApplyOptions{})
		switch {
		case err != nil:
			log.Error("layout: converting to threads open as "+mode, "err", err)
		case c.Result.Conformed != nil:
			r := c.Result.Conformed
			log.Info("layout: converted to threads open as "+mode, "thread_tabs", r.ThreadTabs, "composers", r.Composers,
				"panes", r.Panes, "moved", r.Moved, "spaces", r.Spaces)
		}
	})
}
