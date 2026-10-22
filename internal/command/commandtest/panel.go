package commandtest

import (
	"context"
	"path/filepath"
	"slices"

	"connectrpc.com/connect"
	"google.golang.org/protobuf/proto"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/internal/command"
)

// Files is a fake command.FileReader over a set of paths: Dirs are directories, Files
// regular files; anything else is not found. A relative path is joined to base_dir.
type Files struct {
	Calls
	Err   error
	Files []string
	Dirs  []string
}

var _ command.FileReader = (*Files)(nil)

// ReadFile answers with the resolved path and whether it is a file, a directory or
// nothing.
func (f *Files) ReadFile(_ context.Context, r *connect.Request[v1.ReadFileRequest]) (*connect.Response[v1.ReadFileResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	p := r.Msg.GetPath()
	if !filepath.IsAbs(p) {
		p = filepath.Join(r.Msg.GetBaseDir(), p)
	}
	res := &v1.ReadFileResponse{ResolvedPath: filepath.Clean(p)}
	switch {
	case slices.Contains(f.Files, res.ResolvedPath):
		res.Contents, res.Size = []byte("x"), 1
	case slices.Contains(f.Dirs, res.ResolvedPath):
		res.IsDir = true
	default:
		res.NotFound = true
	}
	return connect.NewResponse(res), nil
}

// FileDiffs is a fake command.FileDiffer answering Res (default: a modified file).
type FileDiffs struct {
	Calls
	Err error
	Res *v1.GetWorktreeFileDiffResponse
}

var _ command.FileDiffer = (*FileDiffs)(nil)

// GetWorktreeFileDiff returns Res.
func (f *FileDiffs) GetWorktreeFileDiff(_ context.Context, r *connect.Request[v1.GetWorktreeFileDiffRequest]) (*connect.Response[v1.GetWorktreeFileDiffResponse], error) {
	f.record(r.Msg)
	if f.Err != nil {
		return nil, f.Err
	}
	if f.Res == nil {
		return connect.NewResponse(&v1.GetWorktreeFileDiffResponse{Status: "M", BaseRef: "origin/main"}), nil
	}
	return connect.NewResponse(proto.CloneOf(f.Res)), nil
}
