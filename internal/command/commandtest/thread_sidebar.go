package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// SetSidebar returns Current (default: a CONNECTED thread) with the requested id and
// in_sidebar set to shown. No validation: the daemon refuses a thread without a
// creator.
func (s *Thread) SetSidebar(_ context.Context, r *connect.Request[v1.SetThreadSidebarRequest]) (*connect.Response[v1.SetThreadSidebarResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	shown := r.Msg.GetShown()
	cur.InSidebar = &shown
	return connect.NewResponse(&v1.SetThreadSidebarResponse{Thread: cur}), nil
}
