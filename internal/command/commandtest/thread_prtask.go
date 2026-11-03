package commandtest

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
)

// PullRequestOwner answers Owners[id], else id itself.
func (s *Thread) PullRequestOwner(_ context.Context, r *connect.Request[v1.PullRequestOwnerRequest]) (*connect.Response[v1.PullRequestOwnerResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	owner, ok := s.Owners[r.Msg.GetId()]
	if !ok {
		owner = r.Msg.GetId()
	}
	return connect.NewResponse(&v1.PullRequestOwnerResponse{OwnerThreadId: owner}), nil
}

// AddNote echoes the note as an item "i-note".
func (s *Thread) AddNote(_ context.Context, r *connect.Request[v1.AddThreadNoteRequest]) (*connect.Response[v1.AddThreadNoteResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.AddThreadNoteResponse{Item: &v1.ThreadItem{Id: "i-note"}}), nil
}
