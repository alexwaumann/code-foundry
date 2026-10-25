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
	"github.com/alexwaumann/code-foundry/internal/preview"
	"github.com/alexwaumann/code-foundry/internal/store/project"
)

// Filesystem implements codefoundryv1connect.FilesystemServiceHandler.
type Filesystem struct {
	root     string
	projects project.Store
	files    *fsx.FileIndex
	grants   *preview.Grants
	// pagesOrigin is where the preview route is served (the daemon's pages listener);
	// PreviewFile's URLs are on it. Empty: root-relative URLs.
	pagesOrigin string
	log         *slog.Logger
}

var _ codefoundryv1connect.FilesystemServiceHandler = (*Filesystem)(nil)

// NewFilesystem returns a FilesystemService handler that completes paths under root
// (the user's home directory, symlinks resolved; see fsx.HomeRoot), marks the
// registered projects, and lists skills (root/.claude for the user's) and
// files of their checkouts. PreviewFile mints its grants in grants, the table the
// preview route (preview.Handler) serves from.
func NewFilesystem(root string, projects project.Store, grants *preview.Grants) *Filesystem {
	log := slog.Default().With("api", "filesystem")
	return &Filesystem{root: root, projects: projects, files: fsx.NewFileIndex(log), grants: grants, log: log}
}

// WithPagesOrigin makes PreviewFile's URLs absolute on origin
// ("http://127.0.0.1:<port>"), the listener that serves the preview route.
func (h *Filesystem) WithPagesOrigin(origin string) *Filesystem {
	h.pagesOrigin = origin
	return h
}

// Route mounts the service.
func (h *Filesystem) Route(opts ...connect.HandlerOption) Route {
	path, handler := codefoundryv1connect.NewFilesystemServiceHandler(h, opts...)
	return Route{Path: path, Handler: handler}
}

// ListDirectories completes a path prefix to directories under home.
func (h *Filesystem) ListDirectories(_ context.Context, req *connect.Request[v1.ListDirectoriesRequest]) (*connect.Response[v1.ListDirectoriesResponse], error) {
	// A worktree path registers its project, so it counts as added too.
	registered := map[string]bool{}
	for _, r := range h.projects.Snapshot().Projects {
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
	add := func(skills []fsx.Skill, scope v1.SkillScope, projectID string) {
		for _, s := range skills {
			out.Skills = append(out.Skills, &v1.Skill{
				Name: s.Name, Description: s.Description, Scope: scope, ProjectId: projectID, Path: s.Path,
			})
		}
	}
	for _, src := range req.Msg.GetSources() {
		dir, _, err := h.checkout(src.GetProjectId(), src.GetPath())
		switch code := connect.CodeOf(err); {
		case err == nil:
		case code == connect.CodeInvalidArgument: // a malformed request, not a missing checkout
			return nil, err
		default: // a removed project or worktree, or one that cannot be resolved: skip it
			h.log.Warn("skill source skipped", "project", src.GetProjectId(), "path", src.GetPath(), "err", err)
			continue
		}
		add(fsx.ReadSkills(filepath.Join(dir, ".claude"), true, h.log), v1.SkillScope_SKILL_SCOPE_PROJECT, src.GetProjectId())
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
	dir, git, err := h.checkout(req.Msg.GetProjectId(), req.Msg.GetPath())
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
// home, an existing directory) or the project's main worktree, and whether to list it
// with git. The project must be registered.
func (h *Filesystem) checkout(projectID, path string) (dir string, git bool, err error) {
	if projectID == "" {
		return "", false, connect.NewError(connect.CodeInvalidArgument, errors.New("project_id is required"))
	}
	r, ok := h.projects.Snapshot().Project(projectID)
	if !ok {
		return "", false, connect.NewError(connect.CodeNotFound, fmt.Errorf("project %s not found", projectID))
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

// ReadFile reads one file under home for the file viewer.
func (h *Filesystem) ReadFile(_ context.Context, req *connect.Request[v1.ReadFileRequest]) (*connect.Response[v1.ReadFileResponse], error) {
	m := req.Msg
	f, err := fsx.ReadFile(h.root, m.GetBaseDir(), m.GetPath(), m.GetMaxBytes())
	if err != nil {
		if errors.Is(err, fsx.ErrInvalidArgument) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	out := &v1.ReadFileResponse{
		Contents: f.Contents, Size: f.Size, Truncated: f.Truncated, Binary: f.Binary, MimeType: f.MIMEType,
		ResolvedPath: f.Path, NotFound: f.NotFound, IsDir: f.IsDir,
	}
	if !f.ModifiedAt.IsZero() {
		out.ModifiedAt = f.ModifiedAt.UnixMilli()
	}
	return connect.NewResponse(out), nil
}

// PreviewFile grants the HTML preview a URL for one file (see package preview): the
// grant's scope is the registered checkout holding the file, else its directory, else
// (home itself, an ancestor of the config home) the file alone. A file in a guarded
// folder (the config home outside its checkouts, ~/.ssh, ~/Library) is refused.
func (h *Filesystem) PreviewFile(_ context.Context, req *connect.Request[v1.PreviewFileRequest]) (*connect.Response[v1.PreviewFileResponse], error) {
	m := req.Msg
	f, err := fsx.ReadFile(h.root, m.GetBaseDir(), m.GetPath(), 1)
	if err != nil {
		if errors.Is(err, fsx.ErrInvalidArgument) {
			return nil, connect.NewError(connect.CodeInvalidArgument, err)
		}
		return nil, connect.NewError(connect.CodeInternal, err)
	}
	switch {
	case f.NotFound:
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("%s does not exist", f.Path))
	case f.IsDir:
		return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("%s is a directory", f.Path))
	}
	// The file, or where its symlinks lead, may be guarded; the route would 404 it.
	if real, err := filepath.EvalSymlinks(f.Path); h.grants.Guarded(f.Path) || (err == nil && h.grants.Guarded(real)) {
		return nil, connect.NewError(connect.CodeInvalidArgument,
			fmt.Errorf("%s is in a protected folder (Code Foundry's own data, credentials or ~/Library), so it cannot be previewed", f.Path))
	}
	scope, single := h.previewScope(f.Path)
	var grant, rel string
	if single {
		grant, err = h.grants.GrantFile(f.Path)
		rel = filepath.Base(f.Path)
	} else if grant, err = h.grants.Grant(scope); err == nil {
		rel, err = filepath.Rel(scope, f.Path)
	}
	if err != nil {
		return nil, connect.NewError(connect.CodeInternal, fmt.Errorf("preview %s: %w", f.Path, err))
	}
	url := h.pagesOrigin + preview.URL(grant, filepath.ToSlash(rel))
	return connect.NewResponse(&v1.PreviewFileResponse{Url: url, Scope: scope, SingleFile: single}), nil
}

// previewScope is what a preview of file may read: the deepest registered project or
// worktree path holding it (so "../assets/app.css" from docs/ resolves), else the file's
// own directory, as long as the grants allow that tree (never home, an ancestor of the
// config home, or a guarded folder). Otherwise it is the file alone (single).
func (h *Filesystem) previewScope(file string) (scope string, single bool) {
	best := ""
	consider := func(p string) {
		if p != "" && len(p) > len(best) && fsx.Within(p, file) && p != file && h.grants.Allows(p) {
			best = p
		}
	}
	for _, r := range h.projects.Snapshot().Projects {
		consider(r.Path)
		for _, w := range r.Worktrees {
			consider(w.Path)
		}
	}
	if best != "" {
		return best, false
	}
	if dir := filepath.Dir(file); h.grants.Allows(dir) {
		return dir, false
	}
	return file, true
}
