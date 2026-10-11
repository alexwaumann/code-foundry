package api

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

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
	files *fsx.FileIndex
	log   *slog.Logger
}

var _ codefoundryv1connect.FilesystemServiceHandler = (*Filesystem)(nil)

// NewFilesystem returns a FilesystemService handler that completes paths under root
// (the user's home directory, symlinks resolved; see fsx.HomeRoot), marks the
// registered projects of repos, and lists skills (root/.claude for the user's) and
// files of their checkouts.
func NewFilesystem(root string, repos repo.Store) *Filesystem {
	log := slog.Default().With("api", "filesystem")
	return &Filesystem{root: root, repos: repos, files: fsx.NewFileIndex(log), log: log}
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

// ListSkills lists project skills of each source checkout, then the user's. A source
// whose project or checkout is gone is skipped (the composer may hold a stale one); a
// malformed one fails the request.
func (h *Filesystem) ListSkills(_ context.Context, req *connect.Request[v1.ListSkillsRequest]) (*connect.Response[v1.ListSkillsResponse], error) {
	out := &v1.ListSkillsResponse{}
	add := func(skills []fsx.Skill, scope v1.SkillScope, repoID string) {
		for _, s := range skills {
			out.Skills = append(out.Skills, &v1.Skill{
				Name: s.Name, Description: s.Description, Scope: scope, RepoId: repoID, Path: s.Path,
			})
		}
	}
	for _, src := range req.Msg.GetSources() {
		dir, _, err := h.checkout(src.GetRepoId(), src.GetPath())
		switch code := connect.CodeOf(err); {
		case err == nil:
		case code == connect.CodeInvalidArgument: // a malformed request, not a missing checkout
			return nil, err
		default: // a removed project or worktree, or one that cannot be resolved: skip it
			h.log.Warn("skill source skipped", "repo", src.GetRepoId(), "path", src.GetPath(), "err", err)
			continue
		}
		add(fsx.ReadSkills(filepath.Join(dir, ".claude"), true, h.log), v1.SkillScope_SKILL_SCOPE_PROJECT, src.GetRepoId())
	}
	if req.Msg.GetIncludeUser() {
		add(fsx.ReadSkills(filepath.Join(h.root, ".claude"), false, h.log), v1.SkillScope_SKILL_SCOPE_USER, "")
	}
	return connect.NewResponse(out), nil
}

// SearchFiles fuzzy-matches a query against one checkout's files and directories.
func (h *Filesystem) SearchFiles(ctx context.Context, req *connect.Request[v1.SearchFilesRequest]) (*connect.Response[v1.SearchFilesResponse], error) {
	if req.Msg.GetLimit() < 0 {
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("limit %d is negative", req.Msg.GetLimit()))
	}
	dir, git, err := h.checkout(req.Msg.GetRepoId(), req.Msg.GetPath())
	if err != nil {
		return nil, err
	}
	matches, truncated, err := h.files.Search(ctx, dir, git, req.Msg.GetQuery(), int(req.Msg.GetLimit()))
	switch {
	case err == nil:
	case errors.Is(err, context.Canceled): // the client gave up; the listing goes on
		return nil, connect.NewError(connect.CodeCanceled, err)
	case errors.Is(err, context.DeadlineExceeded):
		return nil, connect.NewError(connect.CodeDeadlineExceeded, err)
	default:
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &v1.SearchFilesResponse{Truncated: truncated, Matches: make([]*v1.FileMatch, len(matches))}
	for i, m := range matches {
		out.Matches[i] = &v1.FileMatch{Path: m.Path, IsDir: m.IsDir}
	}
	return connect.NewResponse(out), nil
}

// checkout resolves a request's checkout: path (absolute, symlinks resolved, under
// home, an existing directory) or the repo's main worktree, and whether to list it
// with git. The repo must be registered.
func (h *Filesystem) checkout(repoID, path string) (dir string, git bool, err error) {
	if repoID == "" {
		return "", false, connect.NewError(connect.CodeInvalidArgument, errors.New("repo_id is required"))
	}
	r, ok := h.repos.Snapshot().Repo(repoID)
	if !ok {
		return "", false, connect.NewError(connect.CodeNotFound, fmt.Errorf("repo %s not found", repoID))
	}
	dir = cmp.Or(path, r.Path)
	if !filepath.IsAbs(dir) {
		return "", false, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("path %q must be absolute", dir))
	}
	real, err := filepath.EvalSymlinks(filepath.Clean(dir))
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			if !fsx.Within(h.root, filepath.Clean(dir)) {
				return "", false, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is outside your home directory", dir))
			}
			return "", false, connect.NewError(connect.CodeNotFound, fmt.Errorf("checkout %s does not exist", dir))
		}
		return "", false, connect.NewError(connect.CodeInternal, fmt.Errorf("checkout %s: %w", dir, err))
	}
	if !fsx.Within(h.root, real) {
		return "", false, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is outside your home directory", dir))
	}
	if fi, err := os.Stat(real); err != nil || !fi.IsDir() {
		return "", false, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is not a directory", dir))
	}
	// A project without git has one checkout, its path; any other path is a worktree
	// of a git repository (or, briefly, a project that just got .git).
	git = r.Git
	if !git && path != "" && !strings.EqualFold(real, r.Path) {
		_, statErr := os.Lstat(filepath.Join(real, ".git"))
		git = statErr == nil
	}
	return real, git, nil
}
