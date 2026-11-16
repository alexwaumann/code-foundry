package api

import (
	"context"
	"errors"
	"fmt"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/notification"
)

// Plugins' flags on threads are notifications now (docs/notes/plugin-flag-retirement.md):
// Thread.flags is left empty, and ClearFlags dismisses the thread's flag notifications,
// as the user would in the bell. Plugins set them through the plugin protocol
// (thread/setFlag), never through this service.

// WithNotifications gives ClearFlags the notification store that holds the flags.
func (h *Thread) WithNotifications(s notification.Store) *Thread {
	h.notes = s
	return h
}

// ClearFlags dismisses one plugin's flag on a thread, or every flag.
func (h *Thread) ClearFlags(ctx context.Context, req *connect.Request[v1.ClearThreadFlagsRequest]) (*connect.Response[v1.ClearThreadFlagsResponse], error) {
	m := req.Msg
	s, err := h.store.Get(ctx, m.GetId())
	if err != nil {
		return nil, threadError(err)
	}
	if h.notes == nil {
		return nil, connect.NewError(connect.CodeUnimplemented, errors.New("this daemon has no notifications"))
	}
	gone, err := notification.DismissFlags(ctx, h.notes, s.ID, m.GetPlugin())
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	if len(gone) == 0 {
		what := "no flags"
		if m.GetPlugin() != "" {
			what = "no flag of plugin " + m.GetPlugin()
		}
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("thread %s has %s", m.GetId(), what))
	}
	return connect.NewResponse(&v1.ClearThreadFlagsResponse{Thread: threadToProto(s), Cleared: int32(len(gone))}), nil
}
