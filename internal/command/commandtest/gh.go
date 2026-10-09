package commandtest

import (
	"context"
	"strconv"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Gh is a fake command.GhBackend. Every call records its request. Err, when set, is
// returned instead of a response. Detail is GetPullRequestDetail's answer (default: a
// pull request titled "t"); Revert is RevertPullRequest's (default: #99); Merge is
// MergePullRequest's (default: see MergePullRequest).
type Gh struct {
	Calls
	Err    error
	Detail *v1.PullRequestDetail
	Revert *v1.RevertPullRequestResponse
	Merge  *v1.MergePullRequestResponse
}

var _ command.GhBackend = (*Gh)(nil)

// GetPullRequestDetail implements command.GhBackend.
func (f *Gh) GetPullRequestDetail(_ context.Context, r *connect.Request[v1.GetPullRequestDetailRequest]) (*connect.Response[v1.GetPullRequestDetailResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	d := &v1.PullRequestDetail{PullRequest: &v1.PullRequest{Number: r.Msg.GetNumber(), Title: "t"}}
	if f.Detail != nil {
		d = proto.CloneOf(f.Detail)
	}
	return connect.NewResponse(&v1.GetPullRequestDetailResponse{Detail: d}), nil
}

// SetReviewRequest implements command.GhBackend. It answers with the login as the only
// pending request when requested, none otherwise.
func (f *Gh) SetReviewRequest(_ context.Context, r *connect.Request[v1.SetReviewRequestRequest]) (*connect.Response[v1.SetReviewRequestResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	res := &v1.SetReviewRequestResponse{}
	if r.Msg.GetRequested() {
		res.Requested = []string{r.Msg.GetLogin()}
	}
	return connect.NewResponse(res), nil
}

// RevertPullRequest implements command.GhBackend.
func (f *Gh) RevertPullRequest(_ context.Context, r *connect.Request[v1.RevertPullRequestRequest]) (*connect.Response[v1.RevertPullRequestResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	res := &v1.RevertPullRequestResponse{Number: 99, Url: "https://github.com/o/r/pull/99"}
	if f.Revert != nil {
		res = proto.CloneOf(f.Revert)
	}
	return connect.NewResponse(res), nil
}

// MergePullRequest implements command.GhBackend: merged, sha "5e1f00d…", and the
// daemon's message for the request (Merge, when set, replaces the answer).
func (f *Gh) MergePullRequest(_ context.Context, r *connect.Request[v1.MergePullRequestRequest]) (*connect.Response[v1.MergePullRequestResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	if f.Merge != nil {
		return connect.NewResponse(proto.CloneOf(f.Merge)), nil
	}
	res := &v1.MergePullRequestResponse{Merged: true, Sha: "5e1f00d5e1f00d5e1f00d5e1f00d5e1f00d5e1f0"}
	res.Message = "Merged #" + strconv.Itoa(int(r.Msg.GetNumber())) + " (5e1f00d)"
	if r.Msg.GetDeleteBranch() {
		res.BranchDeleted = true
		res.Message += "; deleted branch b"
	}
	return connect.NewResponse(res), nil
}
