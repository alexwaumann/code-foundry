package api

import (
	"fmt"
	"maps"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/reflect/protoreflect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	core "github.com/alexwaumann/code-foundry/internal/layout"
)

// layoutOpConv turns one case of LayoutOp into the op of internal/layout it names.
type layoutOpConv func(*v1.LayoutOp) (core.Op, error)

// layoutOps holds a converter per LayoutOp case the daemon runs, by the case's field name,
// which is the op's JSON name in internal/layout. A case without one answers Unimplemented:
// the thread ops are declared in layout.proto before the daemon runs them, and each later
// group of ops registers its converters from a file of its own.
var layoutOps = map[protoreflect.Name]layoutOpConv{}

func registerLayoutOp(name protoreflect.Name, conv layoutOpConv) { layoutOps[name] = conv }

// layoutOpFromProto converts an ApplyLayoutRequest's op.
func layoutOpFromProto(m *v1.LayoutOp) (core.Op, error) {
	if m == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("no layout op given"))
	}
	r := m.ProtoReflect()
	fd := r.WhichOneof(r.Descriptor().Oneofs().ByName("op"))
	if fd == nil {
		if len(r.GetUnknown()) > 0 {
			// A case added after this daemon was built.
			return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("a layout op this daemon does not know; update the app"))
		}
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("no layout op given"))
	}
	conv, ok := layoutOps[fd.Name()]
	if !ok {
		return nil, connect.NewError(connect.CodeUnimplemented, fmt.Errorf("layout op %s is not available yet", fd.Name()))
	}
	op, err := conv(m)
	if err != nil {
		return nil, layoutError(err)
	}
	return op, nil
}

func layoutTabFromProto(m *v1.LayoutTab) *core.Tab {
	if m == nil {
		return nil
	}
	return &core.Tab{ID: m.GetId(), Kind: m.GetKind(), Thread: m.GetThreadId(), Params: maps.Clone(m.GetParams()), Title: m.GetTitle(), Name: m.GetName()}
}

// layoutEdgeFromProto is "" for unspecified.
func layoutEdgeFromProto(e v1.LayoutEdge) (core.Edge, error) {
	if e == v1.LayoutEdge_LAYOUT_EDGE_UNSPECIFIED {
		return "", nil
	}
	for k, v := range layoutEdges {
		if v == e {
			return k, nil
		}
	}
	return "", fmt.Errorf("edge %d: %w", e, core.ErrInvalidArgument)
}

func optionalIndex(i *int32) *int {
	if i == nil {
		return nil
	}
	n := int(*i)
	return &n
}

func init() {
	registerLayoutOp("add_tab", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetAddTab()
		return &core.AddTab{Space: o.GetSpaceId(), Pane: o.GetPaneId(), Tab: layoutTabFromProto(o.GetTab()), Index: optionalIndex(o.Index), Focus: o.GetFocus()}, nil
	})
	registerLayoutOp("split_pane", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSplitPane()
		edge, err := layoutEdgeFromProto(o.GetEdge())
		if err != nil {
			return nil, err
		}
		return &core.SplitPane{Pane: o.GetPaneId(), Edge: edge, Tab: layoutTabFromProto(o.GetTab()), Frac: o.GetFrac(), Focus: o.GetFocus()}, nil
	})
	registerLayoutOp("move_tab", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetMoveTab()
		edge, err := layoutEdgeFromProto(o.GetEdge())
		if err != nil {
			return nil, err
		}
		return &core.MoveTab{Tab: o.GetTabId(), Space: o.GetSpaceId(), Pane: o.GetPaneId(), Index: optionalIndex(o.Index), Edge: edge, Frac: o.GetFrac()}, nil
	})
	registerLayoutOp("move_pane", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetMovePane()
		edge, err := layoutEdgeFromProto(o.GetEdge())
		if err != nil {
			return nil, err
		}
		return &core.MovePane{Pane: o.GetPaneId(), Target: o.GetTargetPaneId(), Edge: edge, Frac: o.GetFrac(), Space: o.GetSpaceId()}, nil
	})
	registerLayoutOp("merge_pane", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetMergePane()
		return &core.MergePane{Pane: o.GetPaneId(), Target: o.GetTargetPaneId(), Index: optionalIndex(o.Index)}, nil
	})
	registerLayoutOp("swap_pane", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSwapPane()
		return &core.SwapPane{Pane: o.GetPaneId(), Target: o.GetTargetPaneId()}, nil
	})
	registerLayoutOp("close_tab", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.CloseTab{Tab: m.GetCloseTab().GetTabId(), Record: m.GetCloseTab().GetRecord()}, nil
	})
	registerLayoutOp("close_pane", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.ClosePane{Pane: m.GetClosePane().GetPaneId(), Record: m.GetClosePane().GetRecord()}, nil
	})
	registerLayoutOp("reopen_closed", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetReopenClosed()
		return &core.ReopenClosed{Space: o.GetSpaceId(), Gone: append([]string(nil), o.GetGoneTabIds()...)}, nil
	})
	registerLayoutOp("set_sizes", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSetSizes()
		return &core.SetSizes{Split: o.GetSplitId(), Sizes: append([]float64(nil), o.GetSizes()...)}, nil
	})
	registerLayoutOp("focus_tab", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.FocusTab{Tab: m.GetFocusTab().GetTabId()}, nil
	})
	registerLayoutOp("focus_pane", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.FocusPane{Pane: m.GetFocusPane().GetPaneId()}, nil
	})
	registerLayoutOp("set_tab_params", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetSetTabParams()
		return &core.SetTabParams{Tab: o.GetTabId(), Params: maps.Clone(o.GetParams()), Title: o.Title}, nil
	})
	registerLayoutOp("rename_tab", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetRenameTab()
		return &core.RenameTab{Tab: o.GetTabId(), Name: o.GetName()}, nil
	})
	registerLayoutOp("new_space", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetNewSpace()
		return &core.NewSpace{Name: o.GetName(), Switch: o.GetMakeCurrent()}, nil
	})
	registerLayoutOp("rename_space", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetRenameSpace()
		return &core.RenameSpace{Space: o.GetSpaceId(), Name: o.GetName()}, nil
	})
	registerLayoutOp("remove_space", func(m *v1.LayoutOp) (core.Op, error) {
		o := m.GetRemoveSpace()
		return &core.RemoveSpace{Space: o.GetSpaceId(), To: o.GetToSpaceId()}, nil
	})
	registerLayoutOp("reorder_spaces", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.ReorderSpaces{Order: append([]string(nil), m.GetReorderSpaces().GetSpaceIds()...)}, nil
	})
	registerLayoutOp("switch_space", func(m *v1.LayoutOp) (core.Op, error) {
		return &core.SwitchSpace{Space: m.GetSwitchSpace().GetSpaceId()}, nil
	})
}
