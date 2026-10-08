package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/awaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/awaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/awaumann/code-foundry/internal/bus"
	"github.com/awaumann/code-foundry/internal/command"
)

// intentBuffer is each watcher's queue. Intents are rare and small; a watcher that falls
// this far behind misses intents rather than stalling emitters.
const intentBuffer = 32

// UI implements codefoundryv1connect.UiServiceHandler. Intents travel on the bus as
// command.IntentEvent, so ui.* commands and Emit reach the same watchers.
type UI struct {
	bus *bus.Bus
}

var _ codefoundryv1connect.UiServiceHandler = (*UI)(nil)

// NewUI returns a UiService handler on b.
func NewUI(b *bus.Bus) *UI { return &UI{bus: b} }

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
