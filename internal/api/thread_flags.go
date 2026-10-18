package api

import (
	"context"
	"fmt"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/types/known/timestamppb"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// Plugins' flags on threads (internal/store/thread/flags.go,
// docs/notes/plugins-3-events-flags-env.md): Thread.flags and ClearFlags. Plugins set them
// through the plugin protocol (thread/setFlag), never through this service.

// flagsToProto maps a thread's flags; the store's Source is the plugin's name.
func flagsToProto(fs []thread.Flag) []*v1.ThreadFlag {
	if len(fs) == 0 {
		return nil
	}
	out := make([]*v1.ThreadFlag, len(fs))
	for i, f := range fs {
		out[i] = &v1.ThreadFlag{
			Plugin: f.Source, PluginDisplayName: f.SourceName, Level: v1.ThreadFlagLevel(f.Level),
			Reason: f.Reason, UntilSeen: f.UntilSeen,
		}
		if !f.SetAt.IsZero() {
			out[i].SetAt = timestamppb.New(f.SetAt)
		}
	}
	return out
}

// ClearFlags removes one plugin's flag from a thread, or every flag.
func (h *Thread) ClearFlags(ctx context.Context, req *connect.Request[v1.ClearThreadFlagsRequest]) (*connect.Response[v1.ClearThreadFlagsResponse], error) {
	m := req.Msg
	s, n, err := h.store.ClearFlags(ctx, m.GetId(), m.GetPlugin())
	if err != nil {
		return nil, threadError(err)
	}
	if n == 0 {
		what := "no flags"
		if m.GetPlugin() != "" {
			what = "no flag of plugin " + m.GetPlugin()
		}
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s has %s", m.GetId(), what))
	}
	return connect.NewResponse(&v1.ClearThreadFlagsResponse{Thread: threadToProto(s), Cleared: int32(n)}), nil
}
