package api

import (
	"context"
	"errors"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
	"github.com/alexwaumann/code-foundry/internal/fsx"
	"github.com/alexwaumann/code-foundry/internal/store/repo"
)

// Filesystem implements codefoundryv1connect.FilesystemServiceHandler.
type Filesystem struct {
	root  string
	repos repo.Store
}

var _ codefoundryv1connect.FilesystemServiceHandler = (*Filesystem)(nil)

// NewFilesystem returns a FilesystemService handler that completes paths under root
// (the user's home directory, symlinks resolved; see fsx.HomeRoot) and marks the
// registered projects of repos.
func NewFilesystem(root string, repos repo.Store) *Filesystem {
	return &Filesystem{root: root, repos: repos}
}

// Route mounts the service.
func (h *Filesystem) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewFilesystemServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// ListDirectories completes a path prefix to directories under home.
func (h *Filesystem) ListDirectories(_ context.Context, req *connect.Request[v1.ListDirectoriesRequest]) (*connect.Response[v1.ListDirectoriesResponse], error) {
	// A worktree path registers its repository, so it counts as added too.
	registered := map[string]bool{}
	for _, r := range h.repos.Snapshot().Repos {
		registered[r.Path] = true
		for _, w := range r.Worktrees {
			registered[w.Path] = true
		}
	}
	l := fsx.Lister{Root: h.root, Registered: func(p string) bool { return registered[p] }}
	res, err := l.List(req.Msg.GetPrefix())
	if err != nil {
		if errors.Is(err, fsx.ErrInvalidArgument) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &v1.ListDirectoriesResponse{Completion: res.Completion, Truncated: res.Truncated}
	out.Entries = make([]*v1.DirectoryEntry, len(res.Entries))
	for i, e := range res.Entries {
		out.Entries[i] = &v1.DirectoryEntry{Path: e.Path, Name: e.Name, IsGit: e.IsGit, Registered: e.Registered}
	}
	return connect.NewResponse(out), nil
}
