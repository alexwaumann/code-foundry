package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Restart restarts a running thread's Claude with the same conversation; Thread
// carries plugin_env_stale and plugin_env_change (internal/store/thread/envstale.go,
// restart.go; docs/notes/plugins-env-restart.md).
func (h *Thread) Restart(ctx context.Context, req *connect.Request[v1.RestartThreadRequest]) (*connect.Response[v1.RestartThreadResponse], error) {
	s, restarted, err := h.store.Restart(ctx, req.Msg.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.RestartThreadResponse{Thread: threadToProto(s), Restarted: restarted}), nil
}
