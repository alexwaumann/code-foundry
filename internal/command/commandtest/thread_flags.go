package commandtest

import (
	"context"
	"slices"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// ClearFlags returns Current without the plugin's flag (every flag with plugin empty)
// and how many went; NOT_FOUND when none did, like the daemon.
func (s *Thread) ClearFlags(_ context.Context, r *connect.Request[v1.ClearThreadFlagsRequest]) (*connect.Response[v1.ClearThreadFlagsResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	before := len(cur.GetFlags())
	cur.Flags = slices.DeleteFunc(cur.Flags, func(f *v1.ThreadFlag) bool {
		return r.Msg.GetPlugin() == "" || f.GetPlugin() == r.Msg.GetPlugin()
	})
	n := before - len(cur.GetFlags())
	if n == 0 {
		return nil, connect.NewError(connect.CodeNotFound, nil)
	}
	return connect.NewResponse(&v1.ClearThreadFlagsResponse{Thread: cur, Cleared: int32(n)}), nil
}
