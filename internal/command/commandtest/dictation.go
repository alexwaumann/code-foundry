package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Dictation is a fake command.DictationBackend. Every call is recorded and returns
// Snapshot (Start returns SessionID); Err, when set, is returned instead.
type Dictation struct {
	Calls
	Err       error
	Snapshot  *v1.DictationSnapshot
	SessionID string
}

var _ command.DictationBackend = (*Dictation)(nil)

// Download records the call.
func (d *Dictation) Download(_ context.Context, r *connect.Request[v1.DownloadDictationModelRequest]) (*connect.Response[v1.DownloadDictationModelResponse], error) {
	d.record(r.Msg)
	if d.Err != nil {
		return nil, d.Err
	}
	return connect.NewResponse(&v1.DownloadDictationModelResponse{Snapshot: d.Snapshot}), nil
}

// CancelDownload records the call.
func (d *Dictation) CancelDownload(_ context.Context, r *connect.Request[v1.CancelDictationDownloadRequest]) (*connect.Response[v1.CancelDictationDownloadResponse], error) {
	d.record(r.Msg)
	if d.Err != nil {
		return nil, d.Err
	}
	return connect.NewResponse(&v1.CancelDictationDownloadResponse{Snapshot: d.Snapshot}), nil
}

// RemoveModel records the call.
func (d *Dictation) RemoveModel(_ context.Context, r *connect.Request[v1.RemoveDictationModelRequest]) (*connect.Response[v1.RemoveDictationModelResponse], error) {
	d.record(r.Msg)
	if d.Err != nil {
		return nil, d.Err
	}
	return connect.NewResponse(&v1.RemoveDictationModelResponse{Snapshot: d.Snapshot}), nil
}

// Start records the call and returns SessionID.
func (d *Dictation) Start(_ context.Context, r *connect.Request[v1.StartDictationRequest]) (*connect.Response[v1.StartDictationResponse], error) {
	d.record(r.Msg)
	if d.Err != nil {
		return nil, d.Err
	}
	return connect.NewResponse(&v1.StartDictationResponse{SessionId: d.SessionID}), nil
}

// Stop records the call.
func (d *Dictation) Stop(_ context.Context, r *connect.Request[v1.StopDictationRequest]) (*connect.Response[v1.StopDictationResponse], error) {
	d.record(r.Msg)
	if d.Err != nil {
		return nil, d.Err
	}
	return connect.NewResponse(&v1.StopDictationResponse{}), nil
}
