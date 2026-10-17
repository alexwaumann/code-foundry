package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/store/clone"
	"github.com/alexwaumann/code-foundry/internal/store/gh"
)

// The Add Project dialog's GitHub tab: repository search and lookup (the gh store) and
// clone (the clone store).

// WithGitHub sets what SearchGitHub, LookupGitHub and Clone use, and returns h.
func (h *Project) WithGitHub(finder gh.Finder, cloner clone.Service) *Project {
	h.github, h.cloner = finder, cloner
	return h
}

var errNoGitHub = connect.NewError(connect.CodeUnimplemented, errors.New("github search and clone are not configured"))

// SearchGitHub searches github.com repositories.
func (h *Project) SearchGitHub(ctx context.Context, req *connect.Request[v1.SearchGitHubRequest]) (*connect.Response[v1.SearchGitHubResponse], error) {
	if h.github == nil || h.cloner == nil {
		return nil, errNoGitHub
	}
	rs, err := h.github.SearchRepositories(ctx, req.Msg.GetQuery())
	if err != nil {
		return nil, ghError(err)
	}
	out := make([]*v1.GitHubRepository, len(rs))
	for i, r := range rs {
		out[i] = h.githubRepoToProto(r)
	}
	return connect.NewResponse(&v1.SearchGitHubResponse{Repositories: out}), nil
}

// LookupGitHub returns one github.com repository.
func (h *Project) LookupGitHub(ctx context.Context, req *connect.Request[v1.LookupGitHubRequest]) (*connect.Response[v1.LookupGitHubResponse], error) {
	if h.github == nil || h.cloner == nil {
		return nil, errNoGitHub
	}
	r, err := h.github.LookupRepository(ctx, req.Msg.GetOwner(), req.Msg.GetName())
	if err != nil {
		return nil, ghError(err)
	}
	return connect.NewResponse(&v1.LookupGitHubResponse{Repository: h.githubRepoToProto(r)}), nil
}

// Clone clones a github.com repository into the projects directory, streaming its
// output, and ends with the registered project.
func (h *Project) Clone(ctx context.Context, req *connect.Request[v1.CloneProjectRequest], stream *connect.ServerStream[v1.CloneProjectEvent]) error {
	r, err := h.CloneProject(ctx, req.Msg.GetOwner(), req.Msg.GetName(), func(p *v1.CloneProgress) {
		// A failed send means the client went away; ctx is cancelled with it, which
		// stops the clone.
		_ = stream.Send(&v1.CloneProjectEvent{Event: &v1.CloneProjectEvent_Progress{Progress: p}})
	})
	if err != nil {
		return err
	}
	return stream.Send(&v1.CloneProjectEvent{Event: &v1.CloneProjectEvent_Project{Project: r}})
}

// CloneRepo is Clone without the stream, for the repo.clone command: progress gets
// every output line (calls are serialized). Errors are Connect errors.
func (h *Project) CloneProject(ctx context.Context, owner, name string, progress func(*v1.CloneProgress)) (*v1.Project, error) {
	if h.cloner == nil {
		return nil, errNoGitHub
	}
	r, err := h.cloner.Clone(ctx, owner, name, func(p clone.Progress) {
		if progress != nil {
			progress(&v1.CloneProgress{Line: p.Line, Transient: p.Transient})
		}
	})
	if err != nil {
		return nil, cloneError(err)
	}
	return projectToProto(r), nil
}

// CloneRef is CloneRepo for a reference the user typed: owner/repo or an
// https://github.com URL (gh.ParseRepoRef). A malformed one is InvalidArgument. It is
// the repo.clone command's backend (command.CloneFunc).
func (h *Project) CloneRef(ctx context.Context, ref string, progress func(*v1.CloneProgress)) (*v1.Project, error) {
	owner, name, err := gh.ParseRepoRef(ref)
	if err != nil {
		return nil, connect.NewError(connect.CodeInvalidArgument, err)
	}
	return h.CloneProject(ctx, owner, name, progress)
}

func (h *Project) githubRepoToProto(r gh.Repository) *v1.GitHubRepository {
	path, exists := h.cloner.Destination(r.Owner, r.Name)
	return &v1.GitHubRepository{
		Owner: r.Owner, Name: r.Name, Description: r.Description,
		Visibility: enumOf[v1.RepositoryVisibility](v1.RepositoryVisibility_value, "REPOSITORY_VISIBILITY_", r.Visibility),
		IsArchived: r.Archived, IsFork: r.Fork, Url: r.URL,
		ClonePath: path, ClonePathExists: exists,
	}
}

// cloneErrorCodes maps clone store errors to Connect codes, first match wins. Anything
// else (registering the finished clone failed) maps like the project store's errors.
var cloneErrorCodes = []struct {
	err  error
	code connect.Code
}{
	{clone.ErrInvalidArgument, connect.CodeInvalidArgument},
	{clone.ErrExists, connect.CodeAlreadyExists},
	{clone.ErrBusy, connect.CodeFailedPrecondition},
	{clone.ErrOutsideRoot, connect.CodeFailedPrecondition},
	{clone.ErrNotFound, connect.CodeNotFound},
	{clone.ErrFailed, connect.CodeUnknown},
	{context.Canceled, connect.CodeCanceled},
	{context.DeadlineExceeded, connect.CodeDeadlineExceeded},
}

func cloneError(err error) error {
	for _, m := range cloneErrorCodes {
		if errors.Is(err, m.err) {
			return connect.NewError(m.code, err)
		}
	}
	return projectError(err)
}
