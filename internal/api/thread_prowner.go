package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PullRequestOwner names the thread whose own link a thread's link to a pull request is
// (docs/notes/pr-task-forward.md).
func (h *Thread) PullRequestOwner(ctx context.Context, req *connect.Request[v1.PullRequestOwnerRequest]) (*connect.Response[v1.PullRequestOwnerResponse], error) {
	owner, err := h.store.PullRequestOwner(ctx, req.Msg.GetId(), req.Msg.GetRepoSlugs(), int(req.Msg.GetNumber()))
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.PullRequestOwnerResponse{OwnerThreadId: owner}), nil
}

// AddNote puts a note in a thread's conversation (no turn starts).
func (h *Thread) AddNote(ctx context.Context, req *connect.Request[v1.AddThreadNoteRequest]) (*connect.Response[v1.AddThreadNoteResponse], error) {
	it, err := h.store.AddNote(ctx, req.Msg.GetThreadId(), req.Msg.GetText())
	if err != nil {
		return nil, threadError(err)
	}
	return connect.NewResponse(&v1.AddThreadNoteResponse{Item: itemToProto(it)}), nil
}
