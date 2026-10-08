package commandtest

import (
	"context"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// GitOps is a fake command.GitOpsBackend. Every call records its request and returns a
// copy of Op (default: a succeeded op with summary "ok"). Err, when set, is returned
// instead.
type GitOps struct {
	Calls
	Err error
	Op  *v1.GitOp
}

var _ command.GitOpsBackend = (*GitOps)(nil)

func (f *GitOps) op(req proto.Message) (*v1.GitOp, error) {
	f.record(req)
	if f.Err != nil {
		return nil, f.Err
	}
	if f.Op != nil {
		return proto.CloneOf(f.Op), nil
	}
	return &v1.GitOp{Id: "op-1", State: v1.GitOpState_GIT_OP_STATE_SUCCEEDED, Summary: "ok"}, nil
}

// Fetch implements command.GitOpsBackend.
func (f *GitOps) Fetch(_ context.Context, r *connect.Request[v1.GitFetchRequest]) (*connect.Response[v1.GitFetchResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GitFetchResponse{Op: op}), nil
}

// Pull implements command.GitOpsBackend.
func (f *GitOps) Pull(_ context.Context, r *connect.Request[v1.GitPullRequest]) (*connect.Response[v1.GitPullResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GitPullResponse{Op: op}), nil
}

// Push implements command.GitOpsBackend.
func (f *GitOps) Push(_ context.Context, r *connect.Request[v1.GitPushRequest]) (*connect.Response[v1.GitPushResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.GitPushResponse{Op: op}), nil
}

// CreatePullRequest implements command.GitOpsBackend.
func (f *GitOps) CreatePullRequest(_ context.Context, r *connect.Request[v1.CreatePullRequestRequest]) (*connect.Response[v1.CreatePullRequestResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.CreatePullRequestResponse{Op: op}), nil
}

// OpenPullRequest implements command.GitOpsBackend.
func (f *GitOps) OpenPullRequest(_ context.Context, r *connect.Request[v1.OpenPullRequestRequest]) (*connect.Response[v1.OpenPullRequestResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.OpenPullRequestResponse{Op: op}), nil
}

// OpenEditor implements command.GitOpsBackend.
func (f *GitOps) OpenEditor(_ context.Context, r *connect.Request[v1.OpenEditorRequest]) (*connect.Response[v1.OpenEditorResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.OpenEditorResponse{Op: op}), nil
}

// Reveal implements command.GitOpsBackend.
func (f *GitOps) Reveal(_ context.Context, r *connect.Request[v1.RevealRequest]) (*connect.Response[v1.RevealResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.RevealResponse{Op: op}), nil
}

// OpenUrl implements command.GitOpsBackend.
func (f *GitOps) OpenUrl(_ context.Context, r *connect.Request[v1.OpenUrlRequest]) (*connect.Response[v1.OpenUrlResponse], error) {
	op, err := f.op(r.Msg)
	if err != nil {
		return nil, err
	}
	return connect.NewResponse(&v1.OpenUrlResponse{Op: op}), nil
}
