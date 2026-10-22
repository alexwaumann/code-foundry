package command

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strconv"
	"strings"

	"connectrpc.com/connect"

	v1 "github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1"
	"github.com/alexwaumann/code-foundry/gen/go/codefoundry/v1/codefoundryv1connect"
)

// The panel verbs that open one item in a thread's side panel: a file (File tab), a
// changed file's diff (Diff tab) and a pull request (Pull request tab)
// (docs/notes/control-5-fixes.md). They are always scoped to a thread, the app's
// selection included (its context names it): the item is the thread's. Each checks the
// item first, so a call that would show nothing fails instead.

// ShowView names of the item verbs. Their ShowView carries the item in params.
const (
	// ViewPanelFile opens a file's File tab: params path (absolute), line (1-based,
	// optional), project and base (the thread's project and checkout).
	ViewPanelFile = "panel.file"
	// ViewPanelDiff opens a changed file's Diff tab: params project, worktree, path
	// (worktree-relative) and scope ("working" | "branch").
	ViewPanelDiff = "panel.diff"
	// ViewPanelPR opens a pull request's tab: params slug ("owner/name") and number.
	ViewPanelPR = "panel.pr"
)

// FileReader reads a file the way the File tab does (FilesystemService.ReadFile): under
// the home directory only, relative paths against a base directory.
type FileReader interface {
	ReadFile(context.Context, *connect.Request[v1.ReadFileRequest]) (*connect.Response[v1.ReadFileResponse], error)
}

// FileDiffer reads one file's diff in a worktree the way the Diff tab does
// (ProjectService.GetWorktreeFileDiff).
type FileDiffer interface {
	GetWorktreeFileDiff(context.Context, *connect.Request[v1.GetWorktreeFileDiffRequest]) (*connect.Response[v1.GetWorktreeFileDiffResponse], error)
}

// ProjectLister lists the registered projects (ProjectService.List).
type ProjectLister interface {
	List(context.Context, *connect.Request[v1.ListProjectsRequest]) (*connect.Response[v1.ListProjectsResponse], error)
}

var (
	_ FileReader    = codefoundryv1connect.FilesystemServiceHandler(nil)
	_ FileDiffer    = codefoundryv1connect.ProjectServiceHandler(nil)
	_ ProjectLister = codefoundryv1connect.ProjectServiceHandler(nil)
)

// diffScopes are view.panel.diff's --scope values.
var diffScopes = map[string]v1.DiffScope{
	"working": v1.DiffScope_DIFF_SCOPE_WORKING,
	"branch":  v1.DiffScope_DIFF_SCOPE_BRANCH,
}

// itemCommands are view.panel.file, view.panel.diff and view.panel.pr.
func (d ViewDeps) itemCommands() []Command {
	focus := panelThreadArgs()[1]
	thread := ArgSpec{
		Name: "thread", Type: String, Context: ContextThread, ID: ThreadID,
		Description: "Thread whose side panel it opens in, without changing what any window shows " +
			"(default: the thread this runs in, $CODE_FOUNDRY_THREAD; in the app: the selected thread)" + IDHelp,
	}
	item := func(name string, check panelCheck) func(context.Context, Context, Args) (Result, error) {
		return func(ctx context.Context, uctx Context, a Args) (Result, error) {
			id := a.String("thread")
			if id == "" {
				return Result{}, InvalidArg("thread", "needs a thread whose panel to open it in (--thread, or run it inside a thread)")
			}
			return showScoped(ctx, d.Thread, d.Emitter, uctx, a, id, name, check)
		}
	}
	return []Command{
		{
			Name:  "view.panel.file",
			Title: "Show File in Side Panel",
			Description: "Open a file in a File tab in a thread's side panel (from a thread: its own; in the app: the selected one): " +
				"text with syntax colours and an optional line marked, markdown rendered, images, PDFs, and HTML pages run interactively.",
			Category:     "View",
			NoKeybinding: true,
			// Any thread: a thread without a project reads files under home.
			When: hasThread,
			Args: []ArgSpec{
				{Name: "path", Type: Path, Required: true, Positional: true, Description: "File to show: absolute, ~/…, or relative to the current directory; under the home directory"},
				{Name: "line", Type: Int, Description: "1-based line to scroll to and mark"},
				thread, focus,
			},
			Run: item(ViewPanelFile, d.fileCheck),
		},
		{
			Name:  "view.panel.diff",
			Title: "Show Diff in Side Panel",
			Description: "Open a changed file's diff in a Diff tab in a thread's side panel (from a thread: its own; in the app: the selected one): " +
				"the file against the branch's base, side by side or unified.",
			Category:     "View",
			NoKeybinding: true,
			When:         func(c Context) bool { return hasWorktreeThreadContext(c) || cliThread(c) },
			Args: []ArgSpec{
				{Name: "path", Type: Path, Required: true, Positional: true, Description: "Changed file in the thread's worktree: absolute, or relative to the current directory"},
				{Name: "scope", Type: Enum, Enum: []string{"working", "branch"}, Default: "working",
					Description: "working: the base against the file on disk, uncommitted changes included; branch: against the last commit"},
				thread, focus,
			},
			Run: item(ViewPanelDiff, d.diffCheck),
		},
		{
			Name:  "view.panel.pr",
			Title: "Show Pull Request in Side Panel",
			Description: "Open a pull request in a thread's side panel (from a thread: its own; in the app: the selected one): " +
				"its summary, checks, reviews, timeline and changed files, with Merge and Review.",
			Category:     "View",
			NoKeybinding: true,
			When:         hasThread,
			Args: []ArgSpec{
				{Name: "number", Type: Int, Required: true, Positional: true,
					Description: "Pull request number: one the thread links, else one in its project's GitHub repository"},
				thread, focus,
			},
			Run: item(ViewPanelPR, d.prCheck),
		},
	}
}

// fileCheck is view.panel.file's check: the file exists (and is not a directory) where
// the File tab would read it, under the home directory (ReadFile refuses anything else,
// symlinks followed). The path is absolute: the CLI resolves a relative one against its
// own directory, a thread's worktree when the model runs it.
func (d ViewDeps) fileCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	line := a.Int("line")
	if line < 0 || (a.Given("line") && line == 0) {
		return nil, InvalidArg("line", "want a line number from 1, got %d", line)
	}
	base := t.GetWorktreePath()
	res, err := d.Files.ReadFile(ctx, connect.NewRequest(&v1.ReadFileRequest{BaseDir: base, Path: a.Path("path"), MaxBytes: 1}))
	if err != nil {
		return nil, err
	}
	path := res.Msg.GetResolvedPath()
	switch {
	case res.Msg.GetNotFound():
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no file at %s", path))
	case res.Msg.GetIsDir():
		return nil, InvalidArg("path", "%s is a directory, not a file", path)
	}
	params := map[string]string{"path": path, "project": t.GetProjectId(), "base": base}
	if line > 0 {
		params["line"] = strconv.Itoa(line)
	}
	return params, nil
}

// diffCheck is view.panel.diff's check: the thread runs in a project worktree, the path
// is in it, and the file has changes in the scope (a diff of nothing shows nothing).
func (d ViewDeps) diffCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	if _, err := inWorktree(ctx, t, a); err != nil {
		return nil, err
	}
	wt := t.GetWorktreePath()
	rel, err := filepath.Rel(wt, a.Path("path"))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return nil, InvalidArg("path", "%s is not a file in thread %s's worktree %s", a.Path("path"), t.GetId(), wt)
	}
	rel = filepath.ToSlash(rel)
	scope := a.String("scope")
	res, err := d.Diffs.GetWorktreeFileDiff(ctx, connect.NewRequest(&v1.GetWorktreeFileDiffRequest{
		ProjectId: t.GetProjectId(), Path: wt, File: rel, Scope: diffScopes[scope],
	}))
	if err != nil {
		return nil, err
	}
	if e := res.Msg.GetError(); e != "" {
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("cannot diff %s (%s): %s", rel, scope, e))
	}
	if res.Msg.GetStatus() == "" {
		against := res.Msg.GetBaseRef()
		if against == "" {
			against = "HEAD"
		}
		what := "the file on disk"
		if scope == "branch" {
			what = "the last commit"
		}
		return nil, connect.NewError(connect.CodeFailedPrecondition, fmt.Errorf("%s has no changes in thread %s's worktree (%s against %s)", rel, t.GetId(), against, what))
	}
	return map[string]string{"project": t.GetProjectId(), "worktree": wt, "path": rel, "scope": scope}, nil
}

// prCheck is view.panel.pr's check: the number names a pull request the thread links
// (in whichever repository), else one in the thread's project's GitHub repository, and
// the gh store can read it (from its cache, else GitHub).
func (d ViewDeps) prCheck(ctx context.Context, t *v1.Thread, a Args) (map[string]string, error) {
	n := a.Int("number")
	if n <= 0 {
		return nil, InvalidArg("number", "want a pull request number from 1, got %d", n)
	}
	var linked []string
	for _, l := range t.GetLinkedPullRequests() {
		if int(l.GetNumber()) == n && !slices.Contains(linked, strings.ToLower(l.GetSlug())) {
			linked = append(linked, strings.ToLower(l.GetSlug()))
		}
	}
	slug := ""
	switch len(linked) {
	case 0:
		s, err := d.projectSlug(ctx, t.GetProjectId())
		if err != nil {
			return nil, err
		}
		if s == "" {
			return nil, refuse(t, fmt.Sprintf("links no pull request #%d and its project has no GitHub repository", n))
		}
		slug = s
	case 1:
		slug = linked[0]
	default:
		return nil, InvalidArg("number", "thread %s links #%d in %d repositories (%s); open it from the Linked PRs tab", t.GetId(), n, len(linked), strings.Join(linked, ", "))
	}
	res, err := d.PullRequests.GetPullRequest(ctx, connect.NewRequest(&v1.GetPullRequestRequest{RepoSlug: slug, Number: int32(n)}))
	switch {
	case connect.CodeOf(err) == connect.CodeNotFound:
		return nil, connect.NewError(connect.CodeNotFound, fmt.Errorf("no pull request #%d in %s", n, slug))
	case err != nil:
		// The CLI prints a connect error's own message: name the pull request in it.
		var ce *connect.Error
		if errors.As(err, &ce) {
			return nil, connect.NewError(ce.Code(), fmt.Errorf("pull request %s#%d: %s", slug, n, ce.Message()))
		}
		return nil, fmt.Errorf("pull request %s#%d: %w", slug, n, err)
	}
	if s := res.Msg.GetPullRequest().GetRepoSlug(); s != "" {
		slug = s
	}
	return map[string]string{"slug": slug, "number": strconv.Itoa(n)}, nil
}

// projectSlug is a project's GitHub repository ("owner/name"), "" without one (or
// without a project).
func (d ViewDeps) projectSlug(ctx context.Context, id string) (string, error) {
	if id == "" {
		return "", nil
	}
	res, err := d.Projects.List(ctx, connect.NewRequest(&v1.ListProjectsRequest{}))
	if err != nil {
		return "", err
	}
	for _, p := range res.Msg.GetProjects() {
		if p.GetId() == id {
			return strings.ToLower(p.GetGithubSlug()), nil
		}
	}
	return "", nil
}
