package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Update is a fake command.UpdateBackend. Every call returns Status (Download moves it
// to DOWNLOADING first, Install to INSTALLED); Err, when set, is returned instead, and
// InstallErr fails Install alone. Relaunch and RequestRestart report Delivered.
type Update struct {
	Calls
	Err        error
	InstallErr error
	Status     *v1.UpdateStatus
	Delivered  int32
}

var _ command.UpdateBackend = (*Update)(nil)

func (u *Update) status(m proto.Message) (*v1.UpdateStatus, error) {
	u.record(m)
	if u.Err != nil {
		return nil, u.Err
	}
	if u.Status == nil {
		return &v1.UpdateStatus{State: v1.UpdateState_UPDATE_STATE_IDLE, Enabled: true}, nil
	}
	return u.Status, nil
}

// Get returns Status.
func (u *Update) Get(_ context.Context, r *connect.Request[v1.GetUpdateStatusRequest]) (*connect.Response[v1.GetUpdateStatusResponse], error) {
	st, err := u.status(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GetUpdateStatusResponse{Status: st}), nil
}

// Check returns Status.
func (u *Update) Check(_ context.Context, r *connect.Request[v1.CheckForUpdateRequest]) (*connect.Response[v1.CheckForUpdateResponse], error) {
	st, err := u.status(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CheckForUpdateResponse{Status: st}), nil
}

// Download sets Status to DOWNLOADING and returns it.
func (u *Update) Download(_ context.Context, r *connect.Request[v1.DownloadUpdateRequest]) (*connect.Response[v1.DownloadUpdateResponse], error) {
	st, err := u.status(r.Msg)
	if err != nil {
		return nil, err
	}
	u.Status = withState(st, v1.UpdateState_UPDATE_STATE_DOWNLOADING)
	return connect.NewResponse(&v1.DownloadUpdateResponse{Status: u.Status}), nil
}

// Install returns InstallErr, or sets Status to INSTALLED and returns it.
func (u *Update) Install(_ context.Context, r *connect.Request[v1.InstallUpdateRequest]) (*connect.Response[v1.InstallUpdateResponse], error) {
	st, err := u.status(r.Msg)
	if err != nil {
		return nil, err
	}
	if u.InstallErr != nil {
		return nil, u.InstallErr
	}
	u.Status = withState(st, v1.UpdateState_UPDATE_STATE_INSTALLED)
	return connect.NewResponse(&v1.InstallUpdateResponse{Status: u.Status}), nil
}

func withState(st *v1.UpdateStatus, s v1.UpdateState) *v1.UpdateStatus {
	st = proto.CloneOf(st)
	st.State = s
	return st
}

// Relaunch reports Delivered.
func (u *Update) Relaunch(_ context.Context, r *connect.Request[v1.RelaunchAppRequest]) (*connect.Response[v1.RelaunchAppResponse], error) {
	u.record(r.Msg)
	if u.Err != nil {
		return nil, u.Err
	}
	return connect.NewResponse(&v1.RelaunchAppResponse{Delivered: u.Delivered}), nil
}

// RequestRestart reports Delivered.
func (u *Update) RequestRestart(_ context.Context, r *connect.Request[v1.RequestRestartRequest]) (*connect.Response[v1.RequestRestartResponse], error) {
	u.record(r.Msg)
	if u.Err != nil {
		return nil, u.Err
	}
	return connect.NewResponse(&v1.RequestRestartResponse{Delivered: u.Delivered}), nil
}
