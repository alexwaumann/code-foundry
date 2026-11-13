package api

import (
	"context"
	"errors"
	"maps"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	core "github.com/alexwaumann/code-foundry/internal/layout"
	"github.com/alexwaumann/code-foundry/internal/store/layout"
)

// Layout implements codefoundryv1connect.LayoutServiceHandler over a layout.Store. The ops
// it runs are converted by the registry in layout_ops.go.
type Layout struct {
	store    layout.Store
	importer LegacyImporter
}

// LegacyImporter runs the first-load import with what the daemon knows of threads and
// terminals, and marks the shells it makes quick terminals (internal/daemon).
type LegacyImporter interface {
	ImportLegacy(ctx context.Context, panelJSON, bottomJSON, clientID string) (layout.ImportCommit, error)
}

// WithImporter sets what runs ImportLegacy; without one it is Unimplemented.
func (h *Layout) WithImporter(imp LegacyImporter) *Layout {
	h.importer = imp
	return h
}

var _ codefoundryv1connect.LayoutServiceHandler = (*Layout)(nil)

// NewLayout returns a LayoutService handler.
func NewLayout(store layout.Store) *Layout { return &Layout{store: store} }

// Route mounts the service.
func (h *Layout) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewLayoutServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Get returns the whole layout.
func (h *Layout) Get(context.Context, *connect.Request[v1.GetLayoutRequest]) (*connect.Response[v1.GetLayoutResponse], error) {
	return connect.NewResponse(&v1.GetLayoutResponse{Layout: layoutToProto(h.store.Snapshot())}), nil
}

// Apply runs one op.
func (h *Layout) Apply(ctx context.Context, req *connect.Request[v1.ApplyLayoutRequest]) (*connect.Response[v1.ApplyLayoutResponse], error) {
	op, err := layoutOpFromProto(req.Msg.GetOp())
	if err != nil {
		return nil, err
	}
	c, err := h.store.Apply(ctx, op, layout.ApplyOptions{ClientID: req.Msg.GetClientId()})
	if err != nil {
		return nil, layoutError(err)
	}
	return connect.NewResponse(applyResponse(c)), nil
}

// applyResponse is what a commit reports to the caller.
func applyResponse(c layout.Commit) *v1.ApplyLayoutResponse {
	r := c.Result
	tabs := func(in []*core.Tab) []*v1.LayoutTab {
		var out []*v1.LayoutTab
		for _, tb := range in {
			out = append(out, layoutTabToProto(tb))
		}
		return out
	}
	return &v1.ApplyLayoutResponse{
		Rev: c.Rev, SpaceId: r.Space, PaneId: r.Pane, TabId: r.Tab, Existing: r.Existing,
		Closed: tabs(r.Closed), Rule: r.Rule, Kept: tabs(r.Kept), Ended: tabs(r.Ended),
		BackTabIds: r.Back, PlacedTabIds: r.Placed, FreshTabIds: r.Fresh, SwappedPaneIds: r.Swapped,
		DraftId: r.Draft,
	}
}

// SetViewport records a window's pane area.
func (h *Layout) SetViewport(_ context.Context, req *connect.Request[v1.SetViewportRequest]) (*connect.Response[v1.SetViewportResponse], error) {
	m := req.Msg
	if err := h.store.SetViewport(m.GetClientId(), layout.Viewport{Width: m.GetWidth(), Height: m.GetHeight()}); err != nil {
		return nil, layoutError(err)
	}
	return connect.NewResponse(&v1.SetViewportResponse{}), nil
}

// ImportLegacy runs the first-load import, once.
func (h *Layout) ImportLegacy(ctx context.Context, req *connect.Request[v1.ImportLegacyRequest]) (*connect.Response[v1.ImportLegacyResponse], error) {
	if h.importer == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no first-load import"))
	}
	m := req.Msg
	c, err := h.importer.ImportLegacy(ctx, m.GetPanelJson(), m.GetBottomJson(), m.GetClientId())
	if err != nil {
		return nil, layoutError(err)
	}
	ids := func(tabs []*core.Tab) []string {
		var out []string
		for _, tb := range tabs {
			out = append(out, tb.ID)
		}
		return out
	}
	out := &v1.ImportLegacyResponse{
		Layout: layoutToProto(h.store.Snapshot()), Imported: c.Imported,
		RemovedTabIds: ids(c.Result.Removed), FoldedTabIds: ids(c.Result.Folded), Dropped: c.Result.Dropped,
	}
	for _, r := range c.Result.Threads {
		out.Threads = append(out.Threads, &v1.LegacyImportedThread{ThreadId: r.Thread, TabIds: r.Tabs, QuickTerminalId: r.Quick})
	}
	return connect.NewResponse(out), nil
}

// layoutError maps internal/layout's errors (and the store's) to Connect codes.
func layoutError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, core.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, core.ErrInvalidArgument):
		code = connect.CodeInvalidArgument
	case errors.Is(err, core.ErrAlreadyExists):
		code = connect.CodeAlreadyExists
	case errors.Is(err, core.ErrFailedPrecondition):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, layout.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}

func layoutToProto(snap *layout.Snapshot) *v1.Layout {
	st := snap.State
	out := &v1.Layout{Rev: snap.Rev, CurrentSpaceId: st.CurrentSpace, DefaultSpaceId: st.DefaultSpace, LegacyImported: snap.LegacyImported}
	for _, sp := range st.Spaces {
		out.Spaces = append(out.Spaces, layoutSpaceToProto(sp))
	}
	for _, id := range slices.Sorted(maps.Keys(st.Threads)) {
		out.Threads = append(out.Threads, threadLayoutToProto(id, st.Threads[id]))
	}
	return out
}

func layoutDeltaToProto(d layout.Delta) *v1.LayoutDelta {
	out := &v1.LayoutDelta{
		RemovedSpaceIds:  d.RemovedSpaces,
		SpaceOrder:       d.Order,
		CurrentSpaceId:   d.CurrentSpace,
		DefaultSpaceId:   d.DefaultSpace,
		RemovedThreadIds: d.RemovedThreads,
		LegacyImported:   d.LegacyImported,
	}
	for _, sp := range d.Spaces {
		out.Spaces = append(out.Spaces, layoutSpaceToProto(sp))
	}
	for _, e := range d.Threads {
		out.Threads = append(out.Threads, threadLayoutToProto(e.ID, e.State))
	}
	return out
}

func layoutSpaceToProto(sp *core.Space) *v1.LayoutSpace {
	out := &v1.LayoutSpace{Id: sp.ID, Name: sp.Name, Root: layoutNodeToProto(sp.Root), FocusPaneId: sp.Focus, MruTabIds: sp.MRU}
	for _, d := range sp.Drafts {
		out.Drafts = append(out.Drafts, &v1.LayoutDraft{Id: d.ID, Label: d.Label, Params: d.Params})
	}
	return out
}

var layoutDirs = map[core.Dir]v1.LayoutDir{core.Row: v1.LayoutDir_LAYOUT_DIR_ROW, core.Col: v1.LayoutDir_LAYOUT_DIR_COL}

var layoutEdges = map[core.Edge]v1.LayoutEdge{
	core.Left: v1.LayoutEdge_LAYOUT_EDGE_LEFT, core.Right: v1.LayoutEdge_LAYOUT_EDGE_RIGHT,
	core.Top: v1.LayoutEdge_LAYOUT_EDGE_TOP, core.Bottom: v1.LayoutEdge_LAYOUT_EDGE_BOTTOM,
}

func layoutNodeToProto(n *core.Node) *v1.LayoutNode {
	if n == nil {
		return nil
	}
	if n.IsPane() {
		p := &v1.LayoutPane{Id: n.ID, ActiveTabId: n.Active}
		for _, tb := range n.Tabs {
			p.Tabs = append(p.Tabs, layoutTabToProto(tb))
		}
		return &v1.LayoutNode{Node: &v1.LayoutNode_Pane{Pane: p}}
	}
	s := &v1.LayoutSplit{Id: n.ID, Dir: layoutDirs[n.Dir], Sizes: n.Sizes}
	for _, k := range n.Kids {
		s.Children = append(s.Children, layoutNodeToProto(k))
	}
	return &v1.LayoutNode{Node: &v1.LayoutNode_Split{Split: s}}
}

func layoutTabToProto(tb *core.Tab) *v1.LayoutTab {
	return &v1.LayoutTab{Id: tb.ID, Kind: tb.Kind, ThreadId: tb.Thread, Key: tb.Key, Params: tb.Params, Title: tb.Title, Name: tb.Name}
}

func threadLayoutToProto(id string, ts *core.ThreadState) *v1.ThreadLayout {
	out := &v1.ThreadLayout{ThreadId: id, SpaceId: ts.Space}
	if q := ts.Quick; q != nil {
		out.Quick = &v1.QuickTerminal{Open: q.Open, Height: q.Height}
	}
	if r := ts.Remembered; r != nil {
		out.RememberedPaneId = r.Pane
		for _, rt := range r.Tabs {
			m := &v1.RememberedTab{Tab: layoutTabToProto(rt.Tab), SpaceId: rt.Space, PaneId: rt.Pane, Index: int32(rt.Index), Active: rt.Active, Adjacent: rt.Adjacent}
			if b := rt.Beside; b != nil {
				m.Beside = &v1.LayoutBeside{NeighbourPaneIds: b.Neighbours, Edge: layoutEdges[b.Edge], Frac: b.Frac}
			}
			if f := rt.Fresh; f != nil {
				m.Fresh = &v1.FreshTerminal{Name: f.Name, Ran: f.Ran}
			}
			out.Remembered = append(out.Remembered, m)
		}
	}
	return out
}
