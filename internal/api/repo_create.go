package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// The Add Project dialog's New tab and the Publish to GitHub button: Create (the
// project store), ListPublishOwners (the gh store) and Publish (the project store).

// WithProjects sets what Create, ListPublishOwners and Publish use, and returns h.
func (h *Repo) WithProjects(projects project.Service, owners gh.Owners) *Repo {
	h.projects, h.owners = projects, owners
	return h
}

var errNoProjects = connect.NewError(connect.CodeUnimplemented, errors.New("creating and publishing projects is not configured"))

// Create starts a new project in the projects directory.
func (h *Repo) Create(ctx context.Context, req *connect.Request[v1.CreateRepoRequest]) (*connect.Response[v1.CreateRepoResponse], error) {
	if h.projects == nil {
		return nil, errNoProjects
	}
	r, err := h.projects.Create(ctx, req.Msg.GetName())
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.CreateRepoResponse{Repo: repoToProto(r)}), nil
}

// ListPublishOwners lists the accounts the viewer can publish to.
func (h *Repo) ListPublishOwners(ctx context.Context, _ *connect.Request[v1.ListPublishOwnersRequest]) (*connect.Response[v1.ListPublishOwnersResponse], error) {
	if h.owners == nil {
		return nil, errNoProjects
	}
	owners, err := h.owners.PublishOwners(ctx)
	if err != nil {
		return nil, ghError(err)
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
	return connect.NewResponse(&v1.ListPublishOwnersResponse{Owners: out}), nil
}

// visibilityFlags maps the proto visibility to gh's flag spelling.
var visibilityFlags = map[v1.RepositoryVisibility]project.Visibility{
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PUBLIC:   project.Public,
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_INTERNAL: project.Internal,
	v1.RepositoryVisibility_REPOSITORY_VISIBILITY_PRIVATE:  project.Private,
}

// Publish creates the project's GitHub repository and pushes it.
func (h *Repo) Publish(ctx context.Context, req *connect.Request[v1.PublishRepoRequest]) (*connect.Response[v1.PublishRepoResponse], error) {
	if h.projects == nil {
		return nil, errNoProjects
	}
	m := req.Msg
	vis, ok := visibilityFlags[m.GetVisibility()]
	if !ok {
		return nil, connect.NewError(connect.CodeInvalidArgument, errors.New("visibility must be public, internal or private"))
	}
	r, err := h.projects.Publish(ctx, project.PublishOptions{RepoID: m.GetRepoId(), Owner: m.GetOwner(), Name: m.GetName(), Visibility: vis})
	if err != nil {
		return nil, projectError(err)
	}
	return connect.NewResponse(&v1.PublishRepoResponse{Repo: repoToProto(r)}), nil
}

// projectErrorCodes maps project store errors to Connect codes, first match wins.
// Anything else (registering or refreshing failed) maps like the repo store's errors.
var projectErrorCodes = []struct {
	err  error
	code connect.Code
}{
	{project.ErrInvalidArgument, connect.CodeInvalidArgument},
	{project.ErrExists, connect.CodeAlreadyExists},
	{project.ErrOutsideRoot, connect.CodeFailedPrecondition},
	{project.ErrNotFound, connect.CodeNotFound},
	{project.ErrFailedPrecondition, connect.CodeFailedPrecondition},
	{project.ErrFailed, connect.CodeUnknown},
	{context.Canceled, connect.CodeCanceled},
	{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
}

// projectError maps err to a Connect error. A gh failure's message is gh's own words.
func projectError(err error) error {
	for _, m := range projectErrorCodes {
		if errors.Is(err, m.err) {
			return connect.NewError(m.code, err)
		}
	}
	return repoError(err)
}
