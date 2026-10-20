package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// Hidden children (docs/notes/hidden-children-1-daemon.md): Thread.in_sidebar, the
// SetSidebar handler. The store validates and publishes; the rule a client applies
// with the threads.show_created_threads setting is on the proto field.

// optionalBool copies an optional bool (a fresh pointer: the store's is shared by
// snapshots, the proto's by its message).
func optionalBool(b *bool) *bool {
	if b == nil {
		return nil
	}
	v := *b
	return &v
}

// SetSidebar shows or hides a thread another thread created in the sidebar.
func (h *Thread) SetSidebar(ctx context.Context, req *connect.Request[v1.SetThreadSidebarRequest]) (*connect.Response[v1.SetThreadSidebarResponse], error) {
	s, err := h.store.SetSidebar(ctx, req.Msg.GetId(), req.Msg.GetShown())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetThreadSidebarResponse{Thread: threadToProto(s)}), nil
}
