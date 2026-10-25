package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PageStorage implements ThreadService: what the thread's pages keep with cf.storage
// (docs/notes/bridge-fix-storage.md).
func (h *Thread) PageStorage(ctx context.Context, req *connect.Request[v1.PageStorageRequest]) (*connect.Response[v1.PageStorageResponse], error) {
	vals, err := h.store.PageStorage(ctx, req.Msg.GetThreadId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.PageStorageResponse{Values: vals}), nil
}

// SetPageStorage implements ThreadService: one key set or removed, the storage after.
func (h *Thread) SetPageStorage(ctx context.Context, req *connect.Request[v1.SetPageStorageRequest]) (*connect.Response[v1.SetPageStorageResponse], error) {
	m := req.Msg
	vals, err := h.store.SetPageStorage(ctx, m.GetThreadId(), m.GetKey(), m.Value)
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.SetPageStorageResponse{Values: vals}), nil
}
