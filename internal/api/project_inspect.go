package api

import (
	"context"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// InspectFolder says what Register would make of a folder (project.Store.Inspect): the
// Add Project dialog asks before it adds one, to offer a folder of repos as a workspace.
// The path is expanded like Register's.
func (h *Project) InspectFolder(ctx context.Context, req *connect.Request[v1.InspectFolderRequest]) (*connect.Response[v1.InspectFolderResponse], error) {
	path := req.Msg.GetPath()
	if path != "" {
		p, err := command.ExpandPath(path)
		if err != nil {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		path = p
	}
	f, err := h.store.Inspect(ctx, path)
	if err != nil {
		return nil, projectError(err)
	}
	res := &v1.InspectFolderResponse{Path: f.Path, IsRepo: f.IsRepo}
	for _, c := range f.ChildRepos {
		res.ChildRepos = append(res.ChildRepos, &v1.ChildRepo{Path: c.Path, Name: c.Name})
	}
	return connect.NewResponse(res), nil
}
