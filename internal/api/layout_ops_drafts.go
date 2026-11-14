package api

import (
	"maps"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// The composer and its drafts (internal/layout's drafts.go).
func init() {
	registerLayoutOp("new_thread", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetNewThread()
		return &core.NewThread{Space: o.GetSpaceId(), Pane: o.GetPaneId(), Params: maps.Clone(o.GetParams()), Focus: o.GetFocus()}, nil
	})
	registerLayoutOp("start_draft", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetStartDraft()
		return &core.StartDraft{Tab: o.GetTabId(), Draft: o.GetDraftId(), Label: o.GetLabel()}, nil
	})
	registerLayoutOp("label_draft", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetLabelDraft()
		return &core.LabelDraft{Draft: o.GetDraftId(), Label: o.GetLabel()}, nil
	})
	registerLayoutOp("clear_draft", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.ClearDraft{Draft: m.GetClearDraft().GetDraftId()}, nil
	})
	registerLayoutOp("discard_draft", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.DiscardDraft{Draft: m.GetDiscardDraft().GetDraftId()}, nil
	})
	registerLayoutOp("open_draft", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetOpenDraft()
		return &core.OpenDraft{Draft: o.GetDraftId(), Focus: o.GetFocus()}, nil
	})
}
