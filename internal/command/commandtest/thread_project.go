package commandtest

import (
	"context"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/thread"
)

// AddProject returns Current (default: a CONNECTED thread) with the requested id, the
// project appended to project_ids and workspace_id cleared, as the daemon leaves the
// workspace. No validation.
func (s *Thread) AddProject(_ context.Context, r *connect.Request[v1.AddThreadProjectRequest]) (*connect.Response[v1.AddThreadProjectResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.ProjectIds = append(cur.ProjectIds, r.Msg.GetProject())
	cur.WorkspaceId = ""
	return connect.NewResponse(&v1.AddThreadProjectResponse{Thread: cur}), nil
}

// RemoveProject returns Current with the project dropped from project_ids and
// workspace_id cleared. No validation.
func (s *Thread) RemoveProject(_ context.Context, r *connect.Request[v1.RemoveThreadProjectRequest]) (*connect.Response[v1.RemoveThreadProjectResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	cur := s.current(r.Msg.GetId())
	cur.ProjectIds = slices.DeleteFunc(cur.ProjectIds, func(id string) bool { return id == r.Msg.GetProject() })
	cur.WorkspaceId = ""
	return connect.NewResponse(&v1.RemoveThreadProjectResponse{Thread: cur}), nil
}

// LinkPullRequest returns Current with a link to the pull request appended (slug and
// number read from an "owner/name#N" or …/pull/N reference; anything else is
// INVALID_ARGUMENT), or linked false when its URL is already there.
func (s *Thread) LinkPullRequest(_ context.Context, r *connect.Request[v1.LinkThreadPullRequestRequest]) (*connect.Response[v1.LinkThreadPullRequestResponse], error) {
	if err := s.do(r.Msg); err != nil {
		return nil, err
	}
	slug, n, err := thread.ParsePullRequestLink(r.Msg.GetPullRequest())
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	cur := s.current(r.Msg.GetId())
	l := &v1.LinkedPullRequest{Slug: slug, Number: int32(n), Url: "https://github.com/" + slug + "/pull/" + strconv.Itoa(n)}
	for _, x := range cur.GetLinkedPullRequests() {
		if strings.EqualFold(x.GetUrl(), l.GetUrl()) {
			return connect.NewResponse(&v1.LinkThreadPullRequestResponse{Thread: cur, Link: x}), nil
		}
	}
	cur.LinkedPullRequests = append(cur.LinkedPullRequests, l)
	return connect.NewResponse(&v1.LinkThreadPullRequestResponse{Thread: cur, Linked: true, Link: l}), nil
}
