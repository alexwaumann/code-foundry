package command

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// FolderBackend is the slice of ProjectService project.add-workspace needs, in generated
// Connect signatures (see TerminalBackend for why).
type FolderBackend interface {
	InspectFolder(context.Context, *connect.Request[v1.InspectFolderRequest]) (*connect.Response[v1.InspectFolderResponse], error)
	Register(context.Context, *connect.Request[v1.RegisterProjectRequest]) (*connect.Response[v1.RegisterProjectResponse], error)
	List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error)
}

var (
	_ FolderBackend = codefoundryv1connect.ProjectServiceHandler(nil)
	_ FolderBackend = codefoundryv1connect.ProjectServiceClient(nil)
)

// addWorkspaceParallel bounds the Registers project.add-workspace runs at once (each
// reconciles its repository and waits for its status).
const addWorkspaceParallel = 4

// workspaceNameMax is the workspace store's name limit, in bytes.
const workspaceNameMax = 100

// RegisterProjectAddWorkspace registers project.add-workspace: the Add Project dialog's
// "Add as workspace" for a folder of git repositories (docs/notes/workspaces-v2-6-scan.md).
// Nil backends make it fail with Unimplemented.
func RegisterProjectAddWorkspace(r *Registry, projects FolderBackend, workspaces WorkspaceBackend) error {
	if projects == nil {
		projects = codefoundryv1connect.UnimplementedProjectServiceHandler{}
	}
	if workspaces == nil {
		workspaces = codefoundryv1connect.UnimplementedWorkspaceServiceHandler{}
	}
	return r.Register(Command{
		Name:  "project.add-workspace",
		Title: "Add Folder as Workspace",
		Description: "Add a folder of git repositories: every repository directly inside it becomes a project (ones already added are reused), " +
			"and a workspace named after the folder holds them, with the folder as its root (its CLAUDE.md, AGENTS.md and .claude reach " +
			"the workspace's threads, which start there). Refuses a folder that is a git repository or has none inside.",
		Category: "Project",
		Args: []ArgSpec{
			{Name: "folder", Type: Path, Required: true, Positional: true,
				Description: "A folder under home whose immediate subfolders are git repositories"},
		},
		Run: func(ctx context.Context, _ Context, a Args) (Result, error) {
			return addFolderAsWorkspace(ctx, projects, workspaces, a.Path("folder"))
		},
	})
}

func addFolderAsWorkspace(ctx context.Context, projects FolderBackend, workspaces WorkspaceBackend, folder string) (Result, error) {
	ins, err := projects.InspectFolder(ctx, connect.NewRequest(&v1.InspectFolderRequest{Path: folder}))
	if err != nil {
		return Result{}, err
	}
	dir := ins.Msg.GetPath()
	if ins.Msg.GetIsRepo() {
		return Result{}, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("%s is a git repository: add it as a project (`code-foundry project add %s`)", dir, dir))
	}
	children := ins.Msg.GetChildRepos()
	if len(children) == 0 {
		return Result{}, connect.NewError(connect.CodeFailedPrecondition,
			fmt.Errorf("no git repositories directly inside %s: add it as a project (`code-foundry project add %s`)", dir, dir))
	}

	list, err := projects.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return Result{}, err
	}
	known := map[string]*v1.Project{}
	for _, p := range list.Msg.GetProjects() {
		known[p.GetPath()] = p
	}

	// Every child is added (or found); a child that fails does not stop the others, and
	// what was added stays: the projects are useful on their own, and adding the folder
	// again reuses them.
	got := make([]*v1.Project, len(children))
	errs := make([]error, len(children))
	sem := make(chan struct{}, addWorkspaceParallel)
	var wg sync.WaitGroup
	for i, c := range children {
		if p := known[c.GetPath()]; p != nil {
			got[i] = p
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			res, err := projects.Register(ctx, connect.NewRequest(&v1.RegisterProjectRequest{Path: c.GetPath()}))
			if err != nil {
				errs[i] = err
				return
			}
			got[i] = res.Msg.GetProject()
		}()
	}
	wg.Wait()

	var ids, added, reused, failed []string
	var firstErr error
	for i, c := range children {
		if errs[i] != nil {
			failed = append(failed, c.GetName()+": "+connectMessage(errs[i]))
			firstErr = cmp.Or(firstErr, errs[i])
			continue
		}
		p := got[i]
		if known[c.GetPath()] != nil {
			reused = append(reused, p.GetName())
		} else {
			added = append(added, p.GetName())
		}
		// A linked worktree registers its repository, which another child may be.
		if !slices.Contains(ids, p.GetId()) {
			ids = append(ids, p.GetId())
		}
	}
	if len(failed) > 0 {
		slog.WarnContext(ctx, "project.add-workspace: repositories could not be added; no workspace made, the added ones stay",
			"folder", dir, "failed", failed, "added", added)
		msg := fmt.Sprintf("could not add %d of %d repositories in %s (%s); no workspace was made", len(failed), len(children), dir, strings.Join(failed, "; "))
		if len(added) > 0 {
			msg += "; added and kept as projects: " + strings.Join(added, ", ")
		}
		return Result{}, connect.NewError(connect.CodeOf(firstErr), errors.New(msg))
	}

	wsList, err := workspaces.List(ctx, connect.NewRequest(&v1.ListWorkspacesRequest{}))
	if err != nil {
		return Result{}, err
	}
	taken := map[string]bool{}
	for _, w := range wsList.Msg.GetWorkspaces() {
		taken[strings.ToLower(w.GetName())] = true
	}
	name := freeWorkspaceName(filepath.Base(dir), func(n string) bool { return taken[strings.ToLower(n)] })
	res, err := workspaces.Create(ctx, connect.NewRequest(&v1.CreateWorkspaceRequest{
		Name: name, Members: ids, RootPath: dir, DefaultPrimary: "workspace",
	}))
	if err != nil {
		slog.WarnContext(ctx, "project.add-workspace: the workspace was not made; the projects stay", "folder", dir, "added", added, "err", err)
		return Result{}, err
	}
	w := res.Msg.GetWorkspace()
	msg := "created workspace " + describeWorkspace(w)
	if len(reused) > 0 {
		msg += fmt.Sprintf("; added %s, %d already added (%s)", plural(len(added), "project"), len(reused), strings.Join(reused, ", "))
	}
	return Result{Message: msg, JSON: w}, nil
}

// freeWorkspaceName is the name project.add-workspace gives a folder's workspace: the
// folder's name, else "<name> 2", "<name> 3", ... when taken (case-insensitively) or
// reserved ("workspace" names the primary). Control characters become spaces, and the
// name is cut on a rune boundary so the suffix fits the store's 100 bytes.
func freeWorkspaceName(base string, taken func(string) bool) string {
	base = strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return ' '
		}
		return r
	}, base))
	if base == "" || base == "." || base == "/" {
		base = "Workspace"
	}
	free := func(n string) bool { return !taken(n) && !strings.EqualFold(n, "workspace") }
	if len(base) <= workspaceNameMax && free(base) {
		return base
	}
	for n := 2; ; n++ {
		suffix := " " + strconv.Itoa(n)
		c := strings.TrimSpace(cutBytes(base, workspaceNameMax-len(suffix))) + suffix
		if free(c) {
			return c
		}
	}
}

// cutBytes returns the longest prefix of s of at most n bytes that ends on a rune
// boundary.
func cutBytes(s string, n int) string {
	if len(s) <= n {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
