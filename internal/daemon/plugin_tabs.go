package daemon

import (
	"context"

	core "github.com/alexwaumann/code-foundry/internal/layout"
	layoutstore "github.com/alexwaumann/code-foundry/internal/store/layout"
)

// pluginTabs is plugin.TabOpener over the layout store: a plugin surface's show command opens
// its tab by the placement rules, as the view.open verbs do (docs/notes/shell-24a-import-moves.md,
// item 5). A call that does not take the user's focus keeps it where it is.
type pluginTabs struct{ layout layoutstore.Store }

func (p pluginTabs) OpenTab(ctx context.Context, tb *core.Tab, focus bool) (core.Result, error) {
	c, err := p.layout.Apply(ctx, &core.OpenSurface{Tab: tb, Focus: focus}, layoutstore.ApplyOptions{KeepFocus: !focus})
	return c.Result, err
}
