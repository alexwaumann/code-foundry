package api

import (
	"maps"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The thread ops of internal/layout (place.go, thread.go): placement, a thread's own tab and
// its linked set. None names a pane area here: the store gives each the viewport the last
// window reported (core.WithArea).
func init() {
	registerLayoutOp("open_thread", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetOpenThread()
		edge, err := layoutEdgeFromProto(o.GetEdge())
		if err != nil {
			return nil, err
		}
		return &core.OpenThread{Thread: o.GetThreadId(), Pane: o.GetPaneId(), Index: optionalIndex(o.Index), Edge: edge, Compose: o.GetComposeTabId(), Focus: o.GetFocus()}, nil
	})
	registerLayoutOp("close_thread", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.CloseThread{Thread: m.GetCloseThread().GetThreadId()}, nil
	})
	registerLayoutOp("open_surface", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetOpenSurface()
		return &core.OpenSurface{Space: o.GetSpaceId(), Pane: o.GetPaneId(), Tab: layoutTabFromProto(o.GetTab()), Focus: o.GetFocus(), Behind: o.GetBehindTabId()}, nil
	})
	registerLayoutOp("move_thread", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetMoveThread()
		return &core.MoveThreadToSpace{Thread: o.GetThreadId(), Space: o.GetSpaceId()}, nil
	})
	registerLayoutOp("archive_thread", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.ArchiveThread{Thread: m.GetArchiveThread().GetThreadId()}, nil
	})
	registerLayoutOp("snooze_thread", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSnoozeThread()
		return &core.SnoozeThread{Thread: o.GetThreadId(), Ran: maps.Clone(o.GetRan()), QuickRan: o.GetQuickRan()}, nil
	})
}
