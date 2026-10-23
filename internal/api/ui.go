package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/command"
	"github.com/alexwaumann/code-foundry/internal/theme"
)

// intentBuffer is each watcher's queue. Intents are rare and small; a watcher that falls
// this far behind misses intents rather than stalling emitters.
const intentBuffer = 32

// UI implements codefoundryv1connect.UiServiceHandler. Intents travel on the bus as
// command.IntentEvent, so ui.* commands and Emit reach the same watchers. PublishTheme
// records the GUI's active theme for the frame stylesheet (theme.Live), PublishThemeReport
// its contrast report on the user's themes (theme.Reports).
type UI struct {
	bus     *bus.Bus
	theme   *theme.Live
	reports *theme.Reports
}

var _ codefoundryv1connect.UiServiceHandler = (*UI)(nil)

// NewUI returns a UiService handler on b that publishes themes to live and theme reports
// to reports.
func NewUI(b *bus.Bus, live *theme.Live, reports *theme.Reports) *UI {
	return &UI{bus: b, theme: live, reports: reports}
}

// Route mounts the service.
func (h *UI) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewUiServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// WatchIntents streams every intent emitted while the stream is open. Response headers
// are flushed as soon as the watcher is subscribed, so a client that has seen them
// counts toward Emit's delivered total.
func (h *UI) WatchIntents(ctx context.Context, _ *connect.Request[v1.WatchIntentsRequest], stream *connect.ServerStream[v1.UiIntent]) error {
	sub := bus.Subscribe[command.IntentEvent](h.bus, intentBuffer)
	defer sub.Close()
	if err := stream.Send(nil); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if err := stream.Send(ev.Intent); err != nil {
				return err
			}
		}
	}
}

// Emit publishes an intent to all watchers.
func (h *UI) Emit(_ context.Context, req *connect.Request[v1.EmitIntentRequest]) (*connect.Response[v1.EmitIntentResponse], error) {
	intent := req.Msg.GetIntent()
	if intent.GetIntent() == nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("intent is required"))
	}
	n := command.BusEmitter{Bus: h.bus}.Emit(intent)
	return connect.NewResponse(&v1.EmitIntentResponse{Delivered: uint32(n)}), nil
}

// PublishTheme makes the GUI's active theme the one GET /cf/theme.css and /cf/theme.json
// serve. InvalidArgument when the id, scheme, a name or a value would not be safe in a
// stylesheet (theme.Frame.Check).
func (h *UI) PublishTheme(_ context.Context, req *connect.Request[v1.PublishThemeRequest]) (*connect.Response[v1.PublishThemeResponse], error) {
	m := req.Msg
	if err := h.theme.Publish(theme.Frame{ID: m.GetId(), Scheme: m.GetScheme(), Vars: m.GetVars()}); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&v1.PublishThemeResponse{}), nil
}

// PublishThemeReport keeps the GUI's contrast report on each user theme it names, for
// theme save and theme check. InvalidArgument (and nothing kept) when any is refused
// (theme.Report.Check).
func (h *UI) PublishThemeReport(_ context.Context, req *connect.Request[v1.PublishThemeReportRequest]) (*connect.Response[v1.PublishThemeReportResponse], error) {
	reps := make([]theme.Report, len(req.Msg.GetReports()))
	for i, r := range req.Msg.GetReports() {
		reps[i] = theme.Report{ID: r.GetId(), Version: r.GetVersion()}
		for _, is := range r.GetIssues() {
			reps[i].Issues = append(reps[i].Issues, theme.ContrastIssue{
				Slot: is.GetSlot(), Against: is.GetAgainst(), Label: is.GetLabel(), Ratio: is.GetRatio(), Required: is.GetRequired(),
			})
		}
		for _, p := range r.GetStale() {
			reps[i].Stale = append(reps[i].Stale, theme.StalePin{Slot: p.GetSlot(), Pinned: p.GetPinned(), Basis: p.GetBasis(), Derived: p.GetDerived()})
		}
	}
	if err := h.reports.Publish(reps...); err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return connect.NewResponse(&v1.PublishThemeReportResponse{}), nil
}
