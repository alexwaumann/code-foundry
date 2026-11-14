package layout

import "context"

// Calls a window made, before the first-load import (docs/notes/shell-24a-import-moves.md,
// item 3; core.TrackWindowTabs). The shell window imports before it first draws, so until the
// import no window draws the layout: a thread tab a window's command opens then was opened by
// a window from before the shell, through a chord it takes from the daemon (its cmd+j runs
// terminal.quick). The store keeps those tabs' ids (layout_meta legacy_window_tabs) and gives
// them to the import, which closes them where nothing else was arranged.

type windowCallKey struct{}

// FromWindow marks ctx as a call a window made with its own controls (its keys, palette or
// buttons), not the CLI, a thread's model, a page or a plugin. internal/command marks every
// such command it runs.
func FromWindow(ctx context.Context) context.Context {
	return context.WithValue(ctx, windowCallKey{}, true)
}

// IsWindowCall reports whether ctx is marked by FromWindow.
func IsWindowCall(ctx context.Context) bool {
	v, _ := ctx.Value(windowCallKey{}).(bool)
	return v
}
