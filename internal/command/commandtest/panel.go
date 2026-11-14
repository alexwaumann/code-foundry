package commandtest

import (
	"context"
	"path/filepath"
	"slices"

	"connectrpc.com/connect"

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
	// Contents are a file's contents by path (default "x").
	Contents map[string]string
	// OutsideHome are the Files read as outside the home directory.
	OutsideHome []string
	// Mime are a file's MIME types by path (default none).
	Mime map[string]string
	// Modified are a file's modification times by path, unix milliseconds (default 0).
	Modified map[string]int64
	// Size are a file's sizes by path, over what its contents say.
	Size map[string]int64
	// Errs are the paths whose read fails, with how.
	Errs map[string]error
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
	if err := f.Errs[res.ResolvedPath]; err != nil {
		return nil, err
	}
	switch {
	case slices.Contains(f.Files, res.ResolvedPath):
		res.Contents, res.Size = []byte("x"), 1
		res.OutsideHome = slices.Contains(f.OutsideHome, res.ResolvedPath)
		if c, ok := f.Contents[res.ResolvedPath]; ok {
			res.Contents, res.Size = []byte(c), int64(len(c))
		}
		res.MimeType, res.ModifiedAt = f.Mime[res.ResolvedPath], f.Modified[res.ResolvedPath]
		if n, ok := f.Size[res.ResolvedPath]; ok {
			res.Size = n
		}
	case slices.Contains(f.Dirs, res.ResolvedPath):
		res.IsDir = true
	default:
		res.NotFound = true
	}
	return connect.NewResponse(res), nil
}

// FileDiffs is a fake command.WorktreeComparer answering Res (default: each path asked for
// changed, or one file without any).
type FileDiffs struct {
	Calls
	Err error
	Res *v1.CompareWorktreeResponse
	// Unlisted, when set, says which asked paths a comparison does not list (by its base ref,
	// for a ref base: "" otherwise); they are left out of the default response.
	Unlisted func(baseRef, path string) bool
	// During, when set, runs inside each comparison, before it answers (a test's change made
	// while the daemon compares).
	During func(*v1.CompareWorktreeRequest)
}

var _ command.WorktreeComparer = (*FileDiffs)(nil)

// CompareWorktree returns Res.
func (f *FileDiffs) CompareWorktree(_ context.Context, r *connect.Request[v1.CompareWorktreeRequest]) (*connect.Response[v1.CompareWorktreeResponse], error) {
	f.record(r.Msg)
	if f.During != nil {
		f.During(r.Msg)
	}
	if f.Err != nil {
		return nil, f.Err
	}
	if f.Res != nil {
		return connect.NewResponse(f.Res), nil
	}
	res := &v1.CompareWorktreeResponse{
		BaseRef: "origin/main", MergeBase: "abc",
		Base: &v1.ResolvedDiffSource{Label: "origin/main"}, Head: &v1.ResolvedDiffSource{Label: "Working tree"},
	}
	for _, p := range r.Msg.GetPaths() {
		if f.Unlisted != nil && f.Unlisted(r.Msg.GetBase().GetRef(), p) {
			res.UnmatchedPaths = append(res.UnmatchedPaths, p)
			continue
		}
		res.Files = append(res.Files, &v1.CompareFile{Path: p, Status: "M"})
	}
	if len(res.Files) == 0 && len(res.UnmatchedPaths) == 0 {
		res.Files = []*v1.CompareFile{{Path: "a.go", Status: "M"}}
	}
	return connect.NewResponse(res), nil
}
