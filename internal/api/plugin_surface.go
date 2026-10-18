package api

import (
	"context"
	"errors"
	"time"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/store/plugin"
)

// WithSurfaces serves WatchSurface, GetSurface and Act from s (the plugin store) and
// fills List's surface availability.
func (h *Plugin) WithSurfaces(s plugin.Surfaces) *Plugin {
	h.surfaces = s
	return h
}

func (h *Plugin) fillAvailability(ps []*v1.Plugin, uctx command.Context) {
	for _, p := range ps {
		for _, s := range p.GetSurfaces() {
			if h.surfaces == nil || !p.GetEnabled() {
				s.UnavailableReason = "plugin " + p.GetName() + " is disabled"
				continue
			}
			a := h.surfaces.SurfaceAvailable(p.GetName(), s.GetId(), uctx)
			s.Available, s.Unknown, s.UnavailableReason = a.Available, a.Unknown, a.Reason
		}
	}
}

func surfaceRefFromProto(r *v1.SurfaceRef) plugin.SurfaceRef {
	return plugin.SurfaceRef{Plugin: r.GetPlugin(), Surface: r.GetSurface(), Context: contextFromProto(r.GetContext()), Instance: r.GetInstance()}
}

var surfacePhases = map[plugin.SurfacePhase]v1.SurfacePhase{
	plugin.PhaseOpening:       v1.SurfacePhase_SURFACE_PHASE_OPENING,
	plugin.PhaseLive:          v1.SurfacePhase_SURFACE_PHASE_LIVE,
	plugin.PhaseNotResponding: v1.SurfacePhase_SURFACE_PHASE_NOT_RESPONDING,
	plugin.PhasePluginDown:    v1.SurfacePhase_SURFACE_PHASE_PLUGIN_DOWN,
	plugin.PhaseFailed:        v1.SurfacePhase_SURFACE_PHASE_FAILED,
}

func surfaceStateToProto(s *plugin.SurfaceState) *v1.SurfaceState {
	return &v1.SurfaceState{Instance: s.Instance, Phase: surfacePhases[s.Phase], Message: s.Message, PluginState: pluginStates[s.PluginState]}
}

func surfaceViewToProto(v *plugin.SurfaceView) *v1.SurfaceView {
	return &v1.SurfaceView{Instance: v.Instance, Version: v.Version, ViewJson: string(v.JSON), HostRendered: v.HostRendered}
}

func surfaceUpdateToProto(u plugin.SurfaceUpdate) *v1.SurfaceUpdate {
	switch {
	case u.State != nil:
		return &v1.SurfaceUpdate{Update: &v1.SurfaceUpdate_State{State: surfaceStateToProto(u.State)}}
	case u.View != nil:
		return &v1.SurfaceUpdate{Update: &v1.SurfaceUpdate_View{View: surfaceViewToProto(u.View)}}
	case u.Append != nil:
		a := &v1.SurfaceLogAppend{Instance: u.Append.Instance, Version: u.Append.Version, Key: u.Append.Key, Text: u.Append.Text}
		for _, l := range u.Append.Lines {
			a.Lines = append(a.Lines, &v1.SurfaceLogLine{Text: l.Text, Tone: l.Tone})
		}
		return &v1.SurfaceUpdate{Update: &v1.SurfaceUpdate_Append{Append: a}}
	case u.Toast != nil:
		return &v1.SurfaceUpdate{Update: &v1.SurfaceUpdate_Toast{Toast: &v1.SurfaceToast{Instance: u.Toast.Instance, Level: u.Toast.Level, Text: u.Toast.Text}}}
	}
	return nil
}

func (h *Plugin) needSurfaces() error {
	if h.surfaces == nil {
		return connect.NewError(connect.CodeUnimplemented, errors.New("surfaces are not served here"))
	}
	return nil
}

// WatchSurface streams one surface instance.
func (h *Plugin) WatchSurface(ctx context.Context, req *connect.Request[v1.WatchSurfaceRequest], stream *connect.ServerStream[v1.SurfaceUpdate]) error {
	if err := h.needSurfaces(); err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // releases the watcher if Send fails
	_, ch, err := h.surfaces.WatchSurface(ctx, surfaceRefFromProto(req.Msg.GetRef()))
	if err != nil {
		return pluginError(err)
	}
	// Flush the headers now: the first update may wait on the plugin.
	if err := stream.Send(nil); err != nil {
		return err
	}
	beat := newHeartbeat(h.beat)
	defer beat.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-beat.C():
			beat.Reset()
			if err := stream.Send(&v1.SurfaceUpdate{Update: &v1.SurfaceUpdate_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}); err != nil {
				return err
			}
		case u, ok := <-ch:
			if !ok {
				return nil
			}
			beat.Reset()
			if msg := surfaceUpdateToProto(u); msg != nil {
				if err := stream.Send(msg); err != nil {
					return err
				}
			}
		}
	}
}

// defaultSurfaceWait is how long GetSurface waits for a view by default.
const defaultSurfaceWait = 10 * time.Second

// getSurfaceSettle is how long GetSurface waits for a new view after the live state when
// it already has the cached one.
const getSurfaceSettle = 200 * time.Millisecond

// maxSurfaceSettle bounds GetSurfaceRequest.settle_ms, and the whole settle: a plugin
// sending views without pause does not hold the call longer.
const maxSurfaceSettle = 30 * time.Second

// GetSurface opens an instance, waits for a view, and returns it with its elements.
// With settle_ms it then waits until no new view has come for that long.
func (h *Plugin) GetSurface(ctx context.Context, req *connect.Request[v1.GetSurfaceRequest]) (*connect.Response[v1.GetSurfaceResponse], error) {
	if err := h.needSurfaces(); err != nil {
		return nil, err
	}
	wait := time.Duration(req.Msg.GetWaitMs()) * time.Millisecond
	if wait <= 0 {
		wait = defaultSurfaceWait
	}
	quiet := min(max(time.Duration(req.Msg.GetSettleMs())*time.Millisecond, 0), maxSurfaceSettle)
	wctx, cancel := context.WithCancel(ctx)
	defer cancel()
	_, ch, err := h.surfaces.WatchSurface(wctx, surfaceRefFromProto(req.Msg.GetRef()))
	if err != nil {
		return nil, pluginError(err)
	}
	out := &v1.GetSurfaceResponse{}
	var view *plugin.SurfaceView
	first := time.NewTimer(wait)
	defer first.Stop()
	// A view that arrives with (after) the live state ends the wait. A cached view
	// followed by "live" and no new view is current too (the plugin re-sent the same
	// view): it ends the wait shortly after.
	var settle <-chan time.Time
	open := true
loop:
	for {
		select {
		case u, ok := <-ch:
			if !ok {
				open = false
				break loop
			}
			switch {
			case u.State != nil:
				out.State = surfaceStateToProto(u.State)
				switch {
				case u.State.Phase == plugin.PhaseFailed:
					break loop
				case u.State.Phase != plugin.PhaseOpening && view != nil:
					settle = time.After(getSurfaceSettle)
				}
			case u.View != nil:
				view = u.View
				out.View = surfaceViewToProto(u.View)
				if out.GetState().GetPhase() != v1.SurfacePhase_SURFACE_PHASE_OPENING {
					break loop
				}
			}
		case <-settle:
			break loop
		case <-first.C:
			break loop
		}
	}
	if open && quiet > 0 && view != nil && out.GetState().GetPhase() != v1.SurfacePhase_SURFACE_PHASE_FAILED {
		view = h.settleSurface(ch, out, view, quiet)
	}
	cancel()
	for range ch {
		// Drain until the watcher has let go.
	}
	if view != nil {
		for _, el := range h.surfaces.SurfaceElements(view.Instance, view.Version) {
			out.Elements = append(out.Elements, &v1.SurfaceElement{Key: el.Key, Kind: el.Kind, Action: el.Action, Label: el.Label, Form: el.Form, Args: el.Args})
		}
	}
	return connect.NewResponse(out), nil
}

// settleSurface reads updates until no view has come for quiet (or maxSurfaceSettle has
// passed, or the stream ends) and returns the last view.
func (h *Plugin) settleSurface(ch <-chan plugin.SurfaceUpdate, out *v1.GetSurfaceResponse, view *plugin.SurfaceView, quiet time.Duration) *plugin.SurfaceView {
	still := time.NewTimer(quiet)
	defer still.Stop()
	limit := time.NewTimer(maxSurfaceSettle)
	defer limit.Stop()
	for {
		select {
		case u, ok := <-ch:
			if !ok {
				return view
			}
			switch {
			case u.State != nil:
				out.State = surfaceStateToProto(u.State)
			case u.View != nil:
				view = u.View
				out.View = surfaceViewToProto(u.View)
				still.Reset(quiet)
			}
		case <-still.C:
			return view
		case <-limit.C:
			return view
		}
	}
}

// Act forwards an action on a view element to the plugin.
func (h *Plugin) Act(ctx context.Context, req *connect.Request[v1.SurfaceActRequest]) (*connect.Response[v1.SurfaceActResponse], error) {
	if err := h.needSurfaces(); err != nil {
		return nil, err
	}
	m := req.Msg
	ar := plugin.ActRequest{Instance: m.GetInstance(), Version: m.GetVersion(), Key: m.GetKey(), Action: m.GetAction()}
	if m.GetContext() != nil {
		ar.Context = contextFromProto(m.GetContext())
	}
	if m.GetInstance() == "" {
		ar.Ref = surfaceRefFromProto(m.GetRef())
	}
	if m.Value != nil {
		v := m.GetValue()
		ar.Value = &v
	}
	if m.GetValues() != nil {
		ar.Values = m.GetValues().AsMap()
	}
	ver, err := h.surfaces.Act(ctx, ar)
	if err != nil {
		if errors.Is(err, plugin.ErrPluginRefused) {
			return nil, connect.NewError(connect.CodeAborted, err)
		}
		return nil, pluginError(err)
	}
	return connect.NewResponse(&v1.SurfaceActResponse{Version: ver}), nil
}
