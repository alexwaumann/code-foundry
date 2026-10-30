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
