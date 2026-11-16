package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// StopShell returns Current.
func (s *Thread) StopShell(_ context.Context, r *connect.Request[v1.StopThreadShellRequest]) (*connect.Response[v1.StopThreadShellResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.StopThreadShellResponse{Thread: s.current(r.Msg.GetThreadId())}), nil
}

// StopWaiting returns Current.
func (s *Thread) StopWaiting(_ context.Context, r *connect.Request[v1.StopThreadWaitingRequest]) (*connect.Response[v1.StopThreadWaitingResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	if s.StopWaitingErr != nil {
		return nil, s.StopWaitingErr
	}
	return connect.NewResponse(&v1.StopThreadWaitingResponse{Thread: s.current(r.Msg.GetThreadId())}), nil
}

// ClearSnoozeEnded returns Current, idle "at prompt" and cleared when it was needs
// attention "snooze ended"; otherwise as it is, not cleared.
func (s *Thread) ClearSnoozeEnded(_ context.Context, r *connect.Request[v1.ClearSnoozeEndedRequest]) (*connect.Response[v1.ClearSnoozeEndedResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	if cur.GetStatus() != v1.ThreadStatus_THREAD_STATUS_NEEDS_ATTENTION || cur.GetStatusReason() != "snooze ended" {
		return connect.NewResponse(&v1.ClearSnoozeEndedResponse{Thread: cur}), nil
	}
	cur.Status, cur.StatusReason = v1.ThreadStatus_THREAD_STATUS_IDLE, "at prompt"
	return connect.NewResponse(&v1.ClearSnoozeEndedResponse{Thread: cur, Cleared: true}), nil
}
