package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/update"
)

// updateWatchBuffer is the per-client backlog of update events. Status events carry
// full state, so a client that drops some is resent the snapshot.
const updateWatchBuffer = 32

// Update implements codefoundryv1connect.UpdateServiceHandler over the updater.
type Update struct {
	svc  update.Service
	bus  *bus.Bus
	done <-chan struct{}
}

var _ codefoundryv1connect.UpdateServiceHandler = (*Update)(nil)

// NewUpdate returns an UpdateService handler. done (may be nil) ends Watch streams.
func NewUpdate(svc update.Service, b *bus.Bus, done <-chan struct{}) *Update {
	return &Update{svc: svc, bus: b, done: done}
}

// Route mounts the service.
func (h *Update) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewUpdateServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Get returns the current status.
func (h *Update) Get(context.Context, *connect.Request[v1.GetUpdateStatusRequest]) (*connect.Response[v1.GetUpdateStatusResponse], error) {
	return connect.NewResponse(&v1.GetUpdateStatusResponse{Status: updateStatusToProto(h.svc.Snapshot())}), nil
}

// Check checks for a newer release now.
func (h *Update) Check(ctx context.Context, _ *connect.Request[v1.CheckForUpdateRequest]) (*connect.Response[v1.CheckForUpdateResponse], error) {
	st, err := h.svc.Check(ctx)
	if err != nil {
		return nil, updateError(err)
	}
	return connect.NewResponse(&v1.CheckForUpdateResponse{Status: updateStatusToProto(st)}), nil
}

// Install starts installing the available version.
func (h *Update) Install(ctx context.Context, _ *connect.Request[v1.InstallUpdateRequest]) (*connect.Response[v1.InstallUpdateResponse], error) {
	st, err := h.svc.Install(ctx)
	if err != nil {
		return nil, updateError(err)
	}
	return connect.NewResponse(&v1.InstallUpdateResponse{Status: updateStatusToProto(st)}), nil
}

// Relaunch asks connected GUIs to relaunch.
func (h *Update) Relaunch(context.Context, *connect.Request[v1.RelaunchAppRequest]) (*connect.Response[v1.RelaunchAppResponse], error) {
	return connect.NewResponse(&v1.RelaunchAppResponse{Delivered: int32(h.svc.RequestRelaunch())}), nil
}

// RequestRestart tells connected GUIs the daemon is about to restart (`app.restart`).
func (h *Update) RequestRestart(context.Context, *connect.Request[v1.RequestRestartRequest]) (*connect.Response[v1.RequestRestartResponse], error) {
	return connect.NewResponse(&v1.RequestRestartResponse{Delivered: int32(h.svc.RequestRestart())}), nil
}

// Watch sends the status, then every change and relaunch and restart request.
func (h *Update) Watch(ctx context.Context, _ *connect.Request[v1.WatchUpdateRequest], stream *connect.ServerStream[v1.UpdateEvent]) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	src := updateSource{svc: h.svc, bus: h.bus}
	live := src.subscribe(ctx)
	send := func(evs []*v1.Event) error {
		for _, ev := range evs {
			if err := stream.Send(ev.GetUpdate()); err != nil {
				return err
			}
		}
		return nil
	}
	if err := send(src.snapshot(ctx)); err != nil {
		return err
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-h.done:
			return nil
		case ev, ok := <-live:
			if !ok {
				return nil
			}
			if ev == nil {
				if err := send(src.snapshot(ctx)); err != nil {
					return err
				}
				continue
			}
			if err := send([]*v1.Event{ev}); err != nil {
				return err
			}
		}
	}
}

func updateError(err error) error {
	if errors.Is(err, update.ErrDisabled) || errors.Is(err, update.ErrNotAvailable) {
		return connect.NewError(connect.CodeFailedPrecondition, err)
	}
	if errors.Is(err, context.Canceled) {
		return connect.NewError(connect.CodeCanceled, err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	return connect.NewError(connect.CodeUnavailable, err)
}

var updateStates = map[update.State]v1.UpdateState{
	update.Idle:            v1.UpdateState_UPDATE_STATE_IDLE,
	update.Available:       v1.UpdateState_UPDATE_STATE_AVAILABLE,
	update.Downloading:     v1.UpdateState_UPDATE_STATE_DOWNLOADING,
	update.Installed:       v1.UpdateState_UPDATE_STATE_INSTALLED,
	update.RestartRequired: v1.UpdateState_UPDATE_STATE_RESTART_REQUIRED,
	update.Failed:          v1.UpdateState_UPDATE_STATE_FAILED,
}

func updateStatusToProto(s update.Status) *v1.UpdateStatus {
	out := &v1.UpdateStatus{
		State:          updateStates[s.State],
		CurrentVersion: s.Current,
		Enabled:        s.Enabled,
		DisabledReason: s.DisabledReason,
		ReleaseRepo:    s.Repo,
		Checking:       s.Checking,
		LastCheckError: s.LastCheckError,
		LatestVersion:  s.Latest,
		TargetVersion:  s.Target,
		NotesUrl:       s.NotesURL,
		Progress:       s.Progress,
		FailureReason:  s.FailureReason,
	}
	if !s.LastCheckedAt.IsZero() {
		out.LastCheckedAt = timestamppb.New(s.LastCheckedAt)
	}
	return out
}

// ---- EventService source -------------------------------------------------------

// updateSource feeds EventService (and UpdateService.Watch): the status as snapshot,
// then status changes and relaunch and restart requests.
type updateSource struct {
	svc update.Service
	bus *bus.Bus
}

func (updateSource) kind() v1.EventSource { return v1.EventSource_EVENT_SOURCE_UPDATE }

func updateWrap(e *v1.UpdateEvent) *v1.Event { return &v1.Event{Event: &v1.Event_Update{Update: e}} }

func updateStatusEvent(s update.Status) *v1.Event {
	return updateWrap(&v1.UpdateEvent{Event: &v1.UpdateEvent_Status{Status: updateStatusToProto(s)}})
}

func (s updateSource) subscribe(ctx context.Context) <-chan *v1.Event {
	return fanIn(ctx,
		newTap(s.bus, updateWatchBuffer, func(e update.Event) *v1.Event { return updateStatusEvent(e.Status) }),
		newTap(s.bus, updateWatchBuffer, func(update.RelaunchRequested) *v1.Event {
			return updateWrap(&v1.UpdateEvent{Event: &v1.UpdateEvent_RelaunchRequested{RelaunchRequested: &v1.RelaunchRequested{}}})
		}),
		newTap(s.bus, updateWatchBuffer, func(update.RestartRequested) *v1.Event {
			return updateWrap(&v1.UpdateEvent{Event: &v1.UpdateEvent_RestartRequested{RestartRequested: &v1.RestartRequested{}}})
		}),
	)
}

func (s updateSource) snapshot(context.Context) []*v1.Event {
	return []*v1.Event{updateStatusEvent(s.svc.Snapshot())}
}
