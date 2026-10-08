package api

import (
	"context"
	"errors"
	"fmt"
	"math"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/store/terminal"
)

// Terminal implements codefoundryv1connect.TerminalServiceHandler over a terminal.Store.
type Terminal struct {
	store terminal.Store
}

var _ codefoundryv1connect.TerminalServiceHandler = (*Terminal)(nil)

// NewTerminal returns a TerminalService handler.
func NewTerminal(store terminal.Store) *Terminal { return &Terminal{store: store} }

// Route mounts the service.
func (h *Terminal) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewTerminalServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Create spawns a terminal.
func (h *Terminal) Create(ctx context.Context, req *connect.Request[v1.CreateTerminalRequest]) (*connect.Response[v1.CreateTerminalResponse], error) {
	m := req.Msg
	cols, rows, err := size(m.GetCols(), m.GetRows())
	if err != nil {
		return nil, err
	}
	t, err := h.store.Create(ctx, terminal.Spec{
		Argv:   m.GetArgv(),
		Cwd:    m.GetCwd(),
		Env:    m.GetEnv(),
		Cols:   cols,
		Rows:   rows,
		Labels: m.GetLabels(),
	})
	if err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.CreateTerminalResponse{Terminal: terminalToProto(t)}), nil
}

// List returns all terminals.
func (h *Terminal) List(ctx context.Context, _ *connect.Request[v1.ListTerminalsRequest]) (*connect.Response[v1.ListTerminalsResponse], error) {
	ts := h.store.List(ctx)
	out := make([]*v1.Terminal, len(ts))
	for i, t := range ts {
		out[i] = terminalToProto(t)
	}
	return connect.NewResponse(&v1.ListTerminalsResponse{Terminals: out}), nil
}

// Get returns one terminal.
func (h *Terminal) Get(ctx context.Context, req *connect.Request[v1.GetTerminalRequest]) (*connect.Response[v1.GetTerminalResponse], error) {
	t, err := h.store.Get(ctx, req.Msg.GetId())
	if err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.GetTerminalResponse{Terminal: terminalToProto(t)}), nil
}

// Attach streams a snapshot then live events. The stream ends cleanly when the client
// cancels or the terminal is removed, and with ResourceExhausted if the client fell too
// far behind (re-attach to get a fresh snapshot).
func (h *Terminal) Attach(ctx context.Context, req *connect.Request[v1.AttachRequest], stream *connect.ServerStream[v1.AttachEvent]) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel() // detaches if Send fails
	ch, err := h.store.Attach(ctx, req.Msg.GetId())
	if err != nil {
		return terminalError(err)
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-ch:
			if !ok {
				return nil
			}
			if ev.Dropped {
				return connect.NewError(connect.CodeResourceExhausted, terminal.ErrSlowSubscriber)
			}
			if err := stream.Send(attachEventToProto(ev)); err != nil {
				return err
			}
		}
	}
}

// Write sends input to the PTY.
func (h *Terminal) Write(ctx context.Context, req *connect.Request[v1.WriteTerminalRequest]) (*connect.Response[v1.WriteTerminalResponse], error) {
	if err := h.store.Write(ctx, req.Msg.GetId(), req.Msg.GetData()); err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.WriteTerminalResponse{}), nil
}

// Resize changes the PTY and emulator size.
func (h *Terminal) Resize(ctx context.Context, req *connect.Request[v1.ResizeTerminalRequest]) (*connect.Response[v1.ResizeTerminalResponse], error) {
	cols, rows, err := size(req.Msg.GetCols(), req.Msg.GetRows())
	if err != nil {
		return nil, err
	}
	if err := h.store.Resize(ctx, req.Msg.GetId(), cols, rows); err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.ResizeTerminalResponse{}), nil
}

// Kill terminates the process.
func (h *Terminal) Kill(ctx context.Context, req *connect.Request[v1.KillTerminalRequest]) (*connect.Response[v1.KillTerminalResponse], error) {
	if err := h.store.Kill(ctx, req.Msg.GetId()); err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.KillTerminalResponse{}), nil
}

// Remove forgets an exited terminal.
func (h *Terminal) Remove(ctx context.Context, req *connect.Request[v1.RemoveTerminalRequest]) (*connect.Response[v1.RemoveTerminalResponse], error) {
	if err := h.store.Remove(ctx, req.Msg.GetId()); err != nil {
		return nil, terminalError(err)
	}
	return connect.NewResponse(&v1.RemoveTerminalResponse{}), nil
}

// Watch first sends every current terminal as `updated`, then live changes. It
// subscribes before listing, so nothing is missed; a terminal may appear twice.
func (h *Terminal) Watch(ctx context.Context, _ *connect.Request[v1.WatchTerminalsRequest], stream *connect.ServerStream[v1.TerminalEvent]) error {
	events, err := h.store.Watch(ctx)
	if err != nil {
		return terminalError(err)
	}
	for _, t := range h.store.List(ctx) {
		if err := stream.Send(&v1.TerminalEvent{Event: &v1.TerminalEvent_Updated{Updated: terminalToProto(t)}}); err != nil {
			return err
		}
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case ev, ok := <-events:
			if !ok {
				return nil
			}
			if err := stream.Send(terminalEventToProto(ev)); err != nil {
				return err
			}
		}
	}
}

// terminalEventToProto maps one Watch item; shared with EventService.
func terminalEventToProto(ev terminal.Event) *v1.TerminalEvent {
	if ev.Updated != nil {
		return &v1.TerminalEvent{Event: &v1.TerminalEvent_Updated{Updated: terminalToProto(*ev.Updated)}}
	}
	return &v1.TerminalEvent{Event: &v1.TerminalEvent_RemovedId{RemovedId: ev.RemovedID}}
}

func size(cols, rows uint32) (uint16, uint16, error) {
	if cols > math.MaxUint16 || rows > math.MaxUint16 {
		return 0, 0, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("size %dx%d out of range", cols, rows))
	}
	return uint16(cols), uint16(rows), nil
}

func terminalToProto(t terminal.Terminal) *v1.Terminal {
	p := &v1.Terminal{
		Id:        t.ID,
		Argv:      t.Argv,
		Cwd:       t.Cwd,
		Cols:      uint32(t.Cols),
		Rows:      uint32(t.Rows),
		Title:     t.Title,
		AltScreen: t.AltScreen,
		Labels:    t.Labels,
	}
	if !t.StartedAt.IsZero() {
		p.StartedAt = timestamppb.New(t.StartedAt)
	}
	switch t.State {
	case terminal.StateRunning:
		p.State = v1.TerminalState_TERMINAL_STATE_RUNNING
	case terminal.StateExited:
		p.State = v1.TerminalState_TERMINAL_STATE_EXITED
		p.ExitCode = int32(t.ExitCode)
		p.ExitedAt = timestamppb.New(t.ExitedAt)
	}
	return p
}

func attachEventToProto(ev terminal.AttachEvent) *v1.AttachEvent {
	switch {
	case ev.Snapshot != nil:
		return &v1.AttachEvent{Event: &v1.AttachEvent_Snapshot_{Snapshot: &v1.AttachEvent_Snapshot{
			Data:      ev.Snapshot.Data,
			Cols:      uint32(ev.Snapshot.Cols),
			Rows:      uint32(ev.Snapshot.Rows),
			AltScreen: ev.Snapshot.AltScreen,
		}}}
	case ev.Resized != nil:
		return &v1.AttachEvent{Event: &v1.AttachEvent_Resized_{Resized: &v1.AttachEvent_Resized{
			Cols: uint32(ev.Resized.Cols), Rows: uint32(ev.Resized.Rows),
		}}}
	case ev.Exited != nil:
		return &v1.AttachEvent{Event: &v1.AttachEvent_Exited_{Exited: &v1.AttachEvent_Exited{
			ExitCode: int32(ev.Exited.Code),
		}}}
	default:
		return &v1.AttachEvent{Event: &v1.AttachEvent_Output_{Output: &v1.AttachEvent_Output{Data: ev.Output}}}
	}
}

// terminalError maps store errors to Connect codes.
func terminalError(err error) error {
	code := connect.CodeInternal
	switch {
	case errors.Is(err, terminal.ErrNotFound):
		code = connect.CodeNotFound
	case errors.Is(err, terminal.ErrInvalidSpec):
		code = connect.CodeInvalidArgument
	case errors.Is(err, terminal.ErrRunning), errors.Is(err, terminal.ErrExited):
		code = connect.CodeFailedPrecondition
	case errors.Is(err, terminal.ErrInputBacklog), errors.Is(err, terminal.ErrSlowSubscriber):
		code = connect.CodeResourceExhausted
	case errors.Is(err, terminal.ErrClosed):
		code = connect.CodeUnavailable
	case errors.Is(err, context.Canceled):
		code = connect.CodeCanceled
	case errors.Is(err, context.DeadlineExceeded):
		code = connect.CodeDeadlineExceeded
	}
	return connect.NewError(code, err)
}
