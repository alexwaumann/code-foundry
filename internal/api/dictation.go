package api

import (
	"context"
	"errors"
	"io"
	"time"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/bus"
	"github.com/alexwaumann/code-foundry/internal/store/dictation"
)

// DictationStore is the dictation store (*dictation.Store) as DictationService drives it.
type DictationStore interface {
	Snapshot() dictation.Snapshot
	Download() (dictation.Snapshot, error)
	CancelDownload() dictation.Snapshot
	RemoveModel() (dictation.Snapshot, error)
	Start(ctx context.Context, clientID string) (string, error)
	Stop(ctx context.Context, sessionID string, flush bool) error
	Audio(sessionID string, pcm []byte, rms float32) bool
	SessionEnded(sessionID string) (reason dictation.EndReason, ended, ok bool)
	MicDenied(denied bool)
}

var _ DictationStore = (*dictation.Store)(nil)

// dictationSessionBuffer is a Session stream's backlog: levels come 20 a second, so
// this is seconds of them.
const dictationSessionBuffer = 256

// Dictation implements codefoundryv1connect.DictationServiceHandler over the dictation
// store (docs/notes/dictation-2-daemon.md).
type Dictation struct {
	store DictationStore
	bus   *bus.Bus
	beat  time.Duration // heartbeat interval; zero is HeartbeatInterval (tests shorten it)
}

var _ codefoundryv1connect.DictationServiceHandler = (*Dictation)(nil)

// NewDictation returns a DictationService handler. b must be the bus the store publishes
// on.
func NewDictation(store DictationStore, b *bus.Bus) *Dictation {
	return &Dictation{store: store, bus: b}
}

// Route mounts the service.
func (h *Dictation) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewDictationServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// Status is the snapshot now (the dictation.* commands read it).
func (h *Dictation) Status() *v1.DictationSnapshot {
	return DictationSnapshotToProto(h.store.Snapshot())
}

// Watch sends the snapshot, then again after every change, and a heartbeat after
// HeartbeatInterval without one.
func (h *Dictation) Watch(ctx context.Context, _ *connect.Request[v1.WatchDictationRequest], stream *connect.ServerStream[v1.DictationSnapshot]) error {
	sub := bus.Subscribe[dictation.Changed](h.bus, watchBuffer)
	defer sub.Close()
	if err := stream.Send(DictationSnapshotToProto(h.store.Snapshot())); err != nil {
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
			if err := stream.Send(&v1.DictationSnapshot{Heartbeat: &v1.StreamHeartbeat{}}); err != nil {
				return err
			}
		case _, ok := <-sub.C():
			if !ok {
				return nil
			}
			// Every event carries the whole state: the latest one says it all.
			for len(sub.C()) > 0 {
				<-sub.C()
			}
			beat.Reset()
			if err := stream.Send(DictationSnapshotToProto(h.store.Snapshot())); err != nil {
				return err
			}
		}
	}
}

// Download starts downloading the model.
func (h *Dictation) Download(context.Context, *connect.Request[v1.DownloadDictationModelRequest]) (*connect.Response[v1.DownloadDictationModelResponse], error) {
	s, err := h.store.Download()
	if err != nil {
		return nil, dictationError(err)
	}
	return connect.NewResponse(&v1.DownloadDictationModelResponse{Snapshot: DictationSnapshotToProto(s)}), nil
}

// CancelDownload stops a running download.
func (h *Dictation) CancelDownload(context.Context, *connect.Request[v1.CancelDictationDownloadRequest]) (*connect.Response[v1.CancelDictationDownloadResponse], error) {
	return connect.NewResponse(&v1.CancelDictationDownloadResponse{Snapshot: DictationSnapshotToProto(h.store.CancelDownload())}), nil
}

// RemoveModel deletes the model.
func (h *Dictation) RemoveModel(context.Context, *connect.Request[v1.RemoveDictationModelRequest]) (*connect.Response[v1.RemoveDictationModelResponse], error) {
	s, err := h.store.RemoveModel()
	if err != nil {
		return nil, dictationError(err)
	}
	return connect.NewResponse(&v1.RemoveDictationModelResponse{Snapshot: DictationSnapshotToProto(s)}), nil
}

// Start opens a session for the client.
func (h *Dictation) Start(ctx context.Context, req *connect.Request[v1.StartDictationRequest]) (*connect.Response[v1.StartDictationResponse], error) {
	if req.Msg.GetClientId() == "" {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("client_id is required"))
	}
	id, err := h.store.Start(ctx, req.Msg.GetClientId())
	if err != nil {
		return nil, dictationError(err)
	}
	return connect.NewResponse(&v1.StartDictationResponse{SessionId: id}), nil
}

// Stop ends a session.
func (h *Dictation) Stop(ctx context.Context, req *connect.Request[v1.StopDictationRequest]) (*connect.Response[v1.StopDictationResponse], error) {
	if err := h.store.Stop(ctx, req.Msg.GetSessionId(), req.Msg.GetFlush()); err != nil {
		return nil, dictationError(err)
	}
	return connect.NewResponse(&v1.StopDictationResponse{}), nil
}

// Session streams one session's levels and phrases, then its end.
func (h *Dictation) Session(ctx context.Context, req *connect.Request[v1.DictationSessionRequest], stream *connect.ServerStream[v1.DictationSessionEvent]) error {
	id := req.Msg.GetSessionId()
	// Subscribe before looking, so nothing between the look and the loop is missed.
	sub := bus.Subscribe[dictation.SessionEvent](h.bus, dictationSessionBuffer)
	defer sub.Close()
	reason, ended, ok := h.store.SessionEnded(id)
	switch {
	case !ok:
		return connect.NewError(connect.CodeNotFound, dictation.ErrUnknownSession)
	case ended:
		return stream.Send(dictationEndedToProto(reason))
	}
	// A heartbeat first opens the stream: a client's call returns once it has headers,
	// and the first level may be a while away.
	heartbeatEvent := &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Heartbeat{Heartbeat: &v1.StreamHeartbeat{}}}
	if err := stream.Send(heartbeatEvent); err != nil {
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
			if err := stream.Send(heartbeatEvent); err != nil {
				return err
			}
		case ev, ok := <-sub.C():
			if !ok {
				return nil
			}
			if ev.SessionID != id {
				continue
			}
			beat.Reset()
			if err := stream.Send(dictationSessionEventToProto(ev)); err != nil {
				return err
			}
			if ev.Kind == dictation.SessionEnded {
				return nil
			}
		}
	}
}

// Audio takes the host's microphone frames until it closes the stream.
func (h *Dictation) Audio(_ context.Context, stream *connect.ClientStream[v1.DictationAudioFrame]) (*connect.Response[v1.DictationAudioResponse], error) {
	for stream.Receive() {
		f := stream.Msg()
		h.store.Audio(f.GetSessionId(), f.GetPcm(), f.GetRms())
	}
	if err := stream.Err(); err != nil && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return connect.NewResponse(&v1.DictationAudioResponse{}), nil
}

// MicDenied records the host's microphone permission.
func (h *Dictation) MicDenied(_ context.Context, req *connect.Request[v1.DictationMicDeniedRequest]) (*connect.Response[v1.DictationMicDeniedResponse], error) {
	h.store.MicDenied(req.Msg.GetDenied())
	return connect.NewResponse(&v1.DictationMicDeniedResponse{}), nil
}

func dictationError(err error) error {
	switch {
	case errors.Is(err, dictation.ErrBusy):
		return connect.NewError(connect.CodeAborted, err)
	case errors.Is(err, dictation.ErrUnknownSession):
		return connect.NewError(connect.CodeNotFound, err)
	case errors.Is(err, dictation.ErrDisabled), errors.Is(err, dictation.ErrNoModel), errors.Is(err, dictation.ErrDownloaded),
		errors.Is(err, dictation.ErrEngine):
		return connect.NewError(connect.CodeFailedPrecondition, err)
	case errors.Is(err, context.Canceled):
		return connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return connect.NewError(connect.CodeDeadlineExceeded, err)
	}
	return connect.NewError(connect.CodeInternal, err)
}

var dictationStates = map[dictation.State]v1.DictationState{
	dictation.Disabled:    v1.DictationState_DICTATION_STATE_DISABLED,
	dictation.NoModel:     v1.DictationState_DICTATION_STATE_NO_MODEL,
	dictation.Downloading: v1.DictationState_DICTATION_STATE_DOWNLOADING,
	dictation.Loading:     v1.DictationState_DICTATION_STATE_LOADING,
	dictation.Ready:       v1.DictationState_DICTATION_STATE_READY,
	dictation.Unloaded:    v1.DictationState_DICTATION_STATE_UNLOADED,
	dictation.Listening:   v1.DictationState_DICTATION_STATE_LISTENING,
	dictation.Failed:      v1.DictationState_DICTATION_STATE_ERROR,
}

var dictationEndReasons = map[dictation.EndReason]v1.DictationEndReason{
	dictation.EndStopped:  v1.DictationEndReason_DICTATION_END_REASON_STOPPED,
	dictation.EndSilence:  v1.DictationEndReason_DICTATION_END_REASON_SILENCE,
	dictation.EndDisabled: v1.DictationEndReason_DICTATION_END_REASON_DISABLED,
	dictation.EndError:    v1.DictationEndReason_DICTATION_END_REASON_ERROR,
}

// DictationSnapshotToProto converts the store's snapshot.
func DictationSnapshotToProto(s dictation.Snapshot) *v1.DictationSnapshot {
	out := &v1.DictationSnapshot{
		Enabled: s.Enabled, State: dictationStates[s.State], Error: s.Error, MicDenied: s.MicDenied,
		Model: &v1.DictationModel{Name: s.Model.Name, SizeBytes: s.Model.Size, Downloaded: s.Model.Downloaded},
		Hardware: &v1.DictationHardware{
			Chip: s.Hardware.Chip, MemoryBytes: s.Hardware.MemoryBytes, M1Family: s.Hardware.M1Family,
		},
	}
	if d := s.Model.Download; d != nil {
		out.Model.Download = &v1.DictationDownload{ReceivedBytes: d.Received, TotalBytes: d.Total, BytesPerSecond: d.BytesPerSecond}
	}
	if x := s.Session; x != nil {
		out.Session = &v1.DictationSession{Id: x.ID, ClientId: x.ClientID, StartedAt: timestamppb.New(x.StartedAt)}
	}
	return out
}

func dictationEndedToProto(r dictation.EndReason) *v1.DictationSessionEvent {
	return &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Ended{Ended: &v1.DictationEnded{Reason: dictationEndReasons[r]}}}
}

func dictationSessionEventToProto(ev dictation.SessionEvent) *v1.DictationSessionEvent {
	switch ev.Kind {
	case dictation.SessionLevel:
		return &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Level{Level: &v1.DictationLevel{Rms: ev.RMS}}}
	case dictation.SessionPhrase:
		return &v1.DictationSessionEvent{Event: &v1.DictationSessionEvent_Phrase{Phrase: &v1.DictationPhrase{Text: ev.Text}}}
	}
	return dictationEndedToProto(ev.Reason)
}
