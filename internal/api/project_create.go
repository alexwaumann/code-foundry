package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/newproject"
)

// The Add Project dialog's New tab and the Publish to GitHub button: Create, Publish and
// Delete (the project store) and ListPublishOwners (the gh store).

// WithProjects sets what Create, ListPublishOwners, Publish and Delete use, and returns h.
func (h *Project) WithNewProjects(newProjects newproject.Service, owners gh.Owners) *Project {
	h.newProjects, h.owners = newProjects, owners
	return h
}

var errNoNewProjects = connect.NewError(connect.CodeUnimplemented, errors.New("creating and publishing projects is not configured"))

// Create starts a new project in the projects directory.
func (h *Project) Create(ctx context.Context, req *connect.Request[v1.CreateProjectRequest]) (*connect.Response[v1.CreateProjectResponse], error) {
	if h.newProjects == nil {
		return nil, errNoNewProjects
	}
	r, err := h.newProjects.Create(ctx, req.Msg.GetName())
	if err != nil {
		return nil, newProjectError(err)
	}
	return connect.NewResponse(&v1.CreateProjectResponse{Project: projectToProto(r)}), nil
}

// ListPublishOwners lists the accounts the viewer can publish to. With allow_stale, the
// last fetched list is answered however old it is (stale says when it is older than
// the TTL); when nothing was fetched yet, or without allow_stale, a fresh one is fetched.
func (h *Project) ListPublishOwners(ctx context.Context, req *connect.Request[v1.ListPublishOwnersRequest]) (*connect.Response[v1.ListPublishOwnersResponse], error) {
	if h.owners == nil {
		return nil, errNoNewProjects
	}
	var owners []gh.PublishOwner
	var stale, ok bool
	if req.Msg.GetAllowStale() {
		owners, stale, ok = h.owners.CachedPublishOwners(ctx)
	}
	if !ok {
		var err error
		if owners, err = h.owners.PublishOwners(ctx); err != nil {
			return nil, ghError(err)
		}
	}
	out := make([]*v1.PublishOwner, len(owners))
	for i, o := range owners {
		p := &v1.PublishOwner{Login: o.Login, Kind: v1.PublishOwnerKind_PUBLISH_OWNER_KIND_USER, Known: o.Known}
		if o.Org {
			p.Kind = v1.PublishOwnerKind_PUBLISH_OWNER_KIND_ORGANIZATION
		}
		for _, v := range o.Allowed {
			p.Allowed = append(p.Allowed, enumOf[v1.RepositoryVisibility](v1.RepositoryVisibility_value, "REPOSITORY_VISIBILITY_", v))
		}
		out[i] = p
	}
	return connect.NewResponse(&v1.ListPublishOwnersResponse{Owners: out, Stale: stale}), nil
}

// Delete unregisters a project made by Create and removes its folder.
func (h *Project) Delete(ctx context.Context, req *connect.Request[v1.DeleteProjectRequest]) (*connect.Response[v1.DeleteProjectResponse], error) {
	if h.newProjects == nil {
		return nil, errNoNewProjects
	}
	if err := h.newProjects.Delete(ctx, req.Msg.GetId()); err != nil {
		return nil, newProjectError(err)
	}
	return connect.NewResponse(&v1.DeleteProjectResponse{}), nil
}

// visibilityFlags maps the proto visibility to gh's flag spelling.
var visibilityFlags = map[v1.RepositoryVisibility]newproject.Visibility{
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC:   newproject.Public,
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_INTERNAL: newproject.Internal,
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PRIVATE:  newproject.Private,
}

// Publish creates the project's GitHub repository and pushes it.
func (h *Project) Publish(ctx context.Context, req *connect.Request[v1.PublishProjectRequest]) (*connect.Response[v1.PublishProjectResponse], error) {
	if h.newProjects == nil {
		return nil, errNoNewProjects
	}
	m := req.Msg
	vis, ok := visibilityFlags[m.GetVisibility()]
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("visibility must be public, internal or private"))
	}
	r, err := h.newProjects.Publish(ctx, newproject.PublishOptions{ProjectID: m.GetProjectId(), Owner: m.GetOwner(), Name: m.GetName(), Visibility: vis})
	if err != nil {
		return nil, newProjectError(err)
	}
	return connect.NewResponse(&v1.PublishProjectResponse{Project: projectToProto(r)}), nil
}

// projectErrorCodes maps project store errors to Connect codes, first match wins.
// Anything else (registering or refreshing failed) maps like the repo store's errors.
var newProjectErrorCodes = []struct {
	err  error
	code connect.Code
}{
	{newproject.ErrInvalidArgument, connect.CodeInvalidArgument},
	{newproject.ErrExists, connect.CodeAlreadyExists},
	{newproject.ErrOutsideRoot, connect.CodeFailedPrecondition},
	{newproject.ErrNotFound, connect.CodeNotFound},
	{newproject.ErrFailedPrecondition, connect.CodeFailedPrecondition},
	{newproject.ErrFailed, connect.CodeUnknown},
	{context.Canceled, connect.CodeCanceled},
	{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
}

// projectError maps err to a Connect error. A gh failure's message is gh's own words.
func newProjectError(err error) error {
	for _, m := range newProjectErrorCodes {
		if errors.Is(err, m.err) {
			return connect.NewError(m.code, err)
		}
	}
	return projectError(err)
}
