package api

import (
	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// A pane the user collapses (internal/layout's collapse.go).
func init() {
	registerLayoutOp("set_collapsed", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSetCollapsed()
		return &core.SetCollapsed{Pane: o.GetPaneId(), Collapsed: o.GetCollapsed()}, nil
	})
}
