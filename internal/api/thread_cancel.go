package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// CancelMessage takes back the user's message Claude has not read
// (internal/store/thread cancel.go).
func (h *Thread) CancelMessage(ctx context.Context, req *connect.Request[v1.CancelThreadMessageRequest]) (*connect.Response[v1.CancelThreadMessageResponse], error) {
	it, err := h.store.CancelMessage(ctx, req.Msg.GetThreadId(), req.Msg.GetItemId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.CancelThreadMessageResponse{Item: itemToProto(it)}), nil
}

// ResendMessage sends a not sent message again (internal/store/thread cancel.go).
func (h *Thread) ResendMessage(ctx context.Context, req *connect.Request[v1.ResendThreadMessageRequest]) (*connect.Response[v1.ResendThreadMessageResponse], error) {
	it, gone, err := h.store.ResendMessage(ctx, req.Msg.GetThreadId(), req.Msg.GetItemId())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.ResendThreadMessageResponse{Item: itemToProto(it), GoneAttachments: gone}), nil
}
