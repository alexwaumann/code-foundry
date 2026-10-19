package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Restart returns Current; restarted when it is CONNECTED or STARTING (then without
// plugin_env_stale), like the daemon.
func (s *Thread) Restart(_ context.Context, r *connect.Request[v1.RestartThreadRequest]) (*connect.Response[v1.RestartThreadResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	st := cur.GetState()
	restarted := st == v1.ThreadState_THREAD_STATE_CONNECTED || st == v1.ThreadState_THREAD_STATE_STARTING
	if restarted {
		cur.PluginEnvStale, cur.PluginEnvChange = false, ""
	}
	return connect.NewResponse(&v1.RestartThreadResponse{Thread: cur, Restarted: restarted}), nil
}
