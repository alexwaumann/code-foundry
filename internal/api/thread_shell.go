package api

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// StopShell stops one of a thread's own background shells (internal/store/thread/servers.go;
// docs/notes/thread-servers.md).
func (h *Thread) StopShell(ctx context.Context, req *connect.Request[v1.StopThreadShellRequest]) (*connect.Response[v1.StopThreadShellResponse], error) {
	s, err := h.store.StopShell(ctx, req.Msg.GetThreadId(), req.Msg.GetTaskId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.StopThreadShellResponse{Thread: threadToProto(s)}), nil
}

// backgroundShellsToProto is Thread.background_shells.
func backgroundShellsToProto(shells []thread.BackgroundShell) []*v1.BackgroundShell {
	if len(shells) == 0 {
		return nil
	}
	out := make([]*v1.BackgroundShell, 0, len(shells))
	for _, sh := range shells {
		p := &v1.BackgroundShell{TaskId: sh.TaskID, Description: sh.Description, Command: sh.Command}
		if !sh.StartedAt.IsZero() {
			p.StartedAt = timestamppb.New(sh.StartedAt)
		}
		for _, port := range sh.Ports {
			p.Ports = append(p.Ports, uint32(port))
		}
		out = append(out, p)
	}
	return out
}
