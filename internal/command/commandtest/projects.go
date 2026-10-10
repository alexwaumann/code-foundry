package commandtest

import (
	"context"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Projects is a fake command.ProjectBackend. Err, when set, is returned by every call.
// Create answers a git project under /p; Publish answers the project with origin and
// the owner/name slug.
type Projects struct {
	Calls
	Err error
}

var _ command.ProjectBackend = (*Projects)(nil)

// Create records the request.
func (f *Projects) Create(_ context.Context, r *connect.Request[v1.CreateRepoRequest]) (*connect.Response[v1.CreateRepoResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	name := r.Msg.GetName()
	return connect.NewResponse(&v1.CreateRepoResponse{Repo: &v1.Repo{Id: "repo-" + name, Name: name, Path: "/p/" + name, Git: true}}), nil
}

// Publish records the request.
func (f *Projects) Publish(_ context.Context, r *connect.Request[v1.PublishRepoRequest]) (*connect.Response[v1.PublishRepoResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	name := r.Msg.GetName()
	if name == "" {
		name = "demo"
	}
	return connect.NewResponse(&v1.PublishRepoResponse{Repo: &v1.Repo{Id: r.Msg.GetRepoId(), Name: "demo", Git: true,
		Remotes: []string{"origin"}, GithubSlug: strings.ToLower(r.Msg.GetOwner() + "/" + name)}}), nil
}
